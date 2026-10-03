/*
 * Zotero OpenAlex PDF Finder — plugin lifecycle, menus, preferences and progress UI.
 * Copyright (c) 2026 Littview Inc. — MIT licensed. See LICENSE.
 */

var ZoteroOpenAlex = {
	id: null,
	version: null,
	rootURI: null,

	FTL_FILE: 'openalex-pdf.ftl',
	PREF_BRANCH: 'openalexpdf.',
	QUEUE_ID: 'openalex-pdf',
	API_KEY_URL: 'https://openalex.org/settings/api',

	_l10n: null,
	_prefPaneID: null,
	_menuIDs: [],
	// Zotero 7 has no MenuManager, so there the menu items are added to each window by
	// hand. Window -> { elements, listeners } for removal.
	_legacyMenus: null,
	_ownStringsWork: false,
	_progressQueue: null,
	_cancelled: false,
	_onCancel: null,

	async init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;

		this._l10n = new Localization([this.FTL_FILE], true);

		// Zotero.getString() is used internally by the progress-queue dialog, so our
		// strings have to be reachable from it too.
		try {
			Zotero.ftl.addResourceIds([this.FTL_FILE]);
			Zotero.getString('openalex-pdf-progress-title');
			this._ownStringsWork = true;
		}
		catch (e) {
			this.log('Falling back to built-in strings for the progress dialog: ' + e);
		}

		await this.registerPreferencePane();
		this.registerMenus();

		// Exposed so the plugin can be driven from Tools -> Developer -> Run JavaScript,
		// e.g. await Zotero.OpenAlexPDF.Finder.run(ZoteroPane.getSelectedItems())
		Zotero.OpenAlexPDF = this;

		for (let win of Zotero.getMainWindows()) {
			if (win.ZoteroPane) {
				this.onMainWindowLoad(win);
			}
		}

		this.log('Initialized version ' + version);
	},

	shutdown() {
		for (let win of Zotero.getMainWindows()) {
			this._removeLegacyMenus(win);
		}
		this._legacyMenus = null;

		for (let menuID of this._menuIDs) {
			try {
				Zotero.MenuManager.unregisterMenu(menuID);
			}
			catch (e) {
				this.log(e);
			}
		}
		this._menuIDs = [];

		if (this._prefPaneID) {
			try {
				Zotero.PreferencePanes.unregister(this._prefPaneID);
			}
			catch (e) {
				this.log(e);
			}
			this._prefPaneID = null;
		}

		try {
			Zotero.ftl.removeResourceIds([this.FTL_FILE]);
		}
		catch (e) {
			// Not fatal — the strings just stay registered until restart
		}

		if (Zotero.OpenAlexPDF === this) {
			delete Zotero.OpenAlexPDF;
		}

		if (this._progressQueue && this._onCancel) {
			this._progressQueue.removeListener('cancel', this._onCancel);
			delete this._progressQueue._openAlexCancelListener;
		}
		this._progressQueue = null;
		this._onCancel = null;
		this._l10n = null;
	},

	onMainWindowLoad(window) {
		// Menu labels are Fluent IDs, so the window needs our .ftl loaded
		try {
			window.MozXULElement.insertFTLIfNeeded(this.FTL_FILE);
		}
		catch (e) {
			this.log(e);
		}
		if (this._legacyMenus) {
			this._addLegacyMenus(window);
		}
	},

	onMainWindowUnload(window) {
		this._removeLegacyMenus(window);
	},

	//
	// Preferences
	//

	getPref(name) {
		return Zotero.Prefs.get(this.PREF_BRANCH + name);
	},

	setPref(name, value) {
		return Zotero.Prefs.set(this.PREF_BRANCH + name, value);
	},

	getAPIKey() {
		return (this.getPref('apiKey') || '').trim();
	},

	async registerPreferencePane() {
		this._prefPaneID = await Zotero.PreferencePanes.register({
			pluginID: this.id,
			src: 'preferences.xhtml',
			scripts: ['preferences.js'],
			label: this.getString('openalex-pdf-prefs-title'),
			image: 'icons/openalex-48.svg',
			helpURL: 'https://github.com/Littview/zotero-openalex-pdf#settings'
		});
	},

	openPreferences() {
		Zotero.Utilities.Internal.openPreferences(this._prefPaneID);
	},

	//
	// Localization
	//

	getString(key, args) {
		try {
			let value = this._l10n.formatValueSync(key, args);
			if (value) {
				return value;
			}
		}
		catch (e) {
			this.log(e);
		}
		return key;
	},

	//
	// Menus
	//

	registerMenus() {
		if (!Zotero.MenuManager) {
			this._legacyMenus = new Map();
			return;
		}

		let icon = this.rootURI + 'icons/openalex-16.svg';

		let itemMenuID = Zotero.MenuManager.registerMenu({
			menuID: 'openalex-pdf-item-menu',
			pluginID: this.id,
			target: 'main/library/item',
			menus: [{
				menuType: 'menuitem',
				l10nID: 'openalex-pdf-menuitem',
				icon,
				onShowing: (event, ctx) => {
					// Hide entirely for note-only or attachment-only selections
					let items = (ctx.items || []).filter(item => item.isRegularItem() || item.parentItem);
					ctx.setVisible(items.length > 0);
				},
				onCommand: (event, ctx) => {
					this.run(ctx.items, event.target.ownerGlobal);
				}
			}]
		});
		if (itemMenuID) {
			this._menuIDs.push(itemMenuID);
		}

		let toolsMenuID = Zotero.MenuManager.registerMenu({
			menuID: 'openalex-pdf-tools-menu',
			pluginID: this.id,
			target: 'main/menubar/tools',
			menus: [{
				menuType: 'menuitem',
				l10nID: 'openalex-pdf-menuitem-tools',
				icon,
				enableForTabTypes: ['library'],
				onShowing: (event, ctx) => {
					let items = (ctx.items || []).filter(item => item && item.isRegularItem());
					ctx.setEnabled(items.length > 0);
				},
				onCommand: (event, ctx) => {
					this.run(ctx.items, event.target.ownerGlobal);
				}
			}]
		});
		if (toolsMenuID) {
			this._menuIDs.push(toolsMenuID);
		}
	},

	/**
	 * Zotero 7: the same two menu items as registerMenus(), added straight to the
	 * window's item context menu and Tools menu.
	 */
	_addLegacyMenus(win) {
		let doc = win.document;
		if (this._legacyMenus.has(win)) {
			return;
		}
		let entry = { elements: [], listeners: [] };
		this._legacyMenus.set(win, entry);

		let selectedItems = () => (win.ZoteroPane ? win.ZoteroPane.getSelectedItems() : []);
		let add = (popupID, itemID, l10nID, onShowing) => {
			let popup = doc.getElementById(popupID);
			if (!popup) {
				this.log('Menu not found: ' + popupID);
				return;
			}
			let menuitem = doc.createXULElement('menuitem');
			menuitem.id = itemID;
			menuitem.classList.add('menuitem-iconic');
			menuitem.setAttribute('data-l10n-id', l10nID);
			menuitem.style.listStyleImage = `url("${this.rootURI}icons/openalex-16.svg")`;
			menuitem.addEventListener('command', () => this.run(selectedItems(), win));
			popup.appendChild(menuitem);
			entry.elements.push(menuitem);

			let listener = (event) => {
				if (event.target === popup) {
					onShowing(menuitem);
				}
			};
			popup.addEventListener('popupshowing', listener);
			entry.listeners.push([popup, listener]);
		};

		add('zotero-itemmenu', 'openalex-pdf-itemmenu', 'openalex-pdf-menuitem', (menuitem) => {
			let items = selectedItems().filter(item => item.isRegularItem() || item.parentItem);
			menuitem.hidden = !items.length;
		});
		add('menu_ToolsPopup', 'openalex-pdf-toolsmenu', 'openalex-pdf-menuitem-tools', (menuitem) => {
			let inLibrary = !win.Zotero_Tabs || win.Zotero_Tabs.selectedType === 'library';
			let items = selectedItems().filter(item => item && item.isRegularItem());
			menuitem.disabled = !inLibrary || !items.length;
		});
	},

	_removeLegacyMenus(win) {
		let entry = this._legacyMenus && this._legacyMenus.get(win);
		if (!entry) {
			return;
		}
		for (let [popup, listener] of entry.listeners) {
			popup.removeEventListener('popupshowing', listener);
		}
		for (let element of entry.elements) {
			element.remove();
		}
		this._legacyMenus.delete(win);
	},

	run(items, win) {
		// Errors here would otherwise be swallowed by the menu command handler
		this.Finder.run(items || [], win || Zotero.getMainWindow())
			.catch(e => {
				Zotero.logError(e);
				this.alert(win, this.getString('openalex-pdf-error-unexpected'), String(e));
			});
	},

	//
	// Dialogs
	//

	alert(win, title, text) {
		Services.prompt.alert(win || Zotero.getMainWindow(), title, text);
	},

	//
	// Progress UI
	//

	/**
	 * A thin wrapper over Zotero's progress-queue dialog: a table of items with a
	 * per-row status, a cancel button, and double-click to reveal the item.
	 */
	createProgress() {
		let queue = this._progressQueue;
		if (!queue) {
			queue = Zotero.ProgressQueues.get(this.QUEUE_ID);
		}
		if (!queue) {
			queue = Zotero.ProgressQueues.create({
				id: this.QUEUE_ID,
				title: this._ownStringsWork
					? 'openalex-pdf-progress-title'
					: 'pane.items.menu.findAvailableFile',
				columns: this._ownStringsWork
					? ['openalex-pdf-progress-column-item', 'openalex-pdf-progress-column-status']
					: ['general.item', 'attachment.fullText']
			});
		}
		if (queue !== this._progressQueue) {
			// Zotero keeps progress queues for the whole session and has no way to delete
			// one, so after an in-place update or a disable/enable the queue still carries
			// the previous plugin instance's cancel listener. Replace it with ours.
			let previous = queue._openAlexCancelListener;
			if (previous) {
				queue.removeListener('cancel', previous);
			}
			this._onCancel = () => {
				this._cancelled = true;
			};
			queue.addListener('cancel', this._onCancel);
			queue._openAlexCancelListener = this._onCancel;
			this._progressQueue = queue;
		}

		// Start from a clean table on every run
		for (let row of queue.getRows().slice()) {
			queue.deleteRow(row.id);
		}
		this._cancelled = false;

		let dialog = queue.getDialog();
		dialog.showMinimizeButton(false);
		dialog.open();

		let self = this;
		return {
			get cancelled() {
				return self._cancelled;
			},
			add(item) {
				queue.addRow(item);
			},
			processing(item, message) {
				queue.updateRow(item.id, Zotero.ProgressQueue.ROW_PROCESSING, message || '');
			},
			succeeded(item, message) {
				queue.updateRow(item.id, Zotero.ProgressQueue.ROW_SUCCEEDED, message || '');
			},
			failed(item, message) {
				queue.updateRow(item.id, Zotero.ProgressQueue.ROW_FAILED, message || '');
			},
			setStatus(message) {
				dialog.setStatus(message);
			}
		};
	},

	/**
	 * Corner popup, used when there is nothing to put in the progress table.
	 */
	popup(headline, message) {
		let progressWindow = new Zotero.ProgressWindow();
		progressWindow.changeHeadline(headline);
		let itemProgress = new progressWindow.ItemProgress('attachmentPDF', message);
		progressWindow.show();
		itemProgress.setProgress(100);
		progressWindow.startCloseTimer(5000);
	},

	log(message) {
		Zotero.debug('[OpenAlex PDF Finder] ' + message);
	}
};
