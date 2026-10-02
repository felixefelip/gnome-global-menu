#!/bin/sh
# Starts a nested GNOME Shell (in a window) on its own D-Bus session and
# enables the extension in it. Everything started from inside the nested
# shell uses that same session bus.
#
# MUTTER_BUILD=<mutter build dir> runs the shell on that Mutter build instead
# of the installed one (it must be the same version). Arguments, if given, are
# a command run inside the nested session once the extension is enabled.
UUID=gnome-global-menu@felipefelix
WAYLAND_NAME=wayland-global-menu

if [ -z "$NESTED_INNER" ]; then
    NESTED_INNER=1 exec dbus-run-session -- "$0" "$@"
fi

# gnome-shell loads Mutter's libraries from their installed paths, ignoring
# LD_LIBRARY_PATH, so the built files are mounted over them instead.
mutter_overlay() {
    B=$(realpath "$MUTTER_BUILD")
    SYS=/usr/lib/x86_64-linux-gnu
    for pair in \
        "src/libmutter-18.so.0.0.0 $SYS/libmutter-18.so.0.0.0" \
        "clutter/clutter/libmutter-clutter-18.so.0.0.0 $SYS/mutter-18/libmutter-clutter-18.so.0.0.0" \
        "cogl/cogl/libmutter-cogl-18.so.0.0.0 $SYS/mutter-18/libmutter-cogl-18.so.0.0.0" \
        "mtk/mtk/libmutter-mtk-18.so.0.0.0 $SYS/mutter-18/libmutter-mtk-18.so.0.0.0" \
        "src/Meta-18.typelib $SYS/mutter-18/Meta-18.typelib" \
        "clutter/clutter/Clutter-18.typelib $SYS/mutter-18/Clutter-18.typelib" \
        "cogl/cogl/Cogl-18.typelib $SYS/mutter-18/Cogl-18.typelib" \
        "mtk/mtk/Mtk-18.typelib $SYS/mutter-18/Mtk-18.typelib"
    do
        set -- $pair
        printf ' --ro-bind %s %s' "$B/$1" "$2"
    done
}

if [ -n "$MUTTER_BUILD" ]; then
    echo "[nested] using Mutter from $MUTTER_BUILD"
    # shellcheck disable=SC2046
    bwrap --dev-bind / / $(mutter_overlay) \
        gnome-shell --devkit --wayland --wayland-display="$WAYLAND_NAME" &
else
    gnome-shell --devkit --wayland --wayland-display="$WAYLAND_NAME" &
fi
SHELL_PID=$!

# A failure here must not end the script: that would close the D-Bus
# session and take the nested shell down with it.
if gdbus wait --session --timeout 60 org.gnome.Shell &&
   gnome-extensions enable "$UUID"; then
    echo "[nested] $UUID enabled"
    gnome-extensions info "$UUID" | grep -iE 'state|estado'

    if [ $# -gt 0 ]; then
        echo "[nested] running $*"
        env -u DISPLAY WAYLAND_DISPLAY="$WAYLAND_NAME" "$@" &
    fi
else
    echo "[nested] could not enable $UUID" >&2
fi

wait "$SHELL_PID"
echo "[nested] gnome-shell exited with status $?"
