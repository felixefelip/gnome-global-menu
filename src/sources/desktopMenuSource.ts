// Menu shown while the desktop has focus, like Finder's on macOS: opens
// common folders in the file manager.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {MenuNode, MenuSource, makeSeparator} from '../menuModel.js';
import {logError} from '../util.js';

const FILE_MANAGER_ID = 'org.gnome.Nautilus.desktop';

const SPECIAL_DIRS = [
    GLib.UserDirectory.DIRECTORY_DESKTOP,
    GLib.UserDirectory.DIRECTORY_DOCUMENTS,
    GLib.UserDirectory.DIRECTORY_DOWNLOAD,
    GLib.UserDirectory.DIRECTORY_PICTURES,
    GLib.UserDirectory.DIRECTORY_MUSIC,
    GLib.UserDirectory.DIRECTORY_VIDEOS,
];

/** The app that owns the desktop, or null if no file manager is installed. */
export function fileManagerApp(): Shell.App | null {
    return Shell.AppSystem.get_default().lookup_app(FILE_MANAGER_ID) ?? null;
}

/** Opens a location in the file manager, or in the default handler for it. */
export function openLocation(uri: string) {
    const context = global.create_app_launch_context(0, -1);
    try {
        const appInfo = fileManagerApp()?.get_app_info();
        if (appInfo)
            appInfo.launch_uris([uri], context);
        else
            Gio.AppInfo.launch_default_for_uri(uri, context);
    } catch (e) {
        logError(e, `cannot open ${uri}`);
    }
}

function makeItem(id: string, label: string, uri: string): MenuNode {
    return {
        id,
        label,
        separator: false,
        enabled: true,
        visible: true,
        toggle: 'none',
        toggled: false,
        accel: null,
        hasSubmenu: false,
        children: [],
        data: uri,
    };
}

function buildGoMenu(): MenuNode {
    const home = GLib.get_home_dir();
    const children = [makeItem('home', 'Home', Gio.File.new_for_path(home).get_uri())];

    for (const dir of SPECIAL_DIRS) {
        const path = GLib.get_user_special_dir(dir);
        // Unset XDG directories fall back to the home folder.
        if (path && path !== home)
            children.push(makeItem(`dir-${dir}`, GLib.path_get_basename(path), Gio.File.new_for_path(path).get_uri()));
    }

    children.push(makeSeparator('sep-trash'));
    children.push(makeItem('trash', 'Trash', 'trash:///'));
    children.push(makeItem('other', 'Other Locations', 'other-locations:///'));

    return {
        ...makeItem('go', 'Go', ''),
        hasSubmenu: true,
        children,
    };
}

export class DesktopMenuSource implements MenuSource {
    static readonly KEY = 'desktop';

    readonly key = DesktopMenuSource.KEY;
    onChanged: (() => void) | null = null;

    private _topLevel = [buildGoMenu()];

    getTopLevel(): Promise<MenuNode[]> {
        return Promise.resolve(this._topLevel);
    }

    openSubmenu(node: MenuNode): Promise<MenuNode[]> {
        return Promise.resolve(node.children);
    }

    closeSubmenu(_node: MenuNode) {
    }

    activate(node: MenuNode) {
        if (typeof node.data === 'string' && node.data)
            openLocation(node.data);
    }

    destroy() {
        this.onChanged = null;
    }
}
