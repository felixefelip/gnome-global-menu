import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {MenuBar} from './menuBar.js';
import {MenuSource} from './menuModel.js';
import {Registrar} from './registrar.js';
import {log} from './util.js';
import {DBusMenuSource} from './sources/dbusMenuSource.js';
import {DesktopMenuSource, fileManagerApp} from './sources/desktopMenuSource.js';
import {GtkMenuSource} from './sources/gtkMenuSource.js';

/**
 * Address of the window's DBusMenu menu, which Chromium sends over the
 * org_kde_kwin_appmenu Wayland protocol. Only a patched Mutter exposes it.
 */
function dbusAppmenuOf(window: Meta.Window): {sender: string, path: string} | null {
    const w = window as Meta.Window & {
        get_dbus_appmenu_service_name?: () => string | null,
        get_dbus_appmenu_object_path?: () => string | null,
    };
    const sender = w.get_dbus_appmenu_service_name?.();
    const path = w.get_dbus_appmenu_object_path?.();
    return sender && path ? {sender, path} : null;
}

/** Follows the focused window and shows its menu in the panel. */
export default class GlobalMenuExtension extends Extension {
    private _registrar: Registrar | null = null;
    private _menuBar: MenuBar | null = null;
    private _focusId = 0;
    private _overviewId = 0;
    private _workspaceId = 0;
    private _idleId = 0;
    private _window: Meta.Window | null = null;
    private _windowSignalIds: number[] = [];

    override enable() {
        this._registrar = new Registrar();
        this._registrar.onChanged = () => this._queueUpdate();
        this._menuBar = new MenuBar();

        this._focusId = global.display.connect('notify::focus-window', () => this._queueUpdate());
        // Focus may stay empty when these end, so check again whether the desktop is left.
        this._overviewId = Main.overview.connect('hidden', () => this._queueUpdate());
        this._workspaceId = global.workspace_manager.connect('active-workspace-changed', () => this._queueUpdate());
        this._queueUpdate();
    }

    override disable() {
        global.display.disconnect(this._focusId);
        this._focusId = 0;
        Main.overview.disconnect(this._overviewId);
        this._overviewId = 0;
        global.workspace_manager.disconnect(this._workspaceId);
        this._workspaceId = 0;
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
        this._trackWindow(null);

        this._menuBar?.destroy();
        this._menuBar = null;
        this._registrar?.destroy();
        this._registrar = null;
    }

    private _queueUpdate() {
        if (this._idleId)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleId = 0;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** GTK and Chromium apps may export their menu after the window gets focus. */
    private _trackWindow(window: Meta.Window | null) {
        if (window === this._window)
            return;
        for (const id of this._windowSignalIds)
            this._window?.disconnect(id);
        this._windowSignalIds = [];
        this._window = window;
        if (window) {
            this._windowSignalIds = [
                window.connect('notify::gtk-menubar-object-path', () => this._queueUpdate()),
                window.connect('notify::dbus-appmenu-object-path', () => {
                    const appmenu = dbusAppmenuOf(window);
                    log(`window "${window.get_title()}" announced menu ${appmenu?.sender}${appmenu?.path}`);
                    this._queueUpdate();
                }),
                window.connect('unmanaged', () => this._trackWindow(null)),
            ];
        }
    }

    private _update() {
        const window = global.display.focus_window;
        if (window?.get_window_type() === Meta.WindowType.DESKTOP) {
            this._showDesktop();
            return;
        }
        if (!window) {
            // The shell itself takes focus while a menu or the overview is open;
            // keep the last menu then. Otherwise nothing has focus but the desktop.
            if (Main.modalCount === 0 && !Main.overview.visible)
                this._showDesktop();
            return;
        }

        this._trackWindow(window);
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        const focused = {
            name: app?.get_name() ?? window.get_wm_class() ?? window.get_title() ?? '',
            app,
            window,
        };

        const found = this._findSource(window, focused.name);
        const current = this._menuBar!.source;
        if (found && current && found.key === current.key) {
            if (this._menuBar!.window !== window)
                this._menuBar!.show(focused, current);
        } else {
            this._menuBar!.show(focused, found?.create() ?? null);
        }
    }

    /** Shows the file manager's menu, as macOS does with Finder. */
    private _showDesktop() {
        this._trackWindow(null);
        const menuBar = this._menuBar!;
        if (menuBar.source?.key === DesktopMenuSource.KEY && !menuBar.window)
            return;

        const app = fileManagerApp();
        menuBar.show({name: app?.get_name() ?? 'Desktop', app, window: null}, new DesktopMenuSource());
    }

    /** Looks for a menu on the window itself, then on the windows it is transient for. */
    private _findSource(window: Meta.Window, appName: string): {key: string, create: () => MenuSource} | null {
        for (let w: Meta.Window | null = window; w; w = w.get_transient_for()) {
            const busName = w.get_gtk_unique_bus_name();
            const menubarPath = w.get_gtk_menubar_object_path();
            const applicationPath = w.get_gtk_application_object_path();
            // Without a menu bar, the menus are built from the app's actions.
            if (busName && (menubarPath || applicationPath)) {
                const paths = {
                    busName,
                    menubarPath,
                    applicationPath,
                    windowPath: w.get_gtk_window_object_path(),
                };
                return {key: GtkMenuSource.keyFor(paths), create: () => new GtkMenuSource(paths, appName)};
            }

            const registration = dbusAppmenuOf(w) ?? this._registrar!.lookup(w);
            if (registration) {
                const {sender, path} = registration;
                return {
                    key: DBusMenuSource.keyFor(sender, path),
                    create: () => new DBusMenuSource(sender, path),
                };
            }
        }
        return null;
    }
}
