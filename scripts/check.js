/*
 * Sanity checks that do not need a running Zotero:
 *   - every source file parses
 *   - manifest.json and package.json agree on the version
 *   - every Fluent ID referenced from JS or XHTML exists in the English .ftl
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let failures = [];
const fail = message => failures.push(message);

// 1. Syntax
const sources = ['bootstrap.js', 'preferences.js', 'prefs.js']
	.concat(fs.readdirSync(path.join(root, 'src')).map(f => path.join('src', f)));
for (const file of sources) {
	try {
		new vm.Script(read(file), { filename: file });
	}
	catch (e) {
		fail(`${file}: ${e.message}`);
	}
}

// 2. Versions
const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));
if (manifest.version !== pkg.version) {
	fail(`version mismatch: manifest.json ${manifest.version} vs package.json ${pkg.version}`);
}

// 3. Fluent IDs
const ftl = read('locale/en-US/openalex-pdf.ftl');
const defined = new Set([...ftl.matchAll(/^([a-z][a-z0-9-]*) =/gm)].map(m => m[1]));

const referenced = new Set();
for (const file of sources) {
	const source = read(file);
	for (const m of source.matchAll(/getString\('([a-z][a-z0-9-]*)'/g)) referenced.add(m[1]);
	for (const m of source.matchAll(/l10nID: '([a-z][a-z0-9-]*)'/g)) referenced.add(m[1]);
	for (const m of source.matchAll(/setAttributes\([^,]+, '([a-z][a-z0-9-]*)'/g)) referenced.add(m[1]);
	// Progress-queue title/columns are passed to Zotero.getString() as bare strings
	for (const m of source.matchAll(/'(openalex-pdf-progress-[a-z0-9-]+)'/g)) referenced.add(m[1]);
}
for (const m of read('preferences.xhtml').matchAll(/data-l10n-id="([^"]+)"/g)) {
	referenced.add(m[1]);
}
for (const id of referenced) {
	if (!defined.has(id)) {
		fail(`missing Fluent message: ${id}`);
	}
}

// 4. Files referenced from the manifest and from registration calls exist
const referencedFiles = [
	...Object.values(manifest.icons),
	'icons/openalex-16.svg',
	'preferences.xhtml',
	'preferences.js'
];
for (const file of referencedFiles) {
	if (!fs.existsSync(path.join(root, file))) {
		fail(`missing file referenced in code or manifest: ${file}`);
	}
}

if (failures.length) {
	console.error(failures.map(f => 'FAIL ' + f).join('\n'));
	process.exit(1);
}
console.log(`OK — ${sources.length} sources parsed, ${defined.size} messages defined, ${referenced.size} referenced`);
