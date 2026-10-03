/*
 * Write the update manifest Zotero polls for new versions.
 * Usage: node scripts/update-manifest.js build/zotero-openalex-pdf-0.1.0.xpi
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const zotero = manifest.applications.zotero;

const xpiPath = process.argv[2];
if (!xpiPath) {
	console.error('Usage: node scripts/update-manifest.js <path-to-xpi>');
	process.exit(1);
}

const repo = manifest.homepage_url.replace(/\/$/, '');
const tag = 'v' + manifest.version;
const hash = crypto.createHash('sha256').update(fs.readFileSync(xpiPath)).digest('hex');

const update = {
	addons: {
		[zotero.id]: {
			updates: [
				{
					version: manifest.version,
					update_link: `${repo}/releases/download/${tag}/${path.basename(xpiPath)}`,
					update_hash: `sha256:${hash}`,
					applications: {
						zotero: {
							strict_min_version: zotero.strict_min_version,
							strict_max_version: zotero.strict_max_version
						}
					}
				}
			]
		}
	}
};

fs.writeFileSync(path.join(root, 'update.json'), JSON.stringify(update, null, '\t') + '\n');
console.log('Wrote update.json for ' + manifest.version);
