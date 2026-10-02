// Reads the menu bar a GtkApplication exports over org.gtk.Menus. Mutter
// tells us where it lives (works natively on Wayland through gtk-shell).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {MenuNode, MenuSource, makeSeparator} from '../menuModel.js';
import {formatGtkAccel, stripMnemonic} from '../util.js';

const LOAD_TIMEOUT_MS = 500;

export interface GtkMenuPaths {
    busName: string;
    menubarPath: string;
    applicationPath: string | null;
    windowPath: string | null;
}

interface ItemData {
    action: string | null;
    target: GLib.Variant | null;
    submenu: Gio.MenuModel | null;
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

function stringAttribute(model: Gio.MenuModel, index: number, name: string): string | null {
    const value = model.get_item_attribute_value(index, name, new GLib.VariantType('s'));
    return value ? value.get_string()[0] : null;
}

export class GtkMenuSource implements MenuSource {
    readonly key: string;
    onChanged: (() => void) | null = null;

    private _menubar: Gio.MenuModel;
    private _changedId: number;
    private _actionGroups = new Map<string, Gio.DBusActionGroup>();

    static keyFor(paths: GtkMenuPaths) {
        return `gtk:${paths.busName}${paths.menubarPath}:${paths.windowPath}`;
    }

    constructor(paths: GtkMenuPaths) {
        const bus = Gio.DBus.session;
        this.key = GtkMenuSource.keyFor(paths);
        this._menubar = Gio.DBusMenuModel.get(bus, paths.busName, paths.menubarPath);
        this._changedId = this._menubar.connect('items-changed', () => this.onChanged?.());

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
        }
    }

    destroy() {
        this._menubar.disconnect(this._changedId);
        this._actionGroups.clear();
        this.onChanged = null;
    }

    getTopLevel(): Promise<MenuNode[]> {
        return this._walk(this._menubar, 'top', false);
    }

    openSubmenu(node: MenuNode): Promise<MenuNode[]> {
        const {submenu} = node.data as ItemData;
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

        const resolved = action ? this._resolveAction(action) : null;
        const known = resolved?.group.has_action(resolved.name) ?? false;
        const enabled = !action || !known || resolved!.group.get_action_enabled(resolved!.name);
        const state = known ? resolved!.group.get_action_state(resolved!.name) : null;

        if (hiddenWhen === 'action-missing' && action && !known)
            return null;
        if (hiddenWhen === 'action-disabled' && !enabled)
            return null;

        let toggle: MenuNode['toggle'] = 'none';
        let toggled = false;
        if (state && target) {
            toggle = 'radio';
            toggled = state.equal(target);
        } else if (state?.get_type_string() === 'b') {
            toggle = 'check';
            toggled = state.get_boolean();
        }

        const data: ItemData = {action, target, submenu};
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
