/*
 * Zotero OpenAlex PDF Finder
 * Copyright (c) 2026 Littview Inc. — MIT licensed. See LICENSE.
 *
 * Bootstrap entry points. Zotero loads this file into a privileged sandbox that
 * already provides Zotero, Services, Localization, IOUtils, PathUtils, fetch and
 * the REASONS constants (APP_SHUTDOWN etc.) as globals.
 */

var ZoteroOpenAlex;

function install() {}

function uninstall() {}

async function startup({ id, version, rootURI }) {
	Services.scriptloader.loadSubScript(rootURI + 'src/plugin.js');
	Services.scriptloader.loadSubScript(rootURI + 'src/openalex-client.js');
	Services.scriptloader.loadSubScript(rootURI + 'src/finder.js');
	await ZoteroOpenAlex.init({ id, version, rootURI });
}

function shutdown(_data, reason) {
	// Nothing to tear down if the whole app is going away
	if (reason === APP_SHUTDOWN) {
		return;
	}
	if (ZoteroOpenAlex) {
		ZoteroOpenAlex.shutdown();
		ZoteroOpenAlex = undefined;
	}
}

function onMainWindowLoad({ window }) {
	if (ZoteroOpenAlex) {
		ZoteroOpenAlex.onMainWindowLoad(window);
	}
}

function onMainWindowUnload({ window }) {
	if (ZoteroOpenAlex) {
		ZoteroOpenAlex.onMainWindowUnload(window);
	}
}
