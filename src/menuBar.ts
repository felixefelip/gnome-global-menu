// Renders a MenuSource as a row of buttons in the left side of the top panel.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {MenuNode, MenuSource} from './menuModel.js';
import {log, logError} from './util.js';

// Large enough to always append after the existing left-box children.
const PANEL_POSITION = 1000;

export interface FocusedApp {
    name: string;
    app: Shell.App | null;
    window: Meta.Window;
}

export class MenuBar {
    private _buttons: PanelMenu.Button[] = [];
    private _source: MenuSource | null = null;
    private _focused: FocusedApp | null = null;
    private _generation = 0;
    private _roleCounter = 0;
    private _rebuildPending = false;

    get source() {
        return this._source;
    }

    get window() {
        return this._focused?.window ?? null;
    }

    /** Shows the menu of a new app/window. Takes ownership of the source. */
    show(focused: FocusedApp, source: MenuSource | null) {
        if (this._source !== source)
            this._source?.destroy();
        this._source = source;
        this._focused = focused;
        if (source)
            source.onChanged = () => this.rebuild();
        this.rebuild();
    }

    destroy() {
        this._generation++;
        this._clearButtons();
        this._source?.destroy();
        this._source = null;
        this._focused = null;
    }

    rebuild() {
        // Rebuilding would close a menu the user is browsing; wait for it to close.
        if (this._buttons.some(button => (button.menu as PopupMenu.PopupMenu).isOpen)) {
            this._rebuildPending = true;
            return;
        }
        this._rebuildPending = false;
        this._rebuildAsync().catch(e => logError(e, 'rebuild'));
    }

    private async _rebuildAsync() {
        const generation = ++this._generation;
        const source = this._source;

        let nodes: MenuNode[] = [];
        if (source) {
            try {
                nodes = await source.getTopLevel();
            } catch (e) {
                logError(e, `cannot read menu ${source.key}`);
            }
        }
        if (generation !== this._generation)
            return;

        this._clearButtons();
        if (!this._focused)
            return;

        log(`showing ${nodes.length} menus for ${this._focused.name} (${source?.key ?? 'no menu'})`);
        this._addAppButton(this._focused);
        for (const node of nodes) {
            if (node.visible && !node.separator)
                this._addMenuButton(node, source!);
        }
    }

    private _clearButtons() {
        for (const button of this._buttons)
            button.destroy();
        this._buttons = [];
    }

    private _addButton(label: string, styleClass: string | null): PanelMenu.Button {
        const button = new PanelMenu.Button(0.0, label, false);
        button.add_child(new St.Label({
            text: label,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: styleClass ?? '',
        }));
        (button.menu as PopupMenu.PopupMenu).connect('open-state-changed', (_menu, open) => {
            if (!open && this._rebuildPending)
                this.rebuild();
        });

        Main.panel.addToStatusArea(`global-menu-${this._roleCounter++}`, button, PANEL_POSITION, 'left');
        this._buttons.push(button);
        return button;
    }

    private _addAppButton(focused: FocusedApp) {
        const button = this._addButton(focused.name, 'global-menu-app-name');
        const menu = button.menu as PopupMenu.PopupMenu;

        menu.addAction('Close Window', () => focused.window.delete(global.get_current_time()));
        if (focused.app) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            menu.addAction(`Quit ${focused.name}`, () => focused.app!.request_quit());
        }
    }

    private _addMenuButton(node: MenuNode, source: MenuSource) {
        const button = this._addButton(node.label, null);
        const menu = button.menu as PopupMenu.PopupMenu;
        this._fill(menu, node.children, source);
        this._refreshOnOpen(menu, node, source);
    }

    private _refreshOnOpen(menu: PopupMenu.PopupMenuBase, node: MenuNode, source: MenuSource) {
        menu.connect('open-state-changed', (_menu, open) => {
            if (!open) {
                source.closeSubmenu(node);
                return;
            }

            const generation = this._generation;
            source.openSubmenu(node).then(children => {
                if (generation === this._generation && menu.isOpen)
                    this._fill(menu, children, source);
            }).catch(e => logError(e, `cannot open submenu ${node.label}`));
        });
    }

    private _fill(menu: PopupMenu.PopupMenuBase, nodes: MenuNode[], source: MenuSource) {
        menu.removeAll();

        const visible = nodes.filter(node => node.visible);
        if (visible.length === 0) {
            // An empty PopupMenu refuses to open, so keep a placeholder while loading.
            const placeholder = new PopupMenu.PopupMenuItem('…');
            placeholder.setSensitive(false);
            menu.addMenuItem(placeholder);
            return;
        }

        const hasToggles = visible.some(node => node.toggle !== 'none');
        for (const node of visible) {
            if (node.separator) {
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            } else if (node.hasSubmenu) {
                const item = new PopupMenu.PopupSubMenuMenuItem(node.label, false);
                item.setSensitive(node.enabled);
                this._fill(item.menu, node.children, source);
                this._refreshOnOpen(item.menu, node, source);
                menu.addMenuItem(item);
            } else {
                menu.addMenuItem(this._createItem(node, source, hasToggles));
            }
        }
    }

    private _createItem(node: MenuNode, source: MenuSource, hasToggles: boolean) {
        const item = new PopupMenu.PopupMenuItem(node.label);
        item.setSensitive(node.enabled);

        if (node.toggle === 'check')
            item.setOrnament(node.toggled ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        else if (node.toggle === 'radio')
            item.setOrnament(node.toggled ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
        else if (hasToggles)
            item.setOrnament(PopupMenu.Ornament.NONE);

        if (node.accel) {
            item.label.x_expand = true;
            item.add_child(new St.Label({
                text: node.accel,
                style_class: 'global-menu-accel',
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        item.connect('activate', () => source.activate(node));
        return item;
    }
}
