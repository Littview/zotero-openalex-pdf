// Default preferences for Zotero OpenAlex PDF Finder.
// Loaded by Zotero at plugin install; read via Zotero.Prefs.get('openalexpdf.<name>').

// Contact email sent as OpenAlex's `mailto` parameter (the "polite pool").
pref("extensions.zotero.openalexpdf.email", "");

// OpenAlex API key. Free at https://openalex.org/settings/api
// Required only for OpenAlex-hosted PDF downloads and for higher metadata limits.
pref("extensions.zotero.openalexpdf.apiKey", "");

// Download PDFs that OpenAlex hosts itself (content.openalex.org).
// Requires an API key and consumes credits (~$0.01/file, ~100/day free).
pref("extensions.zotero.openalexpdf.useHostedContent", true);

// Try the OpenAlex-hosted copy before publisher/repository links.
// Off by default: the free route costs no credits.
pref("extensions.zotero.openalexpdf.preferHostedContent", false);

// When an item has no DOI/PMID/arXiv ID, look the work up by title.
// Matches are accepted only on an exact normalized title plus a year check.
pref("extensions.zotero.openalexpdf.titleSearchFallback", true);

// Skip items that already have a PDF attachment.
pref("extensions.zotero.openalexpdf.skipItemsWithPDF", true);

// Record the matched OpenAlex work ID in the item's Extra field.
pref("extensions.zotero.openalexpdf.saveWorkIDToExtra", false);

// Milliseconds to pause between items, to stay well under OpenAlex's rate limit.
pref("extensions.zotero.openalexpdf.requestDelay", 250);
