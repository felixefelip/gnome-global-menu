// Menus built from the actions a GtkApplication exports over org.gtk.Actions.
// GTK4/libadwaita apps keep their hamburger menu inside the process, but the
// actions behind it are public: well-known action names are mapped to labels.

/** One menu entry: the first of `actions` the app has is used. */
interface ActionEntry {
    label: string;
    actions: string[];
}

/** Null entries become separators, dropped when they would be empty. */
type MenuLayout = (ActionEntry | null)[];

export interface ActionMenuLayout {
    id: string;
    /** Null for the items shown in the app-name menu. */
    label: string | null;
    entries: MenuLayout;
}

const entry = (label: string, ...actions: string[]): ActionEntry => ({label, actions});

export function actionMenuLayouts(appName: string): ActionMenuLayout[] {
    return [
        {
            id: 'app',
            label: null,
            entries: [
                entry(`About ${appName}`, 'app.about', 'win.about'),
                null,
                entry('Preferences…', 'app.preferences', 'win.preferences', 'app.settings', 'win.settings'),
                entry('Keyboard Shortcuts', 'app.shortcuts', 'win.shortcuts',
                    'win.show-help-overlay', 'app.show-help-overlay'),
            ],
        },
        {
            id: 'file',
            label: 'File',
            entries: [
                entry('New Window', 'app.new-window', 'win.new-window'),
                entry('New Tab', 'win.new-tab', 'app.new-tab'),
                entry('New', 'win.new-document', 'app.new-document', 'win.new', 'app.new'),
                entry('Open…', 'win.open', 'app.open'),
                null,
                entry('Save', 'win.save'),
                entry('Save As…', 'win.save-as'),
                null,
                entry('Print…', 'win.print'),
                null,
                entry('Reopen Closed Tab', 'win.restore-tab', 'win.reopen-closed-tab'),
                entry('Close Tab', 'win.close-current-view', 'win.close-tab', 'win.close-page'),
                entry('Close Other Tabs', 'win.close-other-tabs'),
            ],
        },
        {
            id: 'edit',
            label: 'Edit',
            entries: [
                entry('Undo', 'win.undo', 'app.undo'),
                entry('Redo', 'win.redo', 'app.redo'),
                null,
                entry('Select All', 'win.select-all'),
                entry('Find', 'win.find', 'win.search'),
            ],
        },
        {
            id: 'view',
            label: 'View',
            entries: [
                entry('Sidebar', 'win.toggle-sidebar', 'win.show-sidebar'),
                entry('Reload', 'win.reload', 'win.refresh'),
                null,
                entry('Zoom In', 'win.zoom-in'),
                entry('Zoom Out', 'win.zoom-out'),
                entry('Actual Size', 'win.zoom-reset', 'win.zoom-normal', 'win.zoom-standard'),
                null,
                entry('Full Screen', 'win.fullscreen', 'win.toggle-fullscreen'),
            ],
        },
        {
            id: 'go',
            label: 'Go',
            entries: [
                entry('Back', 'win.go-back', 'win.back'),
                entry('Forward', 'win.go-forward', 'win.forward'),
                entry('Enclosing Folder', 'win.go-up', 'win.up'),
                null,
                entry('Home', 'win.go-home'),
            ],
        },
        {
            id: 'help',
            label: 'Help',
            entries: [
                entry(`${appName} Help`, 'app.help', 'win.help'),
            ],
        },
    ];
}

/**
 * Resolves a layout against the available actions: returns the action chosen
 * for each entry, with null for separators, trimmed of empty sections.
 */
export function resolveLayout(
    entries: MenuLayout,
    isUsable: (action: string) => boolean,
): ({label: string, action: string} | null)[] {
    const result: ({label: string, action: string} | null)[] = [];
    for (const item of entries) {
        if (!item) {
            if (result.length > 0 && result.at(-1) !== null)
                result.push(null);
            continue;
        }
        const action = item.actions.find(isUsable);
        if (action)
            result.push({label: item.label, action});
    }
    if (result.at(-1) === null)
        result.pop();
    return result;
}
