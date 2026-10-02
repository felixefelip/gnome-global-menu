// Client for com.canonical.dbusmenu, exported by Qt, Electron, Chromium,
// Firefox and appmenu-gtk-module.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {MenuNode, MenuSource} from '../menuModel.js';
import {dbusCall, formatAccel, logError, stripMnemonic} from '../util.js';

const IFACE = 'com.canonical.dbusmenu';
const ROOT_ID = 0;
// Electron apps (VS Code) ignore menu actions while none of their windows has
// keyboard focus, which the Shell holds while its menu is open. The click is
// sent this long after the menu closes, once the window has focus again.
const CLICK_DELAY_MS = 100;

interface RawItem {
    id: number;
    props: Record<string, GLib.Variant>;
    children: RawItem[];
}

interface ItemRef {
    id: number;
    /** Labels from the top-level menu down to the item. */
    path: string[];
}

function parseItem(variant: GLib.Variant): RawItem {
    if (variant.get_type_string() === 'v')
        variant = variant.get_variant();

    const childrenVariant = variant.get_child_value(2);
    const children: RawItem[] = [];
    for (let i = 0; i < childrenVariant.n_children(); i++)
        children.push(parseItem(childrenVariant.get_child_value(i)));

    return {
        id: variant.get_child_value(0).get_int32(),
        props: variant.get_child_value(1).deepUnpack() as Record<string, GLib.Variant>,
        children,
    };
}

function prop<T>(item: RawItem, name: string, fallback: T): T {
    const value = item.props[name];
    return value ? value.recursiveUnpack() as T : fallback;
}

function labelOf(item: RawItem): string {
    return stripMnemonic(prop<string>(item, 'label', ''));
}

function toNode(item: RawItem, parentPath: string[]): MenuNode {
    const label = labelOf(item);
    const path = [...parentPath, label];
    const toggleType = prop<string>(item, 'toggle-type', '');
    const shortcut = prop<string[][]>(item, 'shortcut', []);

    return {
        id: String(item.id),
        label,
        separator: prop<string>(item, 'type', 'standard') === 'separator',
        enabled: prop<boolean>(item, 'enabled', true),
        visible: prop<boolean>(item, 'visible', true),
        toggle: toggleType === 'checkmark' ? 'check' : toggleType === 'radio' ? 'radio' : 'none',
        toggled: prop<number>(item, 'toggle-state', 0) === 1,
        accel: shortcut.length > 0 ? formatAccel(shortcut[0]) : null,
        hasSubmenu: prop<string>(item, 'children-display', '') === 'submenu' || item.children.length > 0,
        children: item.children.map(child => toNode(child, path)),
        data: {id: item.id, path} satisfies ItemRef,
    };
}

export class DBusMenuSource implements MenuSource {
    readonly key: string;
    onChanged: (() => void) | null = null;

    private _bus = Gio.DBus.session;
    private _signalId: number;
    private _clickTimeoutId = 0;

    static keyFor(name: string, path: string) {
        return `dbusmenu:${name}${path}`;
    }

    constructor(private _name: string, private _path: string) {
        this.key = DBusMenuSource.keyFor(_name, _path);
        this._signalId = this._bus.signal_subscribe(
            _name, IFACE, 'LayoutUpdated', _path, null, Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [, parent] = params!.deepUnpack() as [number, number];
                if (parent === ROOT_ID)
                    this.onChanged?.();
            });
    }

    destroy() {
        this._bus.signal_unsubscribe(this._signalId);
        if (this._clickTimeoutId)
            GLib.source_remove(this._clickTimeoutId);
        this.onChanged = null;
    }

    async getTopLevel(): Promise<MenuNode[]> {
        await this._aboutToShow(ROOT_ID);
        return (await this._getLayout(ROOT_ID)).children.map(child => toNode(child, []));
    }

    async openSubmenu(node: MenuNode): Promise<MenuNode[]> {
        const {id, path} = node.data as ItemRef;
        this._event(id, 'opened');
        await this._aboutToShow(id);
        return (await this._getLayout(id)).children.map(child => toNode(child, path));
    }

    closeSubmenu(node: MenuNode) {
        this._event((node.data as ItemRef).id, 'closed');
    }

    activate(node: MenuNode) {
        const ref = node.data as ItemRef;
        const timestamp = global.get_current_time();
        if (this._clickTimeoutId)
            GLib.source_remove(this._clickTimeoutId);
        this._clickTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLICK_DELAY_MS, () => {
            this._clickTimeoutId = 0;
            this._click(ref, timestamp).catch(e => logError(e, `cannot activate ${ref.path.join(' > ')}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    private async _click(ref: ItemRef, timestamp: number) {
        try {
            await this._sendEvent(ref.id, 'clicked', timestamp);
            return;
        } catch {
            // Electron rebuilds its whole menu, with new ids, whenever the
            // window gets focus back; find the item again by its labels.
        }
        const id = await this._findItem(ref.path);
        if (id === null)
            throw new Error('the item is no longer in the menu');
        await this._sendEvent(id, 'clicked', timestamp);
    }

    private async _findItem(path: string[]): Promise<number | null> {
        let id = ROOT_ID;
        for (const label of path) {
            await this._aboutToShow(id);
            const child = (await this._getLayout(id)).children.find(item => labelOf(item) === label);
            if (!child)
                return null;
            id = child.id;
        }
        return id;
    }

    private _call(method: string, params: GLib.Variant, replyType: string | null) {
        return dbusCall(this._bus, this._name, this._path, IFACE, method, params, replyType);
    }

    private async _getLayout(id: number): Promise<RawItem> {
        const reply = await this._call('GetLayout',
            new GLib.Variant('(iias)', [id, -1, []]), '(u(ia{sv}av))');
        return parseItem(reply.get_child_value(1));
    }

    private async _aboutToShow(id: number) {
        // AboutToShow is optional in the spec; some apps don't implement it.
        try {
            await this._call('AboutToShow', new GLib.Variant('(i)', [id]), '(b)');
        } catch {
        }
    }

    private _event(id: number, eventId: string) {
        this._sendEvent(id, eventId, global.get_current_time())
            .catch(e => logError(e, `Event ${eventId}`));
    }

    private _sendEvent(id: number, eventId: string, timestamp: number) {
        const params = new GLib.Variant('(isvu)', [id, eventId, new GLib.Variant('i', 0), timestamp]);
        return this._call('Event', params, null);
    }
}
