// Menu shown while the desktop has focus, like Finder's on macOS: opens
// common folders in the file manager, Settings panels and the help.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {MenuNode, MenuSource, makeSeparator} from '../menuModel.js';
import {logError} from '../util.js';

const FILE_MANAGER_ID = 'org.gnome.Nautilus.desktop';
const SETTINGS_ID = 'org.gnome.Settings.desktop';
const EXTENSIONS_ID = 'org.gnome.Shell.Extensions.desktop';
const SETTINGS_COMMAND = 'gnome-control-center';

/** Settings panels listed in the Preferences menu, as [label, panel and subpage]. */
const SETTINGS_PANELS: [string, string[]][] = [
    ['Appearance', ['background']],
    ['Displays', ['display']],
    ['Keyboard', ['keyboard']],
    ['Mouse & Touchpad', ['mouse']],
    ['Sound', ['sound']],
    ['Network', ['network']],
    ['Power', ['power']],
];

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

/** Opens a URI in its default handler, such as a help: URI in the help viewer. */
function openUri(uri: string) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    } catch (e) {
        logError(e, `cannot open ${uri}`);
    }
}

function openSettings(args: string[]) {
    try {
        Gio.Subprocess.new([SETTINGS_COMMAND, ...args], Gio.SubprocessFlags.NONE);
    } catch (e) {
        logError(e, `cannot open Settings ${args.join(' ')}`);
    }
}

function lookupApp(id: string): Shell.App | null {
    return Shell.AppSystem.get_default().lookup_app(id) ?? null;
}

function makeItem(id: string, label: string, action: () => void): MenuNode {
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
        data: action,
    };
}

function makeSubmenu(id: string, label: string, children: MenuNode[]): MenuNode {
    return {
        ...makeItem(id, label, () => {}),
        hasSubmenu: true,
        children,
    };
}

function makeLocationItem(id: string, label: string, uri: string): MenuNode {
    return makeItem(id, label, () => openLocation(uri));
}

function buildGoMenu(): MenuNode {
    const home = GLib.get_home_dir();
    const children = [makeLocationItem('home', 'Home', Gio.File.new_for_path(home).get_uri())];

    for (const dir of SPECIAL_DIRS) {
        const path = GLib.get_user_special_dir(dir);
        // Unset XDG directories fall back to the home folder.
        if (path && path !== home)
            children.push(makeLocationItem(`dir-${dir}`, GLib.path_get_basename(path), Gio.File.new_for_path(path).get_uri()));
    }

    children.push(makeSeparator('sep-trash'));
    children.push(makeLocationItem('trash', 'Trash', 'trash:///'));
    children.push(makeLocationItem('other', 'Other Locations', 'other-locations:///'));

    return makeSubmenu('go', 'Go', children);
}

/** Null when Settings is not installed and there is nothing to list. */
function buildPreferencesMenu(): MenuNode | null {
    const settings = lookupApp(SETTINGS_ID);
    const extensions = lookupApp(EXTENSIONS_ID);
    const children: MenuNode[] = [];

    if (settings && GLib.find_program_in_path(SETTINGS_COMMAND)) {
        children.push(makeItem('settings', 'System Settings…', () => settings.activate()));
        children.push(makeSeparator('sep-panels'));
        for (const [label, args] of SETTINGS_PANELS)
            children.push(makeItem(`panel-${args.join('-')}`, label, () => openSettings(args)));
    }
    if (extensions) {
        if (children.length > 0)
            children.push(makeSeparator('sep-extensions'));
        children.push(makeItem('extensions', 'Extensions', () => extensions.activate()));
    }

    return children.length > 0 ? makeSubmenu('preferences', 'Preferences', children) : null;
}

function buildHelpMenu(): MenuNode {
    const children = [
        makeItem('help', 'GNOME Help', () => openUri('help:gnome-help')),
        makeItem('shortcuts', 'Keyboard Shortcuts', () => openUri('help:gnome-help/shell-keyboard-shortcuts')),
    ];
    if (GLib.find_program_in_path(SETTINGS_COMMAND)) {
        children.push(makeSeparator('sep-about'));
        children.push(makeItem('about', 'About This Computer', () => openSettings(['system', 'about'])));
    }
    return makeSubmenu('help-menu', 'Help', children);
}

export class DesktopMenuSource implements MenuSource {
    static readonly KEY = 'desktop';

    readonly key = DesktopMenuSource.KEY;
    onChanged: (() => void) | null = null;

    private _topLevel = [buildGoMenu(), buildPreferencesMenu(), buildHelpMenu()]
        .filter((node): node is MenuNode => node !== null);

    getTopLevel(): Promise<MenuNode[]> {
        return Promise.resolve(this._topLevel);
    }

    openSubmenu(node: MenuNode): Promise<MenuNode[]> {
        return Promise.resolve(node.children);
    }

    closeSubmenu(_node: MenuNode) {
    }

    activate(node: MenuNode) {
        (node.data as () => void)();
    }

    destroy() {
        this.onChanged = null;
    }
}
