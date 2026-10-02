// Implements com.canonical.AppMenu.Registrar, the service Qt, Electron,
// Chromium, Firefox, LibreOffice and appmenu-gtk-module look for before
// exporting their menu bar over DBusMenu.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {dbusCall, log, logError} from './util.js';

const BUS_NAME = 'com.canonical.AppMenu.Registrar';
const OBJECT_PATH = '/com/canonical/AppMenu/Registrar';

const IFACE_XML = `
<node>
  <interface name="com.canonical.AppMenu.Registrar">
    <method name="RegisterWindow">
      <arg type="u" name="windowId" direction="in"/>
      <arg type="o" name="menuObjectPath" direction="in"/>
    </method>
    <method name="UnregisterWindow">
      <arg type="u" name="windowId" direction="in"/>
    </method>
    <method name="GetMenuForWindow">
      <arg type="u" name="windowId" direction="in"/>
      <arg type="s" name="service" direction="out"/>
      <arg type="o" name="menuObjectPath" direction="out"/>
    </method>
    <method name="GetMenus">
      <arg type="a(uso)" name="menus" direction="out"/>
    </method>
    <signal name="WindowRegistered">
      <arg type="u" name="windowId"/>
      <arg type="s" name="service"/>
      <arg type="o" name="menuObjectPath"/>
    </signal>
    <signal name="WindowUnregistered">
      <arg type="u" name="windowId"/>
    </signal>
  </interface>
</node>`;

export interface Registration {
    windowId: number;
    sender: string;
    path: string;
    /** PID of the D-Bus sender, used when the window id cannot be matched (Wayland). */
    pid: number | null;
    serial: number;
}

/** X11 window id of an XWayland window; Mutter describes them as "0x1a00007". */
export function xidOf(window: Meta.Window): number | null {
    if (window.get_client_type() !== Meta.WindowClientType.X11)
        return null;
    const match = /^0x([0-9a-f]+)/i.exec(window.get_description() ?? '');
    return match ? parseInt(match[1], 16) : null;
}

export class Registrar {
    onChanged: (() => void) | null = null;

    private _registrations = new Map<number, Registration>();
    private _senderWatches = new Map<string, number>();
    private _serial = 0;
    private _exported: Gio.DBusExportedObject;
    private _ownerId: number;

    constructor() {
        this._exported = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, this);
        this._exported.export(Gio.DBus.session, OBJECT_PATH);
        this._ownerId = Gio.bus_own_name_on_connection(
            Gio.DBus.session, BUS_NAME,
            Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT | Gio.BusNameOwnerFlags.REPLACE,
            null,
            () => log(`lost ownership of ${BUS_NAME}`));
    }

    destroy() {
        Gio.bus_unown_name(this._ownerId);
        this._exported.unexport();
        for (const watchId of this._senderWatches.values())
            Gio.bus_unwatch_name(watchId);
        this._senderWatches.clear();
        this._registrations.clear();
        this.onChanged = null;
    }

    /** Finds the menu registered for a window, by X11 id first and then by PID. */
    lookup(window: Meta.Window): Registration | null {
        const xid = xidOf(window);
        if (xid !== null) {
            const registration = this._registrations.get(xid);
            if (registration)
                return registration;
        }

        const pid = window.get_pid();
        if (pid <= 0)
            return null;

        let best: Registration | null = null;
        for (const registration of this._registrations.values()) {
            if (registration.pid === pid && (!best || registration.serial > best.serial))
                best = registration;
        }
        return best;
    }

    // D-Bus methods

    RegisterWindowAsync(params: [number, string], invocation: Gio.DBusMethodInvocation) {
        const [windowId, path] = params;
        const sender = invocation.get_sender()!;
        invocation.return_value(null);
        this._register(windowId, sender, path).catch(e => logError(e, 'RegisterWindow'));
    }

    UnregisterWindow(windowId: number) {
        if (this._registrations.delete(windowId)) {
            this._exported.emit_signal('WindowUnregistered', new GLib.Variant('(u)', [windowId]));
            this.onChanged?.();
        }
    }

    GetMenuForWindow(windowId: number): [string, string] {
        const registration = this._registrations.get(windowId);
        return registration ? [registration.sender, registration.path] : ['', '/'];
    }

    GetMenus(): [number, string, string][] {
        return [...this._registrations.values()]
            .map(r => [r.windowId, r.sender, r.path] as [number, string, string]);
    }

    private async _register(windowId: number, sender: string, path: string) {
        let pid: number | null = null;
        try {
            const reply = await dbusCall(Gio.DBus.session,
                'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                'GetConnectionUnixProcessID', new GLib.Variant('(s)', [sender]), '(u)');
            [pid] = reply.deepUnpack() as [number];
        } catch (e) {
            logError(e, `cannot get PID of ${sender}`);
        }

        log(`window 0x${windowId.toString(16)} registered menu ${sender}${path} (pid ${pid})`);
        this._registrations.set(windowId, {windowId, sender, path, pid, serial: ++this._serial});
        this._watchSender(sender);
        this._exported.emit_signal('WindowRegistered',
            new GLib.Variant('(uso)', [windowId, sender, path]));
        this.onChanged?.();
    }

    private _watchSender(sender: string) {
        if (this._senderWatches.has(sender))
            return;

        const watchId = Gio.bus_watch_name_on_connection(
            Gio.DBus.session, sender, Gio.BusNameWatcherFlags.NONE,
            null,
            () => this._dropSender(sender));
        this._senderWatches.set(sender, watchId);
    }

    private _dropSender(sender: string) {
        const watchId = this._senderWatches.get(sender);
        if (watchId !== undefined)
            Gio.bus_unwatch_name(watchId);
        this._senderWatches.delete(sender);

        for (const [windowId, registration] of this._registrations) {
            if (registration.sender === sender)
                this.UnregisterWindow(windowId);
        }
    }
}
