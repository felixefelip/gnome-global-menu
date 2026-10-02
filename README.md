# GNOME Global Menu

macOS-style global menu for GNOME Shell 50 (Wayland). Shows the menu bar of
the focused window on the left side of the top panel.

## How it works

- `src/registrar.ts`: implements `com.canonical.AppMenu.Registrar`, where Qt,
  Electron, Chromium, Firefox and LibreOffice register their menus (DBusMenu).
  The window is matched by its X11 id (XWayland) or, as a last resort, by PID.
- `src/sources/gtkMenuSource.ts`: reads GTK menus (`org.gtk.Menus`) using the
  paths Mutter exposes for each window. GTK4/libadwaita apps don't export
  their hamburger menu, only its actions (`org.gtk.Actions`); for them the
  menus are built from those actions.
- `src/sources/gtkActionMenus.ts`: action names common in GNOME apps
  (`app.about`, `win.undo`, …) and the menu and label for each one.
- `src/sources/dbusMenuSource.ts`: client for the `com.canonical.dbusmenu`
  protocol.
- `src/sources/desktopMenuSource.ts`: menu shown when the desktop has focus
  (like Finder on macOS): the Files app and the Go (folders), Preferences
  (Settings panels) and Help menus.
- `src/menuBar.ts`: draws the menus in the panel.
- `src/extension.ts`: follows the focused window and picks the menu source.

## Development

```sh
npm install
npm run check        # type check
npm run build        # builds into build/
npm run install-ext  # copies to ~/.local/share/gnome-shell/extensions
```

### Testing in a nested session (recommended)

Requires the `mutter-dev-bin` package (`sudo apt install mutter-dev-bin`).

```sh
npm run install-ext
npm run nested   # opens GNOME in a window with the extension enabled
```

Open apps from inside the nested window (through its Activities). Apps
opened outside it stay in your regular session.

Apps must be opened **after** the extension is enabled, because they only
look for the Registrar on startup.

Logs: in the nested session they show up in the terminal that ran
`npm run nested`; in the regular session, use
`journalctl -f -o cat /usr/bin/gnome-shell | grep global-menu`.

### Chrome and VS Code on native Wayland

On Wayland, Chromium and Electron only export their menu if the compositor
has the `org_kde_kwin_appmenu` protocol, which Mutter doesn't implement. The
[felixefelip/mutter](https://github.com/felixefelip/mutter) fork implements
this protocol and exposes the menu's address on `Meta.Window`
(`dbus-appmenu-service-name` and `dbus-appmenu-object-path`). Without the
fork, the extension works as before.

- `kde-appmenu`: the patch on top of GNOME's official Mutter.
- `kde-appmenu-ubuntu`: the same patch on top of Ubuntu's Mutter, which is
  what runs with the installed gnome-shell.
- `kde-appmenu-ubuntu-deb`: Ubuntu packaging with the patch, to build `.deb`
  packages with `dpkg-buildpackage -b -us -uc`.

How each app uses the protocol:

- Chrome: sends the address through the protocol, window by window.
- VS Code/Electron: only checks that the protocol exists and then registers
  the menu with the Registrar using an id that isn't an X11 one. The window
  is found by PID, so with several windows open the wrong window's menu may
  show up.

To test in the nested session without installing the fork (the fork's
version must match the installed Mutter):

```sh
git clone -b kde-appmenu-ubuntu https://github.com/felixefelip/mutter ~/workspaces/mutter
sudo apt build-dep ~/workspaces/mutter
cd ~/workspaces/mutter && meson setup build --prefix=/usr \
    --libdir=lib/x86_64-linux-gnu -Dtests=disabled && ninja -C build
cd - && MUTTER_BUILD=~/workspaces/mutter/build npm run nested -- \
    google-chrome --ozone-platform=wayland
```

The command after `--` is started inside the nested session.

### Firefox

In `about:config`, enable `widget.gtk.global-menu.enabled` and, on native
Wayland, also `widget.gtk.global-menu.wayland.enabled`. With the second one,
Firefox sends its menu's address over `org_kde_kwin_appmenu`, like Chrome, so
it needs the Mutter fork described above. Without the fork, use the XWayland
path instead: start it with `MOZ_ENABLE_WAYLAND=0 firefox` (only the first
pref is needed then).
