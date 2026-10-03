## Menus

openalex-pdf-menuitem =
    .label = Find PDF via OpenAlex

openalex-pdf-menuitem-tools =
    .label = Find PDFs via OpenAlex

## Progress window

openalex-pdf-progress-title = Find PDF via OpenAlex
openalex-pdf-progress-column-item = Item
openalex-pdf-progress-column-status = Status

openalex-pdf-no-eligible-items = No eligible items selected
openalex-pdf-already-running = Already looking for PDFs — wait for the current run to finish
openalex-pdf-status-looking-up = Looking up works on OpenAlex…
openalex-pdf-status-processing = Processing { $current } of { $total }…
openalex-pdf-status-cancelled = Cancelled
openalex-pdf-status-done = Attached { $attached } · No PDF found { $missing } · Errors { $failed }

## Per-item results

openalex-pdf-result-no-work = Not found on OpenAlex
openalex-pdf-result-year-mismatch = Possible match rejected — the years disagree
openalex-pdf-result-downloading = Looking for a PDF…
openalex-pdf-result-downloading-hosted = Downloading from OpenAlex…
openalex-pdf-result-attached-hosted = PDF attached (OpenAlex full text)
openalex-pdf-result-attached-link = PDF attached
openalex-pdf-result-no-fulltext = No full text available
openalex-pdf-result-not-downloaded = No PDF could be downloaded

## Errors

openalex-pdf-error-auth = OpenAlex rejected the API key. Check it in the plugin preferences.
openalex-pdf-error-rate-limit = OpenAlex rate limit reached. Try again later or add an API key.
openalex-pdf-error-offline = No internet connection
openalex-pdf-error-unexpected = Unexpected error — see the Zotero debug output for details

## Preferences

openalex-pdf-prefs-title = OpenAlex PDF

openalex-pdf-prefs-account-header = OpenAlex Account
openalex-pdf-prefs-email-label = Contact email:
openalex-pdf-prefs-email-description = Sent to OpenAlex as your contact address, which puts your requests in its faster "polite pool". Optional.
openalex-pdf-prefs-apikey-label = API key:
openalex-pdf-prefs-apikey-description = Optional — everything except OpenAlex-hosted downloads works without one, and the keyless allowance covers tens of thousands of items a day. Free at openalex.org/settings/api. Stored in your Zotero profile, not in your library.
openalex-pdf-prefs-apikey-get =
    .label = Get a Key…
openalex-pdf-prefs-apikey-test =
    .label = Test Key
openalex-pdf-prefs-apikey-testing = Checking…
openalex-pdf-prefs-apikey-valid = Key works — { $remaining } credits left today
openalex-pdf-prefs-apikey-valid-nocredits = Key works
openalex-pdf-prefs-apikey-invalid = Key rejected by OpenAlex
openalex-pdf-prefs-apikey-error = Could not reach OpenAlex
openalex-pdf-prefs-apikey-empty = Enter a key first

openalex-pdf-prefs-sources-header = Where to Get PDFs
openalex-pdf-prefs-hosted =
    .label = Download PDFs hosted by OpenAlex
openalex-pdf-prefs-hosted-description = OpenAlex hosts full text for roughly 60 million open-access works, as a fallback for items whose publisher links fail. Used only when you have entered an API key; a free key covers about 100 of these a day. PDFs fetched from publishers and repositories never count against it.
openalex-pdf-prefs-prefer-hosted =
    .label = Try the OpenAlex copy before publisher and repository links
openalex-pdf-prefs-prefer-hosted-description = Off by default, so publisher and repository links are tried first and your daily allowance is left for the items that need it.

openalex-pdf-prefs-matching-header = Matching
openalex-pdf-prefs-title-search =
    .label = Look up items without a DOI or PMID by title
openalex-pdf-prefs-title-search-description = A title match is accepted only when the titles are identical apart from punctuation and the publication years are no more than one year apart.
openalex-pdf-prefs-skip =
    .label = Skip items that already have a PDF
openalex-pdf-prefs-extra =
    .label = Record the matched OpenAlex work ID in the Extra field

openalex-pdf-prefs-about = Free and open source, by
openalex-pdf-prefs-about-link =
    .value = Littview, systematic review software
