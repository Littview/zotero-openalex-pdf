/*
 * Zotero OpenAlex PDF Finder — matching items to OpenAlex works and attaching PDFs.
 * Copyright (c) 2026 Littview Inc. — MIT licensed. See LICENSE.
 */

ZoteroOpenAlex.Finder = {
	// Preferred order when several open-access copies exist
	VERSION_RANK: {
		publishedVersion: 0,
		acceptedVersion: 1,
		submittedVersion: 2
	},

	MAX_RESOLVERS: 8,

	// Europe PMC allows only a few downloads at a time and answers the rest with 429
	// and a Retry-After. How many times to wait that out for one item.
	EUROPE_PMC_RETRIES: 2,

	// Set once waiting has not been enough, so that the rest of the run stops waiting
	_europePMCThrottled: false,

	// A second invocation while a run is in flight would see items whose download has
	// not landed yet and attach a duplicate, and would clear the first run's rows
	_running: false,

	/**
	 * Entry point for the menu commands.
	 *
	 * @param {Zotero.Item[]} items
	 * @param {Window} win
	 */
	async run(items, win) {
		if (this._running) {
			ZoteroOpenAlex.popup(
				ZoteroOpenAlex.getString('openalex-pdf-progress-title'),
				ZoteroOpenAlex.getString('openalex-pdf-already-running')
			);
			return;
		}

		let candidates = this._collectItems(items);

		if (!candidates.length) {
			ZoteroOpenAlex.popup(
				ZoteroOpenAlex.getString('openalex-pdf-progress-title'),
				ZoteroOpenAlex.getString('openalex-pdf-no-eligible-items')
			);
			return;
		}

		// OpenAlex-hosted PDFs need a key. Without one they are simply skipped: the
		// plugin is meant to work out of the box, so it never nags for a key
		let hostedWanted = !!ZoteroOpenAlex.getPref('useHostedContent') && !!ZoteroOpenAlex.getAPIKey();

		this._running = true;
		try {
			await this._process(candidates, hostedWanted);
		}
		finally {
			this._running = false;
		}
	},

	async _process(candidates, hostedWanted) {
		ZoteroOpenAlex.API.resetKeyState();
		this._europePMCThrottled = false;

		let progress = ZoteroOpenAlex.createProgress();
		for (let item of candidates) {
			progress.add(item);
		}
		progress.setStatus(ZoteroOpenAlex.getString('openalex-pdf-status-looking-up'));

		let matches;
		let rejected = new Set();
		try {
			matches = await this._matchWorks(candidates, progress, rejected);
		}
		catch (e) {
			Zotero.logError(e);
			let message = this._describeError(e);
			for (let item of candidates) {
				progress.failed(item, message);
			}
			progress.setStatus(message);
			return;
		}

		let delay = parseInt(ZoteroOpenAlex.getPref('requestDelay'), 10) || 0;
		let counts = { attached: 0, notFound: 0, failed: 0 };
		let processed = 0;
		// Shared across items so one rejected key does not re-fail on every item
		let hosted = { enabled: hostedWanted, disabledReason: null };
		if (ZoteroOpenAlex.API.keyRejected) {
			// Metadata fell back to anonymous access; hosted downloads cannot
			hosted.enabled = false;
			hosted.disabledReason = ZoteroOpenAlex.getString('openalex-pdf-error-auth');
		}

		for (let item of candidates) {
			if (progress.cancelled) {
				break;
			}
			processed++;
			progress.setStatus(ZoteroOpenAlex.getString('openalex-pdf-status-processing', {
				current: processed,
				total: candidates.length
			}));

			let work = matches.get(item.id) || this._arXivWork(item);
			if (!work) {
				counts.notFound++;
				progress.failed(item, rejected.has(item.id)
					? ZoteroOpenAlex.getString('openalex-pdf-result-year-mismatch')
					: ZoteroOpenAlex.getString('openalex-pdf-result-no-work'));
				continue;
			}

			progress.processing(item, ZoteroOpenAlex.getString('openalex-pdf-result-downloading'));

			try {
				let result = await this._attachPDF(item, work, hosted, progress);
				if (result.attached) {
					counts.attached++;
					progress.succeeded(item, result.message);
				}
				else {
					counts.notFound++;
					progress.failed(item, result.message);
				}
			}
			catch (e) {
				Zotero.logError(e);
				counts.failed++;
				progress.failed(item, this._describeError(e));
			}

			if (ZoteroOpenAlex.getPref('saveWorkIDToExtra')) {
				try {
					await this._saveWorkID(item, work);
				}
				catch (e) {
					Zotero.logError(e);
				}
			}

			if (delay > 0 && processed < candidates.length) {
				await ZoteroOpenAlex.API.delay(delay);
			}
		}

		let status = ZoteroOpenAlex.getString('openalex-pdf-status-done', {
			attached: counts.attached,
			missing: counts.notFound,
			failed: counts.failed
		});
		if (hosted.disabledReason) {
			status += ' — ' + hosted.disabledReason;
		}
		if (progress.cancelled) {
			status = ZoteroOpenAlex.getString('openalex-pdf-status-cancelled') + ' — ' + status;
		}
		progress.setStatus(status);
		ZoteroOpenAlex.log(`Finished: ${JSON.stringify(counts)}`);
	},

	//
	// Item selection
	//

	/**
	 * Regular, editable items with no PDF yet. Selecting an attachment counts as
	 * selecting its parent, which is what happens when people click around in the
	 * middle pane.
	 */
	_collectItems(items) {
		let seen = new Set();
		let result = [];
		let skipWithPDF = ZoteroOpenAlex.getPref('skipItemsWithPDF');

		for (let item of items) {
			// Nothing in the trash gets a PDF, whether it was picked there or passed in
			if (!item || item.deleted) {
				continue;
			}
			if (!item.isRegularItem() && item.parentItem) {
				item = item.parentItem;
			}
			if (!item.isRegularItem() || item.deleted || seen.has(item.id)) {
				continue;
			}
			seen.add(item.id);

			let library = Zotero.Libraries.get(item.libraryID);
			if (!library || !library.editable || !library.filesEditable) {
				continue;
			}
			if (skipWithPDF && this._hasPDF(item)) {
				continue;
			}
			result.push(item);
		}
		return result;
	},

	_hasPDF(item) {
		for (let attachment of Zotero.Items.get(item.getAttachments())) {
			if (attachment.attachmentContentType === 'application/pdf') {
				return true;
			}
		}
		return false;
	},

	//
	// Matching items to OpenAlex works
	//

	/**
	 * @return {Promise<Map<Number, Object>>} item ID -> OpenAlex work
	 */
	async _matchWorks(items, progress, rejected = new Set()) {
		let api = ZoteroOpenAlex.API;
		let matches = new Map();
		let identifiers = new Map();

		for (let item of items) {
			identifiers.set(item.id, this._identifiers(item));
		}

		// DOI first — it is exact, free as a batch, and by far the most common
		let dois = [];
		for (let ids of identifiers.values()) {
			if (ids.doi) {
				dois.push(ids.doi);
			}
		}
		if (dois.length) {
			let byDOI = await api.getWorksByIdentifiers('doi', dois);
			for (let item of items) {
				let doi = identifiers.get(item.id).doi;
				if (doi && byDOI.has(doi)) {
					matches.set(item.id, byDOI.get(doi));
				}
			}
		}

		// PMID for whatever the DOI pass missed
		let pmids = [];
		for (let item of items) {
			let ids = identifiers.get(item.id);
			if (!matches.has(item.id) && ids.pmid) {
				pmids.push(ids.pmid);
			}
		}
		if (pmids.length) {
			let byPMID = await api.getWorksByIdentifiers('pmid', pmids);
			for (let item of items) {
				let ids = identifiers.get(item.id);
				if (!matches.has(item.id) && ids.pmid && byPMID.has(ids.pmid)) {
					matches.set(item.id, byPMID.get(ids.pmid));
				}
			}
		}

		// Title search last: one request per item, and only accepted on an exact match
		if (ZoteroOpenAlex.getPref('titleSearchFallback')) {
			for (let item of items) {
				if (matches.has(item.id) || (progress && progress.cancelled)) {
					continue;
				}
				let ids = identifiers.get(item.id);
				if (!ids.title) {
					continue;
				}
				let results;
				try {
					results = await api.searchByTitle(ids.title);
				}
				catch (e) {
					// One failed title search should not sink the whole run
					if (e.openAlexCode === 'auth' || e.openAlexCode === 'rate-limit') {
						throw e;
					}
					Zotero.logError(e);
					continue;
				}
				let work = results.find(candidate => this._titleMatches(ids, candidate));
				if (work) {
					matches.set(item.id, work);
				}
				else if (results.some(candidate => this._titleOnlyMatches(ids, candidate))) {
					// Same title, incompatible year: worth telling the user about rather
					// than reporting a flat "not found"
					rejected.add(item.id);
				}
			}
		}

		return matches;
	},

	_identifiers(item) {
		let api = ZoteroOpenAlex.API;
		let extra = item.getField('extra') || '';

		let doi = api.normalizeDOI(item.getField('DOI') || item.getExtraField('DOI'));

		// arXiv preprints have a predictable DataCite DOI
		let arxiv = this._arXivID(item);
		if (!doi && arxiv) {
			doi = api.normalizeDOI('10.48550/arxiv.' + arxiv);
		}

		let pmidMatch = extra.match(/^\s*PMID\s*:\s*(\d+)/im);

		return {
			doi,
			pmid: pmidMatch ? pmidMatch[1] : null,
			title: item.getField('title') || '',
			normalizedTitle: this._normalizeTitle(item.getField('title') || ''),
			year: this._year(item)
		};
	},

	/** "arXiv: 1706.03762v5" in Extra, or an arxiv.org URL -> "1706.03762" */
	_arXivID(item) {
		let match = (item.getField('extra') || '').match(/^\s*arxiv\s*:\s*(\S+)/im)
			|| (item.getField('url') || '').match(/arxiv\.org\/(?:abs|pdf)\/(\S+?)(?:v\d+)?(?:\.pdf)?$/i);
		return match ? match[1].replace(/v\d+$/i, '') : null;
	},

	/**
	 * Fallback for arXiv items OpenAlex could not match. Older preprints often have no
	 * record under arXiv's DOI, and the title copy may carry a re-registered DOI with
	 * the wrong year. The arXiv ID itself is exact, so arXiv's own PDF is safe to use.
	 * Returns a location-only stand-in for a work, or null.
	 */
	_arXivWork(item) {
		let id = this._arXivID(item);
		if (!id) {
			return null;
		}
		return {
			locations: [{
				pdf_url: 'https://arxiv.org/pdf/' + id,
				landing_page_url: 'https://arxiv.org/abs/' + id,
				is_oa: true,
				version: 'submittedVersion',
				source: { display_name: 'arXiv' }
			}]
		};
	},

	_year(item) {
		let date = item.getField('date');
		if (!date) {
			return null;
		}
		let parsed = Zotero.Date.strToDate(date);
		return parsed && parsed.year ? parseInt(parsed.year, 10) : null;
	},

	/**
	 * Casefold, drop accents and punctuation. Two titles that differ only in
	 * typography normalize to the same string; anything else does not.
	 */
	_normalizeTitle(title) {
		return String(title)
			.normalize('NFKD')
			.replace(/[\u0300-\u036f]/g, '')
			.toLowerCase()
			.replace(/&/g, ' and ')
			.replace(/[^a-z0-9]+/g, ' ')
			.trim();
	},

	/**
	 * Deliberately strict. A wrong PDF silently attached to the wrong reference is
	 * worse than no PDF at all, so a title match must be exact after normalization
	 * and must not contradict the item's year.
	 */
	_titleMatches(ids, work) {
		if (!this._titleOnlyMatches(ids, work)) {
			return false;
		}
		if (ids.year && work.publication_year && Math.abs(work.publication_year - ids.year) > 1) {
			return false;
		}
		return true;
	},

	_titleOnlyMatches(ids, work) {
		let candidateTitle = work.title || work.display_name || '';
		if (!candidateTitle || !ids.normalizedTitle) {
			return false;
		}
		return this._normalizeTitle(candidateTitle) === ids.normalizedTitle;
	},

	//
	// Attaching
	//

	async _attachPDF(item, work, hostedState, progress) {
		let api = ZoteroOpenAlex.API;
		let useHosted = hostedState.enabled && api.hasHostedPDF(work) && !!api.hostedPDFURL(work);
		let preferHosted = !!ZoteroOpenAlex.getPref('preferHostedContent');
		let resolvers = this._buildURLResolvers(work, this._arXivWork(item));
		let pmc = this._pmcCopy(work);

		let attempts = [];
		if (useHosted && preferHosted) {
			attempts.push('hosted');
		}
		if (resolvers.length) {
			attempts.push('links');
		}
		if (pmc) {
			attempts.push('europepmc');
		}
		if (useHosted && !preferHosted) {
			attempts.push('hosted');
		}

		if (!attempts.length) {
			return {
				attached: false,
				message: ZoteroOpenAlex.getString('openalex-pdf-result-no-fulltext')
			};
		}

		let lastError = null;
		for (let attempt of attempts) {
			try {
				if (attempt === 'hosted') {
					progress.processing(item,
						ZoteroOpenAlex.getString('openalex-pdf-result-downloading-hosted'));
					let attachment = await this._attachHostedPDF(item, work);
					if (attachment) {
						return {
							attached: true,
							message: ZoteroOpenAlex.getString('openalex-pdf-result-attached-hosted')
						};
					}
				}
				else if (attempt === 'europepmc') {
					progress.processing(item, 'Europe PMC');
					let attachment = await this._attachEuropePMCPDF(item, pmc);
					if (attachment) {
						return {
							attached: true,
							message: ZoteroOpenAlex.getString('openalex-pdf-result-attached-link')
						};
					}
				}
				else {
					let attachment = await Zotero.Attachments.addFileFromURLs(item, resolvers, {
						onAccessMethodStart: (accessMethod) => {
							progress.processing(item, accessMethod || '');
						}
					});
					if (attachment) {
						return {
							attached: true,
							message: ZoteroOpenAlex.getString('openalex-pdf-result-attached-link')
						};
					}
				}
			}
			catch (e) {
				// A rejected key or exhausted credits means the hosted source is unusable
				// for the rest of this run, but publisher links may still work
				if (attempt === 'hosted'
						&& (e.openAlexCode === 'auth' || e.openAlexCode === 'rate-limit')) {
					hostedState.enabled = false;
					hostedState.disabledReason = this._describeError(e);
					ZoteroOpenAlex.log('Disabling OpenAlex-hosted downloads: ' + e.message);
				}
				Zotero.logError(e);
				lastError = e;
			}
		}

		return {
			attached: false,
			message: lastError
				? this._describeError(lastError)
				: ZoteroOpenAlex.getString('openalex-pdf-result-not-downloaded')
		};
	},

	/**
	 * Download from content.openalex.org ourselves rather than going through
	 * Zotero's URL resolvers, so that the authenticated URL is never persisted on
	 * the attachment item. The item records the plain, key-free URL instead.
	 */
	_attachHostedPDF(item, work) {
		return this._attachDownloadedPDF(item, Zotero.getString('attachment.fullText'),
			path => ZoteroOpenAlex.API.downloadHostedPDF(work, path));
	},

	/**
	 * Europe PMC's mirror of PubMed Central, tried once Zotero's downloader has given
	 * up on the links. OpenAlex mostly lists a PMC copy with a landing page and no
	 * pdf_url, and Zotero finds nothing on that page because NCBI answers it with a
	 * browser check. The PMCID is exact, so Europe PMC can be asked for the PDF by ID.
	 *
	 * PMC's own PDF address is deliberately not built the same way: its copyright
	 * notice prohibits systematic downloading from the PMC website.
	 *
	 * We download it ourselves because of how Europe PMC misbehaves. It answers
	 * HTTP 500 for most NIH author manuscripts, which Zotero's downloader retries with
	 * a growing delay, long enough on older versions to stall the run. And it
	 * throttles hard, which the downloader treats as one more failed link.
	 *
	 * @return {Promise<Zotero.Item|null>} the attachment, or null without a PDF
	 */
	_attachEuropePMCPDF(item, pmc) {
		return this._attachDownloadedPDF(item, this._titleForVersion(pmc.version),
			path => this._downloadEuropePMCPDF(pmc.id, path));
	},

	/**
	 * @return {Promise<String|null>} the URL the file came from, or null without a PDF
	 * @throws when Europe PMC keeps throttling, with a message for the item's row
	 */
	async _downloadEuropePMCPDF(pmcid, path) {
		let api = ZoteroOpenAlex.API;
		let url = `https://europepmc.org/api/getPdf?pmcid=${pmcid}`;
		let retries = this._europePMCThrottled ? 0 : this.EUROPE_PMC_RETRIES;
		let xhr;
		for (let attempt = 0; ; attempt++) {
			try {
				xhr = await Zotero.HTTP.request('GET', url, {
					responseType: 'arraybuffer',
					timeout: 120000,
					successCodes: false,
					errorDelayMax: 0
				});
			}
			catch (e) {
				ZoteroOpenAlex.log(`Europe PMC request failed for ${pmcid}: ${e}`);
				return null;
			}
			if (xhr.status !== 429 || attempt >= retries) {
				break;
			}
			let retryAfter = parseInt(xhr.getResponseHeader('Retry-After'), 10);
			if (!(retryAfter > 0) || retryAfter > 30) {
				retryAfter = 10;
			}
			ZoteroOpenAlex.log(`Europe PMC is throttling; retrying in ${retryAfter}s`);
			await api.delay(retryAfter * 1000);
		}

		// Its limit can outlast the wait it asks for. One item paying for that is
		// enough: the rest of the run tries once each, and a later run gets the others
		this._europePMCThrottled = xhr.status === 429;
		if (xhr.status === 429) {
			throw api.error('europepmc-throttled',
				ZoteroOpenAlex.getString('openalex-pdf-error-europepmc-throttled'), 429);
		}

		let bytes = xhr.status === 200 ? new Uint8Array(xhr.response) : null;
		if (!bytes || !api.looksLikePDF(bytes)) {
			ZoteroOpenAlex.log(`Europe PMC has no PDF to give for ${pmcid} (HTTP ${xhr.status})`);
			return null;
		}
		await IOUtils.write(path, bytes);
		return url;
	},

	/**
	 * Attach a PDF that we fetch ourselves instead of leaving it to Zotero's downloader.
	 *
	 * @param {Zotero.Item} item
	 * @param {String} title - attachment title
	 * @param {Function} download - async (path) => URL to record on the attachment
	 *     once the PDF is written to `path`, or null when there is none
	 * @return {Promise<Zotero.Item|null>}
	 */
	async _attachDownloadedPDF(item, title, download) {
		let tempDir = (await Zotero.Attachments.createTemporaryStorageDirectory()).path;
		let tempPath = PathUtils.join(tempDir, 'openalex.pdf');

		let attachment = null;
		try {
			let url = await download(tempPath);
			if (!url) {
				return null;
			}
			attachment = await Zotero.Attachments.importFromFile({
				file: tempPath,
				parentItemID: item.id,
				title,
				contentType: 'application/pdf',
				fileBaseName: Zotero.Attachments.getFileBaseNameFromItem(item, {
					attachmentTitle: title
				}),
				moveFile: true
			});
			if (attachment) {
				attachment.setField('url', url);
				attachment.setField('accessDate', 'CURRENT_TIMESTAMP');
				await attachment.saveTx();
			}
		}
		finally {
			await IOUtils.remove(tempDir, { recursive: true, ignoreAbsent: true });
		}

		return attachment;
	},

	/** The titles Zotero's own downloader gives: "Accepted Version", "Full Text"… */
	_titleForVersion(version) {
		let name = { acceptedVersion: 'acceptedVersion', submittedVersion: 'submittedVersion' }[version];
		return Zotero.getString('attachment.' + (name || 'fullText'));
	},

	/**
	 * Turn a work's locations into resolvers for Zotero's downloader, best first.
	 *
	 * Direct PDF links come before landing pages, published versions before
	 * preprints, open access before paywalled. Paywalled landing pages are kept at
	 * the end because Zotero uses the browser's cookies and may well get through.
	 */
	_buildURLResolvers(work, arXivWork = null) {
		let entries = [];
		let seen = new Set();

		let locations = [work.best_oa_location, ...(work.locations || []), work.primary_location];
		if (arXivWork && arXivWork !== work) {
			locations.push(...arXivWork.locations);
		}
		if (work.open_access && work.open_access.oa_url) {
			locations.push({
				pdf_url: work.open_access.oa_url,
				is_oa: true,
				version: work.best_oa_location && work.best_oa_location.version
			});
		}

		for (let location of locations) {
			if (!location) {
				continue;
			}
			let sourceName = (location.source && location.source.display_name) || 'OpenAlex';
			let rank = this._locationRank(location);

			if (location.pdf_url && !seen.has(location.pdf_url)) {
				seen.add(location.pdf_url);
				entries.push({
					rank,
					url: location.pdf_url,
					pageURL: location.landing_page_url || undefined,
					accessMethod: sourceName,
					articleVersion: location.version
				});
			}
			else if (location.landing_page_url && !seen.has(location.landing_page_url)) {
				seen.add(location.landing_page_url);
				// No direct PDF: hand Zotero the page and let its translators look
				entries.push({
					rank: rank + 5,
					pageURL: location.landing_page_url,
					accessMethod: sourceName,
					articleVersion: location.version
				});
			}
		}

		entries.sort((a, b) => a.rank - b.rank);
		return entries.slice(0, this.MAX_RESOLVERS).map(entry => ({
			url: entry.url,
			pageURL: entry.pageURL,
			accessMethod: entry.accessMethod,
			articleVersion: entry.articleVersion
		}));
	},

	/** Lower is better: open access before paywalled, then by version. */
	_locationRank(location) {
		return (location.is_oa ? 0 : 100)
			+ (this.VERSION_RANK[location.version] !== undefined
				? this.VERSION_RANK[location.version]
				: 3) * 10;
	},

	/**
	 * The work's PubMed Central copy as `{ id: 'PMC7315193', is_oa, version }`, or null.
	 * With several PMC locations, the best-ranked one.
	 *
	 * OpenAlex writes the ID with its prefix in location URLs and without it in
	 * `ids.pmcid` ("https://www.ncbi.nlm.nih.gov/pmc/articles/7315193").
	 */
	_pmcCopy(work) {
		const PMC_URL = /\b(?:ncbi\.nlm\.nih\.gov|europepmc\.org)\/(?:pmc\/)?articles\/(?:pmc)?(\d+)/i;
		let best = null;
		for (let location of work.locations || []) {
			if (!location) {
				continue;
			}
			let match = PMC_URL.exec(location.landing_page_url || '')
				|| PMC_URL.exec(location.pdf_url || '');
			if (!match) {
				continue;
			}
			let copy = { id: 'PMC' + match[1], is_oa: !!location.is_oa, version: location.version };
			if (!best || this._locationRank(copy) < this._locationRank(best)) {
				best = copy;
			}
		}
		if (best) {
			return best;
		}
		// Known by ID only, so nothing says which version PMC holds
		let match = /(?:^|\/)(?:pmc)?(\d+)\/?\s*$/i.exec((work.ids && work.ids.pmcid) || '');
		return match ? { id: 'PMC' + match[1], is_oa: true, version: undefined } : null;
	},

	async _saveWorkID(item, work) {
		let id = ZoteroOpenAlex.API.shortWorkID(work);
		if (!id) {
			return;
		}
		let extra = item.getField('extra') || '';
		if (new RegExp('^\\s*OpenAlex\\s*:\\s*' + id + '\\s*$', 'im').test(extra)) {
			return;
		}
		// Replace any stale OpenAlex line rather than stacking them up
		let lines = extra.split('\n').filter(line => !/^\s*OpenAlex\s*:/i.test(line));
		lines.push('OpenAlex: ' + id);
		item.setField('extra', lines.join('\n').trim());
		await item.saveTx();
	},

	_describeError(e) {
		switch (e && e.openAlexCode) {
			case 'auth':
				return ZoteroOpenAlex.getString('openalex-pdf-error-auth');
			case 'rate-limit':
				return ZoteroOpenAlex.getString('openalex-pdf-error-rate-limit');
			case 'offline':
				return ZoteroOpenAlex.getString('openalex-pdf-error-offline');
			default:
				return (e && e.message) || ZoteroOpenAlex.getString('openalex-pdf-error-unexpected');
		}
	}
};
