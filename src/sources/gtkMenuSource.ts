// Reads the menu bar a GtkApplication exports over org.gtk.Menus. Mutter
// tells us where it lives (works natively on Wayland through gtk-shell).
// GTK4 apps usually export no menu bar, only the actions behind their
// hamburger menu; then the menus are built from those actions instead.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {MenuNode, MenuSource, makeSeparator} from '../menuModel.js';
import {dbusCall, formatGtkAccel, logError, stripMnemonic} from '../util.js';
import {ActionMenuLayout, actionMenuLayouts, resolveLayout} from './gtkActionMenus.js';

const LOAD_TIMEOUT_MS = 500;
const POLL_INTERVAL_MS = 20;

export interface GtkMenuPaths {
    busName: string;
    /** Null when the app sent Mutter no menu bar path at all. */
    menubarPath: string | null;
    applicationPath: string | null;
    windowPath: string | null;
}

interface ItemData {
    action: string | null;
    target: GLib.Variant | null;
    submenu: Gio.MenuModel | null;
    /** Set on the menus built from actions. */
    layout: ActionMenuLayout | null;
}

/** Gio.DBusMenuModel fetches its items lazily: wait until they arrive. */
function waitForItems(model: Gio.MenuModel): Promise<void> {
    if (model.get_n_items() > 0)
        return Promise.resolve();

    return new Promise(resolve => {
        let timeoutId = 0;
        const signalId = model.connect('items-changed', () => {
            GLib.source_remove(timeoutId);
            model.disconnect(signalId);
            resolve();
        });
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LOAD_TIMEOUT_MS, () => {
            model.disconnect(signalId);
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

/** Gio.DBusActionGroup fetches its actions lazily and does not say when it is done. */
function waitForActions(groups: Gio.DBusActionGroup[]): Promise<void> {
    const loaded = () => groups.every(group => group.list_actions().length > 0);
    if (loaded())
        return Promise.resolve();

    return new Promise(resolve => {
        let waited = 0;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_MS, () => {
            waited += POLL_INTERVAL_MS;
            if (!loaded() && waited < LOAD_TIMEOUT_MS)
                return GLib.SOURCE_CONTINUE;
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

/** GTK sends the menu bar path to Mutter even when it exports no menu bar there. */
async function isMenuExported(bus: Gio.DBusConnection, busName: string, path: string): Promise<boolean> {
    try {
        const reply = await dbusCall(bus, busName, path,
            'org.freedesktop.DBus.Introspectable', 'Introspect', null, '(s)');
        const [xml] = reply.deepUnpack() as [string];
        return xml.includes('org.gtk.Menus');
    } catch (e) {
        logError(e, `cannot introspect ${busName}${path}`);
        return false;
    }
}

function stringAttribute(model: Gio.MenuModel, index: number, name: string): string | null {
    const value = model.get_item_attribute_value(index, name, new GLib.VariantType('s'));
    return value ? value.get_string()[0] : null;
}

export class GtkMenuSource implements MenuSource {
    readonly key: string;
    onChanged: (() => void) | null = null;

    private _menubar: Gio.MenuModel | null = null;
    private _changedId = 0;
    private _actionGroups = new Map<string, Gio.DBusActionGroup>();
    private _actionSignals: [Gio.DBusActionGroup, number][] = [];
    private _menubarExported: Promise<boolean>;
    private _appName: string;
    private _fromActions = false;
    private _changedIdleId = 0;

    static keyFor(paths: GtkMenuPaths) {
        return `gtk:${paths.busName}${paths.menubarPath}:${paths.windowPath}`;
    }

    constructor(paths: GtkMenuPaths, appName: string) {
        const bus = Gio.DBus.session;
        this.key = GtkMenuSource.keyFor(paths);
        this._appName = appName;
        this._menubarExported = paths.menubarPath
            ? isMenuExported(bus, paths.busName, paths.menubarPath)
            : Promise.resolve(false);
        if (paths.menubarPath) {
            this._menubar = Gio.DBusMenuModel.get(bus, paths.busName, paths.menubarPath);
            this._changedId = this._menubar.connect('items-changed', () => this.onChanged?.());
        }

        const groupPaths: [string, string | null][] = [
            ['app', paths.applicationPath],
            ['win', paths.windowPath],
        ];
        for (const [prefix, path] of groupPaths) {
            if (!path)
                continue;
            const group = Gio.DBusActionGroup.get(bus, paths.busName, path);
            group.list_actions(); // starts fetching the action states
            this._actionGroups.set(prefix, group);
            for (const signal of ['action-added', 'action-removed'])
                this._actionSignals.push([group, group.connect(signal, () => this._actionsChanged())]);
        }
    }

    destroy() {
        this._menubar?.disconnect(this._changedId);
        for (const [group, id] of this._actionSignals)
            group.disconnect(id);
        this._actionSignals = [];
        if (this._changedIdleId)
            GLib.source_remove(this._changedIdleId);
        this._changedIdleId = 0;
        this._actionGroups.clear();
        this.onChanged = null;
    }

    async getTopLevel(): Promise<MenuNode[]> {
        const [exported] = await Promise.all([
            this._menubarExported,
            waitForActions([...this._actionGroups.values()]),
        ]);
        const nodes = exported && this._menubar ? await this._walk(this._menubar, 'top', false) : [];
        this._fromActions = nodes.length === 0;
        if (!this._fromActions)
            return nodes;

        return actionMenuLayouts(this._appName)
            .filter(layout => layout.label !== null)
            .map(layout => this._layoutMenu(layout))
            .filter(node => node.children.length > 0);
    }

    /** Items for the app-name menu, such as About and Preferences. */
    getAppItems(): MenuNode[] {
        if (!this._fromActions)
            return [];
        const layout = actionMenuLayouts(this._appName).find(l => l.label === null)!;
        return this._layoutChildren(layout);
    }

    openSubmenu(node: MenuNode): Promise<MenuNode[]> {
        const {submenu, layout} = node.data as ItemData;
        if (layout)
            return Promise.resolve(this._layoutChildren(layout));
        return submenu ? this._walk(submenu, node.id, true) : Promise.resolve([]);
    }

    closeSubmenu(_node: MenuNode) {
    }

    activate(node: MenuNode) {
        const {action, target} = node.data as ItemData;
        const resolved = action ? this._resolveAction(action) : null;
        resolved?.group.activate_action(resolved.name, target);
    }

    private _resolveAction(action: string) {
        const dot = action.indexOf('.');
        const group = this._actionGroups.get(action.slice(0, dot));
        return group ? {group, name: action.slice(dot + 1)} : null;
    }

    /** The action-built menus change only when actions come or go. */
    private _actionsChanged() {
        if (!this._fromActions || this._changedIdleId)
            return;
        this._changedIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._changedIdleId = 0;
            this.onChanged?.();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Actions that take a parameter cannot be activated from a plain menu item. */
    private _isUsable(action: string): boolean {
        const resolved = this._resolveAction(action);
        return resolved !== null && resolved.group.has_action(resolved.name) &&
            resolved.group.get_action_parameter_type(resolved.name) === null;
    }

    private _layoutMenu(layout: ActionMenuLayout): MenuNode {
        const children = this._layoutChildren(layout);
        return {
            id: `actions/${layout.id}`,
            label: layout.label ?? '',
            separator: false,
            enabled: true,
            visible: true,
            toggle: 'none',
            toggled: false,
            accel: null,
            hasSubmenu: true,
            children,
            data: {action: null, target: null, submenu: null, layout} satisfies ItemData,
        };
    }

    private _layoutChildren(layout: ActionMenuLayout): MenuNode[] {
        const resolved = resolveLayout(layout.entries, action => this._isUsable(action));
        return resolved.map((item, index) => {
            const id = `actions/${layout.id}/${index}`;
            if (!item)
                return makeSeparator(id);

            const {enabled, toggle, toggled} = this._actionState(item.action, null);
            return {
                id,
                label: item.label,
                separator: false,
                enabled,
                visible: true,
                toggle,
                toggled,
                accel: null,
                hasSubmenu: false,
                children: [],
                data: {action: item.action, target: null, submenu: null, layout: null} satisfies ItemData,
            };
        });
    }

    private _actionState(action: string | null, target: GLib.Variant | null) {
        const resolved = action ? this._resolveAction(action) : null;
        const known = resolved?.group.has_action(resolved.name) ?? false;
        const enabled = !action || !known || resolved!.group.get_action_enabled(resolved!.name);
        const state = known ? resolved!.group.get_action_state(resolved!.name) : null;

        let toggle: MenuNode['toggle'] = 'none';
        let toggled = false;
        if (state && target) {
            toggle = 'radio';
            toggled = state.equal(target);
        } else if (state?.get_type_string() === 'b') {
            toggle = 'check';
            toggled = state.get_boolean();
        }
        return {known, enabled, toggle, toggled};
    }

    /** Converts a GMenuModel into nodes, turning sections into separators. */
    private async _walk(model: Gio.MenuModel, idPrefix: string, separators: boolean): Promise<MenuNode[]> {
        await waitForItems(model);

        const groups: MenuNode[][] = [[]];
        for (let i = 0; i < model.get_n_items(); i++) {
            const id = `${idPrefix}/${i}`;
            const section = model.get_item_link(i, Gio.MENU_LINK_SECTION);
            if (section) {
                groups.push(await this._walk(section, id, separators), []);
                continue;
            }

            const node = await this._itemToNode(model, i, id);
            if (node)
                groups.at(-1)!.push(node);
        }

        const nonEmpty = groups.filter(group => group.length > 0);
        if (!separators)
            return nonEmpty.flat();
        return nonEmpty.flatMap((group, index) =>
            index === 0 ? group : [makeSeparator(`${idPrefix}/sep${index}`), ...group]);
    }

    private async _itemToNode(model: Gio.MenuModel, index: number, id: string): Promise<MenuNode | null> {
        const action = stringAttribute(model, index, Gio.MENU_ATTRIBUTE_ACTION);
        const target = model.get_item_attribute_value(index, Gio.MENU_ATTRIBUTE_TARGET, null);
        const hiddenWhen = stringAttribute(model, index, 'hidden-when');
        const accel = stringAttribute(model, index, 'accel');
        const submenu = model.get_item_link(index, Gio.MENU_LINK_SUBMENU);

        const {known, enabled, toggle, toggled} = this._actionState(action, target);

        if (hiddenWhen === 'action-missing' && action && !known)
            return null;
        if (hiddenWhen === 'action-disabled' && !enabled)
            return null;

        const data: ItemData = {action, target, submenu, layout: null};
        return {
            id,
            label: stripMnemonic(stringAttribute(model, index, Gio.MENU_ATTRIBUTE_LABEL) ?? ''),
            separator: false,
            enabled,
            visible: true,
            toggle,
            toggled,
            accel: accel ? formatGtkAccel(accel) : null,
            hasSubmenu: submenu !== null,
            children: submenu ? await this._walk(submenu, id, true) : [],
            data,
        };
    }
}
