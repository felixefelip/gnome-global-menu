// Source-agnostic menu representation. Both GTK (org.gtk.Menus) and
// DBusMenu (com.canonical.dbusmenu) menus are converted into this shape
// before being rendered in the panel.

export type ToggleType = 'none' | 'check' | 'radio';

export interface MenuNode {
    id: string;
    label: string;
    separator: boolean;
    enabled: boolean;
    visible: boolean;
    toggle: ToggleType;
    toggled: boolean;
    accel: string | null;
    hasSubmenu: boolean;
    children: MenuNode[];
    /** Opaque data owned by the source that produced the node. */
    data: unknown;
}

export interface MenuSource {
    /** Identifies the exported menu, so the same menu is not rebuilt twice. */
    readonly key: string;
    /** Called when the top-level structure changed and must be fetched again. */
    onChanged: (() => void) | null;

    /** Top-level items (File, Edit, ...) with whatever children are already known. */
    getTopLevel(): Promise<MenuNode[]>;
    /** Called right before a submenu opens; returns its up-to-date children. */
    openSubmenu(node: MenuNode): Promise<MenuNode[]>;
    closeSubmenu(node: MenuNode): void;
    activate(node: MenuNode): void;
    destroy(): void;
}

export function makeSeparator(id: string): MenuNode {
    return {
        id,
        label: '',
        separator: true,
        enabled: true,
        visible: true,
        toggle: 'none',
        toggled: false,
        accel: null,
        hasSubmenu: false,
        children: [],
        data: null,
    };
}
