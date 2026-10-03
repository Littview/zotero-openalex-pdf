/*
 * Zotero OpenAlex PDF Finder — OpenAlex API client.
 * Copyright (c) 2026 Littview Inc. — MIT licensed. See LICENSE.
 *
 * Two hosts are involved:
 *   api.openalex.org      metadata; works without a key (small daily credit
 *                         allowance), better with one
 *   content.openalex.org  OpenAlex-hosted full text; always requires a key
 *
 * The key is sent as an Authorization header rather than an `api_key` query
 * parameter so that it never ends up in a URL we might store on an item or log.
 */

ZoteroOpenAlex.API = {
	BASE: 'https://api.openalex.org',
	CONTENT_BASE: 'https://content.openalex.org',

	// Everything the finder needs, and nothing else — smaller responses, fewer surprises
	SELECT: [
		'id', 'doi', 'ids', 'title', 'display_name', 'publication_year', 'type',
		'open_access', 'best_oa_location', 'primary_location', 'locations',
		'has_content', 'content_urls'
	].join(','),

	// OpenAlex allows up to 50 values in an OR filter
	MAX_BATCH: 50,
	MAX_RETRIES: 2,

	// Set when OpenAlex rejects the configured key, so we stop sending it and fall
	// back to anonymous metadata access instead of failing outright
	keyRejected: false,

	/**
	 * Wrap a failure with a code the finder can branch on:
	 * 'auth' | 'rate-limit' | 'offline' | 'http' | 'invalid'
	 */
	error(code, message, status) {
		let e = new Error(message);
		e.openAlexCode = code;
		if (status) {
			e.status = status;
		}
		return e;
	},

	delay(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	},

	/** Call at the start of a run so an edited key gets another chance. */
	resetKeyState() {
		this.keyRejected = false;
	},

	_authHeaders() {
		let key = ZoteroOpenAlex.getAPIKey();
		return key && !this.keyRejected ? { Authorization: 'Bearer ' + key } : {};
	},

	/**
	 * Append the polite-pool contact address. OpenAlex asks for this instead of a
	 * custom User-Agent, which XHR will not let us set anyway.
	 */
	_withMailto(url) {
		let email = (ZoteroOpenAlex.getPref('email') || '').trim();
		if (!email) {
			return url;
		}
		return url + (url.includes('?') ? '&' : '?') + 'mailto=' + encodeURIComponent(email);
	},

	/**
	 * GET with 429 handling. Never throws on a non-2xx status except for the cases
	 * the caller cannot recover from; returns the XHR so callers can inspect status.
	 */
	async _get(url, options = {}) {
		let attempt = 0;
		while (true) {
			let sentKey = !!this._authHeaders().Authorization;
			let xhr;
			try {
				xhr = await Zotero.HTTP.request('GET', this._withMailto(url), {
					headers: Object.assign({}, this._authHeaders(), options.headers),
					responseType: options.responseType || 'json',
					timeout: options.timeout || 30000,
					successCodes: false,
					errorDelayMax: 0
				});
			}
			catch (e) {
				if (e instanceof Zotero.HTTP.BrowserOfflineException) {
					throw this.error('offline', ZoteroOpenAlex.getString('openalex-pdf-error-offline'));
				}
				throw this.error('http', e.message || String(e));
			}

			if (xhr.status === 429) {
				if (attempt++ >= this.MAX_RETRIES) {
					throw this.error('rate-limit',
						ZoteroOpenAlex.getString('openalex-pdf-error-rate-limit'), 429);
				}
				let retryAfter = parseInt(xhr.getResponseHeader('Retry-After'), 10);
				if (!(retryAfter > 0) || retryAfter > 60) {
					retryAfter = Math.min(30, 5 * attempt);
				}
				ZoteroOpenAlex.log(`Rate limited; retrying in ${retryAfter}s`);
				await this.delay(retryAfter * 1000);
				continue;
			}

			if (xhr.status === 401 || xhr.status === 403) {
				// Metadata works without a key, so a bad key should degrade the plugin
				// rather than break it. Content downloads have no such fallback.
				if (sentKey && options.anonymousFallback && !this.keyRejected) {
					this.keyRejected = true;
					ZoteroOpenAlex.log('API key rejected — continuing without it');
					continue;
				}
				throw this.error('auth',
					ZoteroOpenAlex.getString('openalex-pdf-error-auth'), xhr.status);
			}

			return xhr;
		}
	},

	async _getJSON(url) {
		let xhr = await this._get(url, { anonymousFallback: true });
		if (xhr.status < 200 || xhr.status >= 300) {
			throw this.error('http', `OpenAlex returned HTTP ${xhr.status}`, xhr.status);
		}
		let json = xhr.response;
		if (typeof json === 'string') {
			json = JSON.parse(json);
		}
		if (!json) {
			throw this.error('http', 'Empty response from OpenAlex');
		}
		return json;
	},

	//
	// Identifier helpers
	//

	normalizeDOI(doi) {
		if (!doi) {
			return null;
		}
		let clean = Zotero.Utilities.cleanDOI(String(doi));
		return clean ? clean.toLowerCase() : null;
	},

	/** "https://pubmed.ncbi.nlm.nih.gov/12345678" -> "12345678" */
	normalizePMID(pmid) {
		if (!pmid) {
			return null;
		}
		let match = String(pmid).match(/(\d{1,9})\s*$/);
		return match ? match[1] : null;
	},

	/** "https://openalex.org/W123" -> "W123" */
	shortWorkID(work) {
		let id = typeof work === 'string' ? work : (work && work.id);
		if (!id) {
			return null;
		}
		let match = String(id).match(/(W\d+)\s*$/);
		return match ? match[1] : null;
	},

	/**
	 * Look works up in batches of 50.
	 *
	 * @param {String} field - 'doi' or 'pmid'
	 * @param {String[]} values - already normalized
	 * @return {Promise<Map<String, Object>>} normalized identifier -> work
	 */
	async getWorksByIdentifiers(field, values) {
		let found = new Map();
		let unique = [...new Set(values.filter(Boolean))];

		for (let i = 0; i < unique.length; i += this.MAX_BATCH) {
			let chunk = unique.slice(i, i + this.MAX_BATCH);
			let filter = field + ':' + chunk.map(encodeURIComponent).join('|');
			let url = `${this.BASE}/works?filter=${filter}`
				+ `&select=${this.SELECT}&per-page=${this.MAX_BATCH}`;
			let json = await this._getJSON(url);

			for (let work of json.results || []) {
				let key = field === 'doi'
					? this.normalizeDOI(work.doi)
					: this.normalizePMID(work.ids && work.ids.pmid);
				if (key && !found.has(key)) {
					found.set(key, work);
				}
			}
		}
		return found;
	},

	/**
	 * Title lookup, for items with no usable identifier. Returns candidates only —
	 * the finder decides whether a candidate is close enough to trust.
	 */
	async searchByTitle(title, limit = 5) {
		let cleaned = String(title)
			// Commas and pipes are filter syntax; braces confuse the search parser
			.replace(/[,|(){}[\]]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
		if (cleaned.length < 8) {
			return [];
		}
		let url = `${this.BASE}/works?filter=title.search:${encodeURIComponent(cleaned)}`
			+ `&select=${this.SELECT}&per-page=${limit}`;
		let json = await this._getJSON(url);
		return json.results || [];
	},

	/**
	 * Credit balance for the configured key. Doubles as a key validity check.
	 */
	async getRateLimit() {
		return this._getJSON(`${this.BASE}/rate-limit`);
	},

	//
	// Full text
	//

	/** Canonical, key-free URL of the OpenAlex-hosted PDF, or null. */
	hostedPDFURL(work) {
		if (work.content_urls && work.content_urls.pdf) {
			return work.content_urls.pdf;
		}
		let id = this.shortWorkID(work);
		return id ? `${this.CONTENT_BASE}/works/${id}.pdf` : null;
	},

	hasHostedPDF(work) {
		return !!(work.has_content && work.has_content.pdf);
	},

	/**
	 * Download an OpenAlex-hosted PDF to `path`.
	 *
	 * Costs one content credit (~$0.01) and requires an API key.
	 *
	 * @return {Promise<String>} the canonical URL the file came from
	 */
	async downloadHostedPDF(work, path) {
		let url = this.hostedPDFURL(work);
		if (!url) {
			throw this.error('invalid', 'Work has no OpenAlex content URL');
		}
		if (!ZoteroOpenAlex.getAPIKey() || this.keyRejected) {
			throw this.error('auth', ZoteroOpenAlex.getString('openalex-pdf-error-auth'), 401);
		}

		let xhr = await this._get(url, { responseType: 'arraybuffer', timeout: 120000 });
		if (xhr.status === 404) {
			throw this.error('invalid', 'OpenAlex has no hosted PDF for this work', 404);
		}
		if (xhr.status < 200 || xhr.status >= 300) {
			throw this.error('http', `OpenAlex content returned HTTP ${xhr.status}`, xhr.status);
		}

		let bytes = new Uint8Array(xhr.response);
		// A JSON error body would otherwise be saved as a "PDF"
		if (!this.looksLikePDF(bytes)) {
			throw this.error('invalid', 'Downloaded file is not a PDF');
		}

		await IOUtils.write(path, bytes);
		return url;
	},

	looksLikePDF(bytes) {
		// "%PDF-"
		return bytes.length > 1024
			&& bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44
			&& bytes[3] === 0x46 && bytes[4] === 0x2D;
	}
};
