# Contributing

Bug reports, translations and pull requests are welcome. This file covers building,
testing and releasing; the user guide is in [README.md](README.md).

## Build

```bash
git clone https://github.com/Littview/zotero-openalex-pdf.git
cd zotero-openalex-pdf
npm run lint     # parses every source file, checks Fluent IDs and versions
npm run build    # writes build/zotero-openalex-pdf-<version>.xpi
```

There is no bundler and no runtime dependency. The `.xpi` is a zip of the source tree.

## Layout

```
manifest.json          plugin metadata, Zotero version range, update URL
bootstrap.js           startup/shutdown entry points
prefs.js               default preference values
src/plugin.js          lifecycle, menus, preference pane, progress UI
src/openalex-client.js OpenAlex HTTP client: batching, auth, rate limits
src/finder.js          item eligibility, matching, PDF resolution, attaching
preferences.xhtml/.js  settings pane
locale/en-US/*.ftl     all user-facing strings
update.json            update manifest Zotero polls (written by the release workflow)
```

## How matching works

| Item has | Lookup | Accepted when |
| --- | --- | --- |
| DOI (field or `DOI:` in Extra) | `filter=doi:…`, 50 per request | Always. DOIs are exact |
| arXiv ID in Extra or URL, no DOI | Converted to `10.48550/arxiv.<id>` | Always |
| `PMID:` in Extra, no DOI match | `filter=pmid:…`, 50 per request | Always |
| Neither | `filter=title.search:…` | Normalized titles are identical **and** years differ by at most 1 |

Normalization casefolds, strips accents and removes punctuation. A candidate with an
identical title but a year more than one off is reported as "Possible match rejected"
rather than attached.

Items with an arXiv ID also get arXiv's own PDF as a source, so they are covered even
when OpenAlex has no record under arXiv's DOI (common for preprints from before 2022) or
its only exact-title record carries a re-registered DOI with the wrong year.

Once a work is matched, sources are tried in this order: direct PDF links before landing
pages, published before accepted before submitted versions, open access before
paywalled. The OpenAlex-hosted copy (`content.openalex.org`, needs a key) is tried last
unless **Try the OpenAlex copy first** is on.

### OpenAlex cost model

Since February 2026 OpenAlex meters its API by credit, with a daily free allowance
($0.10/day without a key, $1/day with one) that resets at midnight UTC:

| What the plugin does | Endpoint | Cost |
| --- | --- | --- |
| Look up works by DOI or PMID, 50 per request | `api.openalex.org/works?filter=…` | $0.0001 per request |
| Look up a work by title | `api.openalex.org/works?filter=title.search:…` | $0.001 per request |
| Download an OpenAlex-hosted PDF | `content.openalex.org/works/W….pdf` | $0.01 per file |

Responses carry `X-RateLimit-*` headers; **Test Key** in the settings reports the balance.

The API key lives in the Zotero profile's preferences
(`extensions.zotero.openalexpdf.apiKey`), never in the library, and is sent as an
`Authorization: Bearer` header so it can't end up in a stored URL or a debug log. If
OpenAlex rejects it, metadata lookups continue anonymously and only hosted downloads are
switched off.

One hidden preference has no UI: `extensions.zotero.openalexpdf.requestDelay` (default
`250`) is the pause in milliseconds between items.

## Developing against a live Zotero

Point Zotero at your working copy instead of installing the `.xpi`:

```bash
echo -n "/absolute/path/to/zotero-openalex-pdf" \
  > "<zotero profile>/extensions/openalex-pdf@littview.com"
```

Restart Zotero, then **enable the plugin in Tools → Plugins**. Zotero ships with
`extensions.autoDisableScopes = 15`, so a plugin dropped into the profile arrives
disabled. Setting that pref to `0` in a development profile skips the step.

To test against a throwaway library instead of your own, run a second Zotero on a
scratch profile and data directory:

```bash
mkdir -p /tmp/zdev/profile/extensions /tmp/zdev/data
cp build/zotero-openalex-pdf-*.xpi "/tmp/zdev/profile/extensions/openalex-pdf@littview.com.xpi"
cat > /tmp/zdev/profile/prefs.js <<'PREFS'
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.zotero.debug.log", true);
user_pref("app.update.url", "http://127.0.0.1:1/no-update.xml");
user_pref("extensions.zotero.httpServer.port", 23129);
PREFS

MOZ_NO_REMOTE=1 /Applications/Zotero.app/Contents/MacOS/zotero \
  -profile /tmp/zdev/profile -datadir /tmp/zdev/data -ZoteroDebugText
```

The dead `app.update.url` matters: without it the second instance runs the application
updater and can restart your main Zotero. The port change avoids a clash with the
connector server of a Zotero that's already running.

Any helper plugin you install in that profile needs an `https` `update_url` in its
manifest. With an `http` one, the add-on manager quietly marks it `appDisabled`.

**Help → Debug Output Logging** shows the plugin's messages, all prefixed with
`[OpenAlex PDF Finder]`.

### Scripting it

The plugin publishes itself as `Zotero.OpenAlexPDF`, so it can be driven from
**Tools → Developer → Run JavaScript**:

```javascript
await Zotero.OpenAlexPDF.Finder.run(ZoteroPane.getSelectedItems());
```

## Translations

Copy `locale/en-US/openalex-pdf.ftl` to `locale/<your-locale>/openalex-pdf.ftl`,
translate the values (not the IDs), and open a pull request.

## Releasing

1. Bump `version` in both `manifest.json` and `package.json` (`npm run lint` checks
   they match). `strict_max_version` is `*` on purpose, so a new Zotero major release
   doesn't disable the plugin. Test against it anyway when one comes out.
2. Commit, then push an annotated tag at the head of `main`:
   ```bash
   git tag -a v0.3.1 -m 0.3.1 && git push --follow-tags
   ```
3. The **Release** workflow builds the `.xpi`, publishes a GitHub release with both
   `zotero-openalex-pdf-<version>.xpi` and a stable-name `zotero-openalex-pdf.xpi` (what
   the README's download link points at), and commits a fresh `update.json` to `main`.
   Pull afterwards.
