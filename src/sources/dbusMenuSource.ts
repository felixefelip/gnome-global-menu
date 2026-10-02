// Client for com.canonical.dbusmenu, exported by Qt, Electron, Chromium,
// Firefox and appmenu-gtk-module.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {MenuNode, MenuSource} from '../menuModel.js';
import {dbusCall, formatAccel, logError, stripMnemonic} from '../util.js';

const IFACE = 'com.canonical.dbusmenu';
const ROOT_ID = 0;

interface RawItem {
    id: number;
    props: Record<string, GLib.Variant>;
    children: RawItem[];
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

function toNode(item: RawItem): MenuNode {
    const toggleType = prop<string>(item, 'toggle-type', '');
    const shortcut = prop<string[][]>(item, 'shortcut', []);

    return {
        id: String(item.id),
        label: stripMnemonic(prop<string>(item, 'label', '')),
        separator: prop<string>(item, 'type', 'standard') === 'separator',
        enabled: prop<boolean>(item, 'enabled', true),
        visible: prop<boolean>(item, 'visible', true),
        toggle: toggleType === 'checkmark' ? 'check' : toggleType === 'radio' ? 'radio' : 'none',
        toggled: prop<number>(item, 'toggle-state', 0) === 1,
        accel: shortcut.length > 0 ? formatAccel(shortcut[0]) : null,
        hasSubmenu: prop<string>(item, 'children-display', '') === 'submenu' || item.children.length > 0,
        children: item.children.map(toNode),
        data: item.id,
    };
}

export class DBusMenuSource implements MenuSource {
    readonly key: string;
    onChanged: (() => void) | null = null;

    private _bus = Gio.DBus.session;
    private _signalId: number;

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
        this.onChanged = null;
    }

    async getTopLevel(): Promise<MenuNode[]> {
        await this._aboutToShow(ROOT_ID);
        return (await this._getLayout(ROOT_ID)).children.map(toNode);
    }

    async openSubmenu(node: MenuNode): Promise<MenuNode[]> {
        const id = node.data as number;
        this._event(id, 'opened');
        await this._aboutToShow(id);
        return (await this._getLayout(id)).children.map(toNode);
    }

    closeSubmenu(node: MenuNode) {
        this._event(node.data as number, 'closed');
    }

    activate(node: MenuNode) {
        this._event(node.data as number, 'clicked');
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
        const params = new GLib.Variant('(isvu)',
            [id, eventId, new GLib.Variant('i', 0), global.get_current_time()]);
        this._call('Event', params, null).catch(e => logError(e, `Event ${eventId}`));
    }
}
