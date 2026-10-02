import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const LOG_PREFIX = '[global-menu]';

export function log(...args: unknown[]) {
    console.log(LOG_PREFIX, ...args);
}

export function logError(error: unknown, context: string) {
    console.error(LOG_PREFIX, context, error);
}

/** Turns "_File" into "File" and "Save __As" into "Save _As". */
export function stripMnemonic(label: string): string {
    return label.replace(/_(_?)/g, (_match, escaped: string) => escaped);
}

const MODIFIER_NAMES: Record<string, string> = {
    primary: 'Ctrl',
    control: 'Ctrl',
    ctrl: 'Ctrl',
    shift: 'Shift',
    alt: 'Alt',
    super: 'Super',
    meta: 'Meta',
};

/** Formats ["Control", "Shift", "q"] as "Ctrl+Shift+Q". */
export function formatAccel(parts: string[]): string {
    return parts
        .map(part => MODIFIER_NAMES[part.toLowerCase()] ??
            (part.length === 1 ? part.toUpperCase() : part))
        .join('+');
}

/** Formats a GTK accelerator such as "<Primary><Shift>q". */
export function formatGtkAccel(accel: string): string {
    const modifiers = [...accel.matchAll(/<(\w+)>/g)].map(match => match[1]);
    const key = accel.replace(/<\w+>/g, '');
    return formatAccel([...modifiers, key]);
}

export function dbusCall(
    bus: Gio.DBusConnection,
    name: string,
    path: string,
    iface: string,
    method: string,
    params: GLib.Variant | null,
    replyType: string | null,
    timeoutMs = 2000,
): Promise<GLib.Variant> {
    return new Promise((resolve, reject) => {
        bus.call(
            name, path, iface, method, params,
            replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NONE, timeoutMs, null,
            (connection, result) => {
                try {
                    resolve(connection!.call_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}
