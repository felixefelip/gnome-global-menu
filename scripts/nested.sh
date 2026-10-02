#!/bin/sh
# Starts a nested GNOME Shell (in a window) on its own D-Bus session and
# enables the extension in it. Everything started from inside the nested
# shell uses that same session bus.
UUID=gnome-global-menu@felipefelix

if [ -z "$NESTED_INNER" ]; then
    NESTED_INNER=1 exec dbus-run-session -- "$0" "$@"
fi

gnome-shell --devkit --wayland &
SHELL_PID=$!

# A failure here must not end the script: that would close the D-Bus
# session and take the nested shell down with it.
if gdbus wait --session --timeout 60 org.gnome.Shell &&
   gnome-extensions enable "$UUID"; then
    echo "[nested] $UUID enabled"
    gnome-extensions info "$UUID" | grep -iE 'state|estado'
else
    echo "[nested] could not enable $UUID" >&2
fi

wait "$SHELL_PID"
echo "[nested] gnome-shell exited with status $?"
