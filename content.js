/**
 * Letterboxd Companion (Watchlist Picker & Diary Stats)
 * Authentic Letterboxd Design • Cross-browser (Chrome, Safari, Firefox, Edge, Brave)
 */

(function () {
    'use strict';

    if (window.__LETTERBOXD_RND_INITIALIZED__) return;
    window.__LETTERBOXD_RND_INITIALIZED__ = true;

    // Global state
    const posterGridCache = new Map(); // baseUrl -> films of a watchlist / list
    let currentPickerMovies = []; // films the roulette currently draws from
    let currentPickerPool = 'all'; // 'all' or 'common' (only films also in my watchlist)
    let isFetching = false;
    let isSpinning = false;
    let audioCtx = null;
    let soundEnabled = localStorage.getItem('lbrnd_sound') !== 'false';
    let currentWinnerIndex = -1;

    /**
     * Sound preference shared with the popup through extension storage
     * (the popup's localStorage lives on the extension origin, not on letterboxd.com)
     */
    const extStorage = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) ? chrome.storage.local : null;

    function applySoundSetting(enabled) {
        soundEnabled = enabled;
        localStorage.setItem('lbrnd_sound', enabled ? 'true' : 'false');
        const icon = document.getElementById('lbrnd-sound-icon');
        if (icon) icon.textContent = enabled ? '🔊' : '🔇';
    }

    if (extStorage) {
        extStorage.get('lbrnd_sound', (res) => {
            if (res && typeof res.lbrnd_sound === 'boolean') applySoundSetting(res.lbrnd_sound);
        });
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.lbrnd_sound && typeof changes.lbrnd_sound.newValue === 'boolean') {
                applySoundSetting(changes.lbrnd_sound.newValue);
            }
        });
    }

    // Strict immutable layout dimensions
    const CARD_WIDTH = 140;
    const CARD_MARGIN_EACH = 6; // 6px left + 6px right
    const TOTAL_CARD_WIDTH = CARD_WIDTH + (CARD_MARGIN_EACH * 2); // 152px
    const REEL_SIZE = 70;
    const WINNER_INDEX = 54;
    const SPIN_DURATION_MS = 5200;

    /**
     * Web Audio API Synthesizer (Zero external assets)
     */
    function getAudioContext() {
        if (!audioCtx) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass) {
                audioCtx = new AudioContextClass();
            }
        }
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        return audioCtx;
    }

    function playTickSound() {
        if (!soundEnabled) return;
        const ctx = getAudioContext();
        if (!ctx) return;

        try {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(650 + Math.random() * 100, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.025);

            gain.gain.setValueAtTime(0.15, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.025);

            osc.connect(gain);
            gain.connect(ctx.destination);

            osc.start();
            osc.stop(ctx.currentTime + 0.03);
        } catch (e) {}
    }

    function playWinFanfare() {
        if (!soundEnabled) return;
        const ctx = getAudioContext();
        if (!ctx) return;

        try {
            const chord = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
            chord.forEach((freq, i) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.06);

                gain.gain.setValueAtTime(0, ctx.currentTime + i * 0.06);
                gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + i * 0.06 + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.06 + 0.45);

                osc.connect(gain);
                gain.connect(ctx.destination);

                osc.start(ctx.currentTime + i * 0.06);
                osc.stop(ctx.currentTime + i * 0.06 + 0.5);
            });
        } catch (e) {}
    }

    /**
     * URL validation & picker context (watchlists and lists)
     * Examples:
     * - /antrubtor/watchlist/
     * - /antrubtor/watchlist/genre/horror/page/2/
     * - /dave/list/oscars-2027-priority-watchlist/
     * - /dave/list/oscars-2027-priority-watchlist/detail/by/name/
     */
    function isPickablePage() {
        return getPickerContext() !== null;
    }

    function getPickerContext() {
        const path = window.location.pathname;

        const watchlist = path.match(/^\/([^\/]+)\/watchlist(\/.*)?$/i);
        if (watchlist) {
            return {
                type: 'watchlist',
                username: watchlist[1],
                baseUrl: `/${watchlist[1]}/watchlist${cleanPickerSubpath(watchlist[2])}`
            };
        }

        const list = path.match(/^\/([^\/]+)\/list\/([^\/]+)(\/.*)?$/i);
        if (list && !/^\/(?:edit|share)(?:\/|$)/i.test(list[3] || '')) {
            return {
                type: 'list',
                username: list[1],
                baseUrl: `/${list[1]}/list/${list[2]}${cleanPickerSubpath(list[3])}`
            };
        }

        return null;
    }

    // Keeps filters (/genre/horror/, /by/name/...) but drops pagination and the list "detail" layout
    function cleanPickerSubpath(subpath) {
        let clean = (subpath || '/').replace(/\/page\/\d+\/?/i, '/').replace(/\/detail(?=\/|$)/i, '');
        if (!clean.startsWith('/')) clean = '/' + clean;
        if (!clean.endsWith('/')) clean += '/';
        return clean;
    }

    /**
     * URL builder for page N of a paginated listing, following the pagination links' own pattern:
     * /dave/diary/ paginates as /dave/diary/films/page/2/, not /dave/diary/page/2/
     */
    function pageUrlFor(doc, baseUrl) {
        const href = doc.querySelector('.pagination a[href*="/page/"]')?.getAttribute('href');
        if (href && /\/page\/\d+\/?/.test(href)) {
            return (n) => href.replace(/\/page\/\d+\/?/, `/page/${n}/`);
        }
        return (n) => `${baseUrl}page/${n}/`;
    }

    /**
     * Fetch a Letterboxd page and parse it (same-origin, with the user's session).
     * Network errors, 403, 429 and 5xx are retried with a growing delay (1 s, 2 s, 4 s): Letterboxd
     * answers bursts of parallel page requests with an occasional 403. Other errors (404...) fail right away.
     */
    const FETCH_RETRY_DELAYS_MS = [1000, 2000, 4000];

    async function fetchDocument(url) {
        for (let attempt = 0; ; attempt++) {
            let res = null;
            try {
                res = await fetch(url, { credentials: 'same-origin' });
            } catch (err) {
                if (attempt >= FETCH_RETRY_DELAYS_MS.length) throw err;
            }

            if (res) {
                if (res.ok) return new DOMParser().parseFromString(await res.text(), 'text/html');
                const retryable = res.status === 403 || res.status === 429 || res.status >= 500;
                if (!retryable || attempt >= FETCH_RETRY_DELAYS_MS.length) throw new Error(`HTTP ${res.status}`);
            }

            // Honour Retry-After (seconds) when the server sends one, within reason
            const retryAfter = parseInt(res?.headers.get('Retry-After'), 10);
            const delay = retryAfter > 0 ? Math.min(retryAfter * 1000, 15000) : FETCH_RETRY_DELAYS_MS[attempt];
            await new Promise(r => setTimeout(r, delay));
        }
    }

    /**
     * Constructs the standard Letterboxd CDN poster URL (a.ltrbxd.com)
     */
    function buildCdnPosterUrl(filmId, slug, cacheKey) {
        if (!filmId || !slug) return '';
        const cleanSlug = slug.replace(/^\/film\//, '').replace(/\/$/, '');
        const digits = filmId.toString().split('').join('/');
        const query = cacheKey ? `?v=${cacheKey}` : '';
        return `https://a.ltrbxd.com/resized/film-poster/${digits}/${filmId}-${cleanSlug}-0-230-0-345-crop.jpg${query}`;
    }

    /**
     * Dynamic Letterboxd native resolver for custom / TMDb uploaded posters
     */
    async function resolveCustomPosterUrl(slug, cacheKey) {
        if (!slug) return '';
        try {
            const cleanSlug = slug.startsWith('/film/') ? slug : `/film/${slug}/`;
            const query = cacheKey ? `?k=${cacheKey}` : '';
            const res = await fetch(`https://letterboxd.com${cleanSlug}poster/std/230/${query}`, { credentials: 'same-origin' });
            if (!res.ok) return '';
            const data = await res.json();
            return data.url2x || data.url || '';
        } catch (e) {
            return '';
        }
    }

    /**
     * Film extraction from a poster grid page (watchlist grid or list poster-list)
     */
    function extractMoviesFromDoc(doc) {
        const movies = [];
        const listItems = doc.querySelectorAll('ul.grid li.griditem, ul.poster-list li.posteritem, ul.poster-list li.poster-container, ul.poster-list li.listitem, li.griditem');

        listItems.forEach(li => {
            const lazyDiv = li.querySelector('.react-component[data-component-class="LazyPoster"]') || (li.classList.contains('react-component') ? li : null);
            const posterDiv = li.querySelector('.film-poster') || (li.classList.contains('film-poster') ? li : null);
            const img = li.querySelector('img');

            let slug = '';
            let name = '';
            let year = '';
            let filmId = '';
            let cacheKey = '';
            let poster = '';

            if (lazyDiv) {
                slug = lazyDiv.getAttribute('data-item-slug') ||
                       lazyDiv.getAttribute('data-target-link') ||
                       lazyDiv.getAttribute('data-item-link') || '';
                name = lazyDiv.getAttribute('data-item-name') ||
                       lazyDiv.getAttribute('data-item-full-display-name') || '';

                const idAttr = lazyDiv.getAttribute('data-postered-identifier') || lazyDiv.getAttribute('data-resolvable-poster-path') || '';
                const uidMatch = idAttr.match(/film:(\d+)/);
                if (uidMatch) filmId = uidMatch[1];

                const keyMatch = idAttr.match(/cacheBustingKey["']:["']([a-zA-Z0-9]+)["']/);
                if (keyMatch) cacheKey = keyMatch[1];
            }

            if (posterDiv) {
                if (!slug) {
                    slug = posterDiv.getAttribute('data-target-link') ||
                           posterDiv.getAttribute('data-film-slug') ||
                           posterDiv.getAttribute('data-film-link') || '';
                }
                if (!name) name = posterDiv.getAttribute('data-film-name') || '';
                if (!year) year = posterDiv.getAttribute('data-film-release-year') || '';
                if (!filmId) filmId = posterDiv.getAttribute('data-film-id') || '';
            }

            if (img) {
                if (!name) name = img.getAttribute('alt') || '';
                const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
                if (srcset) {
                    const parts = srcset.split(',').map(s => s.trim());
                    const last = parts[parts.length - 1].split(' ')[0];
                    if (last && !last.includes('empty-poster') && last.startsWith('http')) {
                        poster = last;
                    }
                }
                if (!poster) {
                    const src = img.getAttribute('src');
                    if (src && !src.includes('empty-poster') && src.startsWith('http') && !src.startsWith('data:')) {
                        poster = src;
                    }
                }
            }

            if (!slug) {
                const link = li.querySelector('a.frame, a.film-poster, a[data-target-link], a');
                if (link) slug = link.getAttribute('href') || link.getAttribute('data-target-link') || '';
            }

            if (name) {
                const yearMatch = name.match(/\((\d{4})\)/);
                if (yearMatch) {
                    if (!year) year = yearMatch[1];
                    name = name.replace(/\s*\(\d{4}\)\s*$/, '').trim();
                }
            }

            if (slug) {
                slug = slug.replace(/^\/?/, '/');
                if (!slug.startsWith('/film/')) slug = `/film${slug}`;
                if (!slug.endsWith('/')) slug = `${slug}/`;
            }

            if (!poster && filmId && slug) {
                poster = buildCdnPosterUrl(filmId, slug, cacheKey);
            }

            if (slug && slug !== '/film/#/' && slug !== '/film//') {
                movies.push({
                    name: name || slug.replace(/\/film\//g, '').replace(/[-/]/g, ' ').trim(),
                    year: year || '',
                    slug: slug,
                    filmId: filmId || '',
                    cacheKey: cacheKey || '',
                    poster: poster || '',
                    link: `https://letterboxd.com${slug}`
                });
            }
        });

        return movies;
    }

    /**
     * Detect total pages from pagination
     */
    function detectTotalPages(doc) {
        const paginatePages = doc.querySelectorAll('.paginate-pages li.paginate-page a, .paginate-pages a');
        let maxPage = 1;

        paginatePages.forEach(link => {
            const txt = link.textContent.trim();
            const num = parseInt(txt, 10);
            if (!isNaN(num) && num > maxPage) {
                maxPage = num;
            }
        });

        const lastLink = doc.querySelector('.paginate-pages ul li:last-child a');
        if (lastLink) {
            const hrefMatch = lastLink.getAttribute('href')?.match(/\/page\/(\d+)\//);
            if (hrefMatch) {
                const num = parseInt(hrefMatch[1], 10);
                if (!isNaN(num) && num > maxPage) maxPage = num;
            }
        }

        return maxPage;
    }

    /**
     * Fetch every film of a paginated poster grid (watchlist or list) with concurrency batching
     */
    async function fetchPosterGrid(baseUrl, onProgress) {
        if (posterGridCache.has(baseUrl)) {
            return posterGridCache.get(baseUrl);
        }

        const firstDoc = await fetchDocument(baseUrl);
        const totalPages = detectTotalPages(firstDoc);
        const pageUrl = pageUrlFor(firstDoc, baseUrl);
        let allMovies = extractMoviesFromDoc(firstDoc);
        onProgress?.(1, totalPages, allMovies.length);

        const BATCH_SIZE = 5;
        for (let p = 2; p <= totalPages; p += BATCH_SIZE) {
            const batch = [];
            for (let n = p; n < p + BATCH_SIZE && n <= totalPages; n++) batch.push(n);

            const results = await Promise.all(batch.map(n =>
                fetchDocument(pageUrl(n)).then(extractMoviesFromDoc).catch(() => [])
            ));
            results.forEach(pageMovies => {
                allMovies = allMovies.concat(pageMovies);
            });

            onProgress?.(Math.min(p + BATCH_SIZE - 1, totalPages), totalPages, allMovies.length);
        }

        // Strict deduplication by slug
        const seen = new Set();
        const uniqueMovies = [];
        for (const m of allMovies) {
            if (m.slug && !seen.has(m.slug)) {
                seen.add(m.slug);
                uniqueMovies.push(m);
            }
        }

        posterGridCache.set(baseUrl, uniqueMovies);
        return uniqueMovies;
    }

    /**
     * Fetch rich metadata for winner movie
     */
    async function fetchFilmDetails(film) {
        if (!film || !film.link || film.link.endsWith('#')) return film;

        try {
            const res = await fetch(film.link, { credentials: 'same-origin' });
            if (!res.ok) return film;
            const html = await res.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');

            let title = film.name;
            let poster = film.poster;
            let description = '';
            let actors = [];
            let directors = [];
            let year = film.year;
            let rating = '';

            // 1. JSON-LD Schema.org
            const ldScript = doc.querySelector('script[type="application/ld+json"]');
            if (ldScript) {
                try {
                    let text = ldScript.textContent;
                    text = text.replace(/^\s*\/\*\s*<!\[CDATA\[\s*\*\//, '').replace(/\/\*\s*\]\]>\s*\*\/\s*$/, '');
                    const data = JSON.parse(text);
                    const movieData = Array.isArray(data) ? data.find(d => d['@type'] === 'Movie') : (data['@type'] === 'Movie' ? data : data);

                    if (movieData) {
                        if (movieData.name) title = movieData.name;
                        if (movieData.image) poster = movieData.image;
                        if (movieData.description) description = movieData.description;
                        if (movieData.dateCreated || movieData.releasedEvent) {
                            const dateStr = movieData.dateCreated || (Array.isArray(movieData.releasedEvent) ? movieData.releasedEvent[0]?.startDate : movieData.releasedEvent?.startDate);
                            if (dateStr) year = dateStr.substring(0, 4);
                        }
                        if (movieData.actor) {
                            const actList = Array.isArray(movieData.actor) ? movieData.actor : [movieData.actor];
                            actors = actList.map(a => typeof a === 'string' ? a : a.name).filter(Boolean);
                        }
                        if (movieData.director) {
                            const dirList = Array.isArray(movieData.director) ? movieData.director : [movieData.director];
                            directors = dirList.map(d => typeof d === 'string' ? d : d.name).filter(Boolean);
                        }
                        if (movieData.aggregateRating?.ratingValue) {
                            rating = Number(movieData.aggregateRating.ratingValue).toFixed(1);
                        }
                    }
                } catch (jsonErr) {}
            }

            // 2. Poster fallback via dynamic resolver or OpenGraph
            if (!poster || poster.includes('empty-poster')) {
                const customUrl = await resolveCustomPosterUrl(film.slug, film.cacheKey);
                if (customUrl) {
                    poster = customUrl;
                } else {
                    const ogImg = doc.querySelector('meta[property="og:image"]');
                    if (ogImg && ogImg.getAttribute('content') && !ogImg.getAttribute('content').includes('empty-poster')) {
                        poster = ogImg.getAttribute('content');
                    }
                }
            }

            // 3. Metadata fallbacks
            if (!description) {
                const synopsisEl = doc.querySelector('.truncate p, .review.body-text, meta[name="description"]');
                if (synopsisEl) {
                    description = synopsisEl.tagName === 'META' ? synopsisEl.getAttribute('content') : synopsisEl.textContent.trim();
                }
            }

            if (actors.length === 0) {
                doc.querySelectorAll('.cast-list a.text-slug, #tab-cast a.text-slug, .cast-list a').forEach((el, idx) => {
                    if (idx < 8) actors.push(el.textContent.trim());
                });
            }

            if (directors.length === 0) {
                doc.querySelectorAll('.crew-list a[href*="/director/"], a[href*="/director/"]').forEach(el => {
                    const name = el.textContent.trim();
                    if (name && !directors.includes(name)) directors.push(name);
                });
            }

            if (!rating) {
                const ratingEl = doc.querySelector('.average-rating a, meta[name="twitter:data2"]');
                if (ratingEl) {
                    const rText = ratingEl.tagName === 'META' ? ratingEl.getAttribute('content') : ratingEl.textContent.trim();
                    const match = rText.match(/(\d+(\.\d+)?)/);
                    if (match) rating = match[1];
                }
            }

            return {
                ...film,
                name: title,
                poster: poster,
                description: description || "No synopsis available for this film.",
                actors: actors.slice(0, 10),
                directors: directors,
                year: year || film.year,
                rating: rating || ''
            };
        } catch (e) {
            return film;
        }
    }

    /**
     * Minimalist SVG Dice Icon
     */
    const SVG_DICE_ICON = `
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
            <rect x="3" y="3" width="18" height="18" rx="3.5" stroke="#99aabb" stroke-width="1.8" fill="#14181c"/>
            <circle cx="7.5" cy="7.5" r="1.4" fill="#00e054"/>
            <circle cx="16.5" cy="7.5" r="1.4" fill="#ff8000"/>
            <circle cx="12" cy="12" r="1.4" fill="#ffffff"/>
            <circle cx="7.5" cy="16.5" r="1.4" fill="#40bcf4"/>
            <circle cx="16.5" cy="16.5" r="1.4" fill="#00e054"/>
        </svg>
    `;

    /**
     * Floating Action Button injection
     */
    function injectFloatingButton() {
        if (document.getElementById('lbrnd-dice-btn')) return;
        if (!isPickablePage()) return;

        const btn = document.createElement('button');
        btn.id = 'lbrnd-dice-btn';
        btn.setAttribute('aria-label', 'Pick a random film');
        btn.innerHTML = `
            ${SVG_DICE_ICON}
            <div id="lbrnd-dice-tooltip">Pick random film</div>
        `;

        btn.addEventListener('click', () => {
            getAudioContext();
            openPickerModal();
        });

        document.body.appendChild(btn);
    }

    /**
     * Modal Dialog injection
     */
    function injectModal() {
        if (document.getElementById('lbrnd-modal-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'lbrnd-modal-overlay';
        overlay.innerHTML = `
            <div id="lbrnd-modal-container">
                <div class="lbrnd-modal-header">
                    <div class="lbrnd-header-title-box">
                        <div class="lbrnd-letterboxd-dots">
                            <span class="lbrnd-dot lbrnd-dot-orange"></span>
                            <span class="lbrnd-dot lbrnd-dot-green"></span>
                            <span class="lbrnd-dot lbrnd-dot-cyan"></span>
                        </div>
                        <div>
                            <h3 class="lbrnd-header-title">Random Selection</h3>
                            <p class="lbrnd-header-subtitle" id="lbrnd-header-sub">Loading watchlist...</p>
                        </div>
                    </div>
                    <div class="lbrnd-header-controls">
                        <select class="lbst-year-select" id="lbrnd-pool-select" title="Films to pick from" style="display: none;">
                            <option value="all">All films</option>
                            <option value="common">In common with my watchlist</option>
                        </select>
                        <button class="lbrnd-btn-icon" id="lbrnd-sound-toggle" title="Toggle sound">
                            <span id="lbrnd-sound-icon">${soundEnabled ? '🔊' : '🔇'}</span>
                        </button>
                        <button class="lbrnd-btn-icon" id="lbrnd-modal-close" title="Close (Esc)">✕</button>
                    </div>
                </div>

                <!-- 1. Loading State -->
                <div id="lbrnd-loading-state">
                    <div class="lbrnd-spinner"></div>
                    <div class="lbrnd-loading-text" id="lbrnd-loading-status">Indexing watchlist...</div>
                    <div class="lbrnd-progress-bar-wrap">
                        <div class="lbrnd-progress-bar-fill" id="lbrnd-progress-fill"></div>
                    </div>
                </div>

                <!-- 2. Carousel Roulette View -->
                <div id="lbrnd-roulette-view" style="display: none;">
                    <div class="lbrnd-case-viewport">
                        <div class="lbrnd-center-pointer"></div>
                        <div class="lbrnd-reel-track" id="lbrnd-reel-track"></div>
                    </div>
                </div>

                <!-- 3. Final Movie Reveal View -->
                <div id="lbrnd-reveal-view" style="display: none;">
                    <div class="lbrnd-winner-layout">
                        <div class="lbrnd-winner-poster-box">
                            <img class="lbrnd-winner-poster" id="lbrnd-reveal-poster" src="" alt="Poster" />
                            <div class="lbrnd-winner-poster-fallback" id="lbrnd-reveal-poster-fallback" style="display: none;">
                                <svg viewBox="0 0 24 24" width="40" height="40" fill="#445566"><path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/></svg>
                                <span id="lbrnd-reveal-fallback-title"></span>
                            </div>
                        </div>
                        <div class="lbrnd-winner-details">
                            <div class="lbrnd-meta-tags">
                                <span class="lbrnd-tag-year" id="lbrnd-reveal-year">2024</span>
                                <span class="lbrnd-tag-rating" id="lbrnd-reveal-rating">★ 4.2</span>
                            </div>
                            <h2 class="lbrnd-winner-title" id="lbrnd-reveal-title">Movie Title</h2>
                            <p class="lbrnd-winner-director" id="lbrnd-reveal-director">Directed by <strong>Name</strong></p>

                            <div class="lbrnd-synopsis-section">
                                <div class="lbrnd-section-label">Synopsis</div>
                                <p class="lbrnd-synopsis-text" id="lbrnd-reveal-synopsis">Loading synopsis...</p>
                            </div>

                            <div class="lbrnd-cast-section" id="lbrnd-cast-container">
                                <div class="lbrnd-section-label">Cast</div>
                                <div class="lbrnd-cast-chips" id="lbrnd-reveal-cast"></div>
                            </div>

                            <div class="lbrnd-actions-row">
                                <a class="lbrnd-btn-primary" id="lbrnd-reveal-link" href="#" target="_blank" rel="noopener noreferrer">
                                    View on Letterboxd
                                </a>
                                <button class="lbrnd-btn-secondary" id="lbrnd-reroll-btn">
                                    <svg viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
                                    Roll again
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        document.getElementById('lbrnd-modal-close').addEventListener('click', closeModal);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay && !isSpinning) closeModal();
        });

        const soundBtn = document.getElementById('lbrnd-sound-toggle');
        soundBtn.addEventListener('click', () => {
            applySoundSetting(!soundEnabled);
            extStorage?.set({ lbrnd_sound: soundEnabled });
        });

        document.getElementById('lbrnd-reroll-btn').addEventListener('click', () => {
            if (!isSpinning && currentPickerMovies.length > 0) {
                startRoulette(currentPickerMovies);
            }
        });

        document.getElementById('lbrnd-pool-select').addEventListener('change', (e) => {
            currentPickerPool = e.target.value;
            loadAndSpin();
        });

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.classList.contains('active') && !isSpinning) {
                closeModal();
            }
        });

        // Window resize handler: strict center alignment
        window.addEventListener('resize', () => {
            if (!isSpinning && currentWinnerIndex >= 0) {
                const track = document.getElementById('lbrnd-reel-track');
                if (track && track.children.length > currentWinnerIndex) {
                    const exactTargetOffset = (currentWinnerIndex * TOTAL_CARD_WIDTH) + CARD_MARGIN_EACH + (CARD_WIDTH / 2);
                    track.style.transition = 'none';
                    track.style.transform = `translateX(-${exactTargetOffset}px)`;
                }
            }
        });
    }

    function openPickerModal() {
        injectModal();
        const overlay = document.getElementById('lbrnd-modal-overlay');
        overlay.classList.add('active');

        const ctx = getPickerContext();
        document.getElementById('lbrnd-header-sub').textContent = ctx
            ? (ctx.type === 'list' ? `List by @${ctx.username}` : `Watchlist of @${ctx.username}`)
            : 'Letterboxd';

        // "Common" pool: someone else's watchlist (films you both want to see) or any list
        // (its films that are in your watchlist). Needs to know who is logged in.
        const poolSelect = document.getElementById('lbrnd-pool-select');
        const me = getLoggedInUsername();
        const commonAllowed = !!(ctx && me && !(ctx.type === 'watchlist' && ctx.username.toLowerCase() === me));
        if (!commonAllowed) currentPickerPool = 'all';
        poolSelect.style.display = commonAllowed ? 'block' : 'none';
        poolSelect.querySelector('option[value="common"]').textContent = ctx && ctx.type === 'list'
            ? 'Only films in my watchlist'
            : 'In common with my watchlist';
        poolSelect.value = currentPickerPool;

        loadAndSpin();
    }

    function closeModal() {
        const overlay = document.getElementById('lbrnd-modal-overlay');
        if (overlay) {
            overlay.classList.remove('active');
        }
    }

    async function loadAndSpin() {
        if (isFetching || isSpinning) return;

        const loadingView = document.getElementById('lbrnd-loading-state');
        const rouletteView = document.getElementById('lbrnd-roulette-view');
        const revealView = document.getElementById('lbrnd-reveal-view');
        const statusText = document.getElementById('lbrnd-loading-status');
        const progressFill = document.getElementById('lbrnd-progress-fill');

        const ctx = getPickerContext();
        if (!ctx) return;
        const sourceLabel = ctx.type === 'list' ? 'list' : 'watchlist';
        const poolSelect = document.getElementById('lbrnd-pool-select');

        loadingView.style.display = 'flex';
        loadingView.classList.remove('is-message');
        rouletteView.style.display = 'none';
        revealView.style.display = 'none';
        progressFill.style.width = '10%';

        isFetching = true;
        poolSelect.disabled = true;

        const progressFor = (label) => (loaded, total, count) => {
            const percent = Math.round((loaded / total) * 100);
            progressFill.style.width = `${Math.max(10, percent)}%`;
            statusText.textContent = `Indexing ${label}... (${count} films • Page ${loaded}/${total})`;
        };

        // Final message instead of a roulette: stop the spinner and progress bar
        const showMessage = (text) => {
            statusText.textContent = text;
            loadingView.classList.add('is-message');
        };

        try {
            let movies = await fetchPosterGrid(ctx.baseUrl, progressFor(sourceLabel));
            let subtitle = `${movies.length.toLocaleString('en-US')} films in ${sourceLabel}`;

            if (movies.length > 0 && currentPickerPool === 'common') {
                const me = getLoggedInUsername();
                progressFill.style.width = '10%';
                const myWatchlist = await fetchPosterGrid(`/${me}/watchlist/`, progressFor('your watchlist'));
                const mySlugs = new Set(myWatchlist.map(m => m.slug));
                movies = movies.filter(m => mySlugs.has(m.slug));

                const n = movies.length.toLocaleString('en-US');
                subtitle = ctx.type === 'list'
                    ? `${n} film${movies.length === 1 ? '' : 's'} of this list in your watchlist`
                    : `${n} film${movies.length === 1 ? '' : 's'} in common with @${ctx.username}`;

                if (movies.length === 0) {
                    showMessage(ctx.type === 'list'
                        ? 'None of the films in this list is in your watchlist.'
                        : `No films in common between your watchlist and @${ctx.username}'s.`);
                    return;
                }
            }

            if (movies.length === 0) {
                showMessage(`No films found in this ${sourceLabel}!`);
                return;
            }

            currentPickerMovies = movies;
            document.getElementById('lbrnd-header-sub').textContent = subtitle;
            startRoulette(movies);
        } catch (err) {
            showMessage(`Failed to load ${sourceLabel}. Please try again.`);
        } finally {
            isFetching = false;
            poolSelect.disabled = isSpinning;
        }
    }

    /**
     * Carousel Roulette Engine with automatic on-the-fly poster resolution
     */
    function startRoulette(movies) {
        if (isSpinning) return;
        isSpinning = true;
        document.getElementById('lbrnd-pool-select').disabled = true;

        const loadingView = document.getElementById('lbrnd-loading-state');
        const rouletteView = document.getElementById('lbrnd-roulette-view');
        const revealView = document.getElementById('lbrnd-reveal-view');
        const track = document.getElementById('lbrnd-reel-track');

        loadingView.style.display = 'none';
        revealView.style.display = 'none';
        rouletteView.style.display = 'flex';

        // 1. Uniform random winner selection
        const winningIndexInWatchlist = Math.floor(Math.random() * movies.length);
        const winningFilm = movies[winningIndexInWatchlist];
        currentWinnerIndex = WINNER_INDEX;

        // 2. Pre-fetch details in background during spin
        const filmDetailsPromise = fetchFilmDetails(winningFilm);

        // 3. Build reel track
        const reelMovies = [];
        for (let i = 0; i < REEL_SIZE; i++) {
            if (i === WINNER_INDEX) {
                reelMovies.push(winningFilm);
            } else {
                const randMovie = movies[Math.floor(Math.random() * movies.length)];
                reelMovies.push(randMovie);
            }
        }

        track.innerHTML = '';
        track.style.transition = 'none';
        track.style.transform = 'translateX(0px)';

        reelMovies.forEach((m) => {
            const card = document.createElement('div');
            card.className = 'lbrnd-reel-card';

            const cardImg = document.createElement('img');
            cardImg.alt = m.name;
            cardImg.loading = 'lazy';
            cardImg.src = m.poster || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

            const fallbackDiv = document.createElement('div');
            fallbackDiv.className = 'lbrnd-poster-fallback';
            fallbackDiv.style.display = m.poster ? 'none' : 'flex';
            fallbackDiv.innerHTML = `
                <svg class="lbrnd-poster-fallback-icon" viewBox="0 0 24 24"><path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/></svg>
                <span class="lbrnd-poster-fallback-title">${escapeHtml(m.name)}</span>
            `;

            // Auto-resolve custom poster on error
            cardImg.onerror = async () => {
                if (!cardImg.dataset.resolved) {
                    cardImg.dataset.resolved = '1';
                    const customPoster = await resolveCustomPosterUrl(m.slug, m.cacheKey);
                    if (customPoster) {
                        cardImg.src = customPoster;
                        return;
                    }
                }
                cardImg.style.display = 'none';
                fallbackDiv.style.display = 'flex';
            };

            const infoDiv = document.createElement('div');
            infoDiv.className = 'lbrnd-reel-card-info';
            infoDiv.innerHTML = `
                <div class="lbrnd-reel-card-title">${escapeHtml(m.name)}</div>
                <div class="lbrnd-reel-card-year">${escapeHtml(m.year || '')}</div>
            `;

            card.appendChild(cardImg);
            card.appendChild(fallbackDiv);
            card.appendChild(infoDiv);
            track.appendChild(card);
        });

        // 4. Exact translation offset calculation
        const exactTargetOffset = (WINNER_INDEX * TOTAL_CARD_WIDTH) + CARD_MARGIN_EACH + (CARD_WIDTH / 2);

        // 5. Synchronized audio ticker
        let lastCardPassed = -1;
        let animStartTime = null;

        function tickMonitor(timestamp) {
            if (!animStartTime) animStartTime = timestamp;
            const elapsed = timestamp - animStartTime;

            const currentX = Math.abs(track.getBoundingClientRect().left - track.parentElement.getBoundingClientRect().left - (track.parentElement.clientWidth / 2));
            const cardIndex = Math.floor(currentX / TOTAL_CARD_WIDTH);

            if (cardIndex !== lastCardPassed && cardIndex >= 0 && cardIndex <= WINNER_INDEX + 1) {
                lastCardPassed = cardIndex;
                playTickSound();
            }

            if (elapsed < SPIN_DURATION_MS + 200 && isSpinning) {
                requestAnimationFrame(tickMonitor);
            }
        }

        // Trigger animation
        requestAnimationFrame(() => {
            track.offsetHeight;
            track.style.transition = `transform ${SPIN_DURATION_MS}ms cubic-bezier(0.12, 0.88, 0.22, 1)`;
            track.style.transform = `translateX(-${exactTargetOffset}px)`;
            requestAnimationFrame(tickMonitor);
        });

        // 6. Reveal winner
        setTimeout(async () => {
            isSpinning = false;
            document.getElementById('lbrnd-pool-select').disabled = false;
            playWinFanfare();

            const winnerCard = track.children[WINNER_INDEX];
            if (winnerCard) {
                winnerCard.classList.add('winner-highlight');
            }

            setTimeout(async () => {
                const fullFilmData = await filmDetailsPromise;
                showWinnerReveal(fullFilmData);
            }, 800);

        }, SPIN_DURATION_MS);
    }

    /**
     * Show rich movie details modal
     */
    function showWinnerReveal(film) {
        const rouletteView = document.getElementById('lbrnd-roulette-view');
        const revealView = document.getElementById('lbrnd-reveal-view');

        rouletteView.style.display = 'none';
        revealView.style.display = 'block';

        const posterEl = document.getElementById('lbrnd-reveal-poster');
        const fallbackEl = document.getElementById('lbrnd-reveal-poster-fallback');
        const fallbackTitleEl = document.getElementById('lbrnd-reveal-fallback-title');

        if (film.poster) {
            posterEl.style.display = 'block';
            fallbackEl.style.display = 'none';
            posterEl.src = film.poster;
            posterEl.alt = film.name;
            posterEl.onerror = async () => {
                if (!posterEl.dataset.resolved) {
                    posterEl.dataset.resolved = '1';
                    const customPoster = await resolveCustomPosterUrl(film.slug, film.cacheKey);
                    if (customPoster) {
                        posterEl.src = customPoster;
                        return;
                    }
                }
                posterEl.style.display = 'none';
                fallbackEl.style.display = 'flex';
                fallbackTitleEl.textContent = film.name;
            };
        } else {
            posterEl.style.display = 'none';
            fallbackEl.style.display = 'flex';
            fallbackTitleEl.textContent = film.name;
        }

        document.getElementById('lbrnd-reveal-title').textContent = film.name;
        
        const yearEl = document.getElementById('lbrnd-reveal-year');
        if (film.year) {
            yearEl.textContent = film.year;
            yearEl.style.display = 'inline-block';
        } else {
            yearEl.style.display = 'none';
        }

        const ratingEl = document.getElementById('lbrnd-reveal-rating');
        if (film.rating) {
            ratingEl.textContent = `★ ${film.rating}`;
            ratingEl.style.display = 'inline-flex';
        } else {
            ratingEl.style.display = 'none';
        }

        const directorEl = document.getElementById('lbrnd-reveal-director');
        if (film.directors && film.directors.length > 0) {
            directorEl.innerHTML = `Directed by <strong>${escapeHtml(film.directors.join(', '))}</strong>`;
            directorEl.style.display = 'block';
        } else {
            directorEl.style.display = 'none';
        }

        document.getElementById('lbrnd-reveal-synopsis').textContent = film.description || "No synopsis available for this film.";

        const castBox = document.getElementById('lbrnd-reveal-cast');
        const castSection = document.getElementById('lbrnd-cast-container');
        castBox.innerHTML = '';

        if (film.actors && film.actors.length > 0) {
            castSection.style.display = 'block';
            film.actors.forEach(actor => {
                const chip = document.createElement('span');
                chip.className = 'lbrnd-cast-chip';
                chip.textContent = actor;
                castBox.appendChild(chip);
            });
        } else {
            castSection.style.display = 'none';
        }

        const linkEl = document.getElementById('lbrnd-reveal-link');
        linkEl.href = film.link && !film.link.endsWith('#') ? film.link : `https://letterboxd.com${film.slug}`;
    }

    function removeWatchlistButton() {
        const btn = document.getElementById('lbrnd-dice-btn');
        if (btn) btn.remove();
    }

    /* ==========================================================================
       Letterboxd Diary Statistics Engine
       ========================================================================== */

    let cachedDiaryEntries = null;
    let cachedDiaryPath = '';
    let cachedFilms = null; // watched films grid (/member/films/), for the films page stats
    let cachedFilmsPath = '';
    let statsMissingPages = 0; // pages of the last diary / films fetch still failing after retries
    let isFetchingDiary = false;
    let statsMode = 'diary'; // 'diary' (dated entries) or 'films' (watched films grid, no dates)
    let currentEntries = []; // diary entries, or watched films in 'films' mode
    let currentSelectedYear = null; // 'all', a year (number) or 'range'
    let currentRange = null; // { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } when currentSelectedYear is 'range'

    // Films page "Count rewatches" option: times each film was watched, read from the member's diary
    let countRewatches = false;
    try { countRewatches = localStorage.getItem('lbc_count_rewatches') === 'true'; } catch (e) {}
    let currentFilmsCtx = null;
    let filmViews = null; // slug -> times watched
    let filmViewsUser = '';
    let filmViewsMissingPages = 0;
    let filmViewsError = false;
    let isFetchingFilmViews = false;
    let currentStatsData = null;
    let currentChartMode = 'days'; // 'days', 'months', 'ratings' or 'decades'

    /* --------------------------------------------------------------------------
       Film runtimes (Watch Time stat)
       The diary pages don't carry runtimes, so each film's /film/<slug>/json/ is fetched once.
       Runtimes are kept in extension storage, so only films never seen before cost a request.
       -------------------------------------------------------------------------- */

    const RUNTIME_STORAGE_KEY = 'lbc_runtimes';          // slug -> minutes
    const RUNTIME_MISSING_KEY = 'lbc_runtimes_missing';  // slug -> time of the check, for films without a runtime
    const RUNTIME_MISSING_RETRY_MS = 7 * 86400000;       // runtimes get added to new releases later on
    const RUNTIME_CONCURRENCY = 6;
    const RUNTIME_MAX_ATTEMPTS = 3;

    const filmRuntimes = new Map(); // slug -> minutes (0 = Letterboxd has no runtime for it)
    const failedRuntimeSlugs = new Set(); // gave up after RUNTIME_MAX_ATTEMPTS (counted as unknown)
    const runtimeAttempts = new Map();
    const inFlightRuntimeSlugs = new Set();
    let missingRuntimeChecks = {};
    let runtimeQueue = [];
    let runtimeWorkers = 0;
    let runtimePausedUntil = 0; // global backoff after a 429 / 5xx
    let runtimeStoreReady = null;
    let runtimeStoreLoaded = false;
    let runtimePersistTimer = null;

    function loadRuntimeStore() {
        if (runtimeStoreReady) return runtimeStoreReady;
        runtimeStoreReady = new Promise((resolve) => {
            const done = () => {
                runtimeStoreLoaded = true;
                resolve();
            };
            if (!extStorage) return done();
            try {
                extStorage.get([RUNTIME_STORAGE_KEY, RUNTIME_MISSING_KEY], (res) => {
                    const known = (res && res[RUNTIME_STORAGE_KEY]) || {};
                    Object.keys(known).forEach(slug => {
                        if (!filmRuntimes.has(slug)) filmRuntimes.set(slug, known[slug]);
                    });
                    const missing = (res && res[RUNTIME_MISSING_KEY]) || {};
                    const now = Date.now();
                    Object.keys(missing).forEach(slug => {
                        if (now - missing[slug] < RUNTIME_MISSING_RETRY_MS && !filmRuntimes.has(slug)) {
                            filmRuntimes.set(slug, 0);
                            missingRuntimeChecks[slug] = missing[slug];
                        }
                    });
                    done();
                });
            } catch (e) {
                done(); // extension context invalidated (extension reloaded): memory only
            }
        });
        return runtimeStoreReady;
    }

    // Debounced write, merged with what other tabs may have stored meanwhile
    function persistRuntimes() {
        if (!extStorage || runtimePersistTimer) return;
        runtimePersistTimer = setTimeout(() => {
            runtimePersistTimer = null;
            const known = {};
            filmRuntimes.forEach((minutes, slug) => {
                if (minutes > 0) known[slug] = minutes;
            });
            try {
                extStorage.get([RUNTIME_STORAGE_KEY, RUNTIME_MISSING_KEY], (res) => {
                    const storedMissing = (res && res[RUNTIME_MISSING_KEY]) || {};
                    const mergedMissing = { ...storedMissing, ...missingRuntimeChecks };
                    Object.keys(known).forEach(slug => delete mergedMissing[slug]);
                    extStorage.set({
                        [RUNTIME_STORAGE_KEY]: { ...((res && res[RUNTIME_STORAGE_KEY]) || {}), ...known },
                        [RUNTIME_MISSING_KEY]: mergedMissing
                    });
                });
            } catch (e) {}
        }, 1500);
    }

    async function fetchFilmRuntime(slug) {
        // Without these headers the endpoint answers with the regular HTML film page
        const res = await fetch(`/film/${encodeURIComponent(slug)}/json/`, {
            credentials: 'same-origin',
            headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
        });
        if (res.status === 429 || res.status >= 500) {
            const err = new Error(`HTTP ${res.status}`);
            err.throttled = true;
            throw err;
        }
        if (!res.ok) return 0; // film removed / renamed: nothing to count

        const text = await res.text();
        let minutes = null;
        try {
            minutes = parseInt(JSON.parse(text).runTime, 10);
        } catch (e) {
            // HTML film page: <div class="duration">125&nbsp;mins</div>
            const m = text.match(/class="(?:duration|text-link text-footer)"[^>]*>\s*([\d,]+)(?:&nbsp;|\s)*mins?/);
            minutes = m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
        }
        return minutes > 0 ? minutes : 0;
    }

    /**
     * Queues the runtimes still unknown among `slugs`, fetching `prioritySlugs` (the period on screen) first
     */
    function queueRuntimeFetches(slugs, prioritySlugs) {
        const wanted = new Set(runtimeQueue);
        slugs.forEach(slug => {
            if (slug && !filmRuntimes.has(slug) && !failedRuntimeSlugs.has(slug) && !inFlightRuntimeSlugs.has(slug)) {
                wanted.add(slug);
            }
        });
        const priority = new Set(prioritySlugs || []);
        const all = Array.from(wanted);
        runtimeQueue = all.filter(s => priority.has(s)).concat(all.filter(s => !priority.has(s)));

        while (runtimeWorkers < RUNTIME_CONCURRENCY && runtimeWorkers < runtimeQueue.length) {
            runtimeWorkers++;
            runRuntimeWorker();
        }
    }

    async function runRuntimeWorker() {
        while (runtimeQueue.length > 0) {
            const wait = runtimePausedUntil - Date.now();
            if (wait > 0) await new Promise(r => setTimeout(r, wait));

            const slug = runtimeQueue.shift();
            if (!slug) break;
            if (filmRuntimes.has(slug) || inFlightRuntimeSlugs.has(slug)) continue;

            inFlightRuntimeSlugs.add(slug);
            try {
                const minutes = await fetchFilmRuntime(slug);
                filmRuntimes.set(slug, minutes);
                if (minutes > 0) delete missingRuntimeChecks[slug];
                else missingRuntimeChecks[slug] = Date.now();
                persistRuntimes();
            } catch (err) {
                const attempts = (runtimeAttempts.get(slug) || 0) + 1;
                runtimeAttempts.set(slug, attempts);
                if (err.throttled) runtimePausedUntil = Math.max(runtimePausedUntil, Date.now() + 2000 * attempts);
                if (attempts < RUNTIME_MAX_ATTEMPTS) runtimeQueue.push(slug);
                else failedRuntimeSlugs.add(slug);
            } finally {
                inFlightRuntimeSlugs.delete(slug);
            }
            scheduleWatchTimeRender();
        }
        runtimeWorkers--;
        scheduleWatchTimeRender();
    }

    /**
     * Watch time of the entries of a period. Every diary entry counts, so a rewatch adds its runtime again
     * (the films page lists each film once).
     */
    function computeWatchTime(targetEntries) {
        const films = new Set();
        const pendingFilms = new Set();
        let minutes = 0;
        let timedEntries = 0;
        let untimedEntries = 0;

        targetEntries.forEach(e => {
            const views = viewsOf(e);
            if (!e.slug) {
                untimedEntries += views;
                return;
            }
            films.add(e.slug);
            const runtime = filmRuntimes.get(e.slug);
            if (runtime > 0) {
                minutes += runtime * views;
                timedEntries += views;
            } else if (runtime === 0 || failedRuntimeSlugs.has(e.slug)) {
                untimedEntries += views;
            } else {
                pendingFilms.add(e.slug);
            }
        });

        return {
            minutes,
            timedEntries,
            untimedEntries,
            totalFilms: films.size,
            pendingFilms: runtimeStoreLoaded ? pendingFilms.size : films.size
        };
    }

    function requestRuntimesForCurrentView() {
        loadRuntimeStore().then(() => {
            const inPeriod = entriesForSelection(currentEntries);
            queueRuntimeFetches(currentEntries.map(e => e.slug), inPeriod.map(e => e.slug));
            renderWatchTime();
        });
    }

    const MONTH_MAP = {
        'jan': 1, 'janv': 1, 'january': 1, 'janvier': 1,
        'feb': 2, 'fév': 2, 'fevr': 2, 'févr': 2, 'february': 2, 'février': 2,
        'mar': 3, 'mars': 3, 'march': 3,
        'apr': 4, 'avr': 4, 'april': 4, 'avril': 4,
        'may': 5, 'mai': 5,
        'jun': 6, 'juin': 6, 'june': 6,
        'jul': 7, 'juil': 7, 'july': 7, 'juillet': 7,
        'aug': 8, 'aoû': 8, 'aout': 8, 'août': 8, 'august': 8,
        'sep': 9, 'sept': 9, 'september': 9, 'septembre': 9,
        'oct': 10, 'october': 10, 'octobre': 10,
        'nov': 11, 'november': 11, 'novembre': 11,
        'dec': 12, 'déc': 12, 'december': 12, 'décembre': 12
    };

    function parseMonthText(text) {
        if (!text) return null;
        const clean = text.toLowerCase().trim().replace(/[^a-zàâéèêëîïôùûü]/g, '');
        return MONTH_MAP[clean] || null;
    }

    /**
     * Checks if current page is any Letterboxd diary page
     * Examples:
     * - /antrubtor/diary/
     * - /antrubtor/diary/for/2026/
     * - /antrubtor/diary/films/for/2026/
     * - /antrubtor/films/diary/
     * - /antrubtor/films/diary/for/2026/
     */
    function isDiaryPage() {
        const path = window.location.pathname;
        return /^\/[^\/]+\/(?:films\/diary|diary)(?:\/|$)/i.test(path);
    }

    function getDiaryContext() {
        const match = window.location.pathname.match(/^\/([^\/]+)\/(?:films\/diary|diary)(.*)/i);
        if (!match) return null;

        const username = match[1];
        const yearMatch = window.location.pathname.match(/\/for\/(\d{4})/i);
        const urlYear = yearMatch ? parseInt(yearMatch[1], 10) : null;

        let basePath = window.location.pathname.replace(/\/page\/\d+\/?/i, '/');
        if (!basePath.endsWith('/')) basePath += '/';

        return {
            username,
            urlYear,
            baseUrl: basePath
        };
    }

    /**
     * Extract diary rows from DOM or Document
     */
    function extractDiaryEntriesFromDoc(doc, fallbackYear) {
        const entries = [];
        const rows = doc.querySelectorAll('#diary-table tbody tr, table.diary-table tbody tr, tr.diary-entry-row, tr.diary-entry, .diary-entry');

        let lastDate = null;
        const defaultYear = fallbackYear || new Date().getFullYear();

        rows.forEach(row => {
            const filmLink = row.querySelector('h3.film-title a, .td-film-details h3 a, h3 a, .film-poster, a.frame');
            if (!filmLink && !row.querySelector('.film-poster, [data-item-name]')) return;

            // Current layout: <h2 class="primaryname">Title</h2>; poster attributes carry "Title (Year)"
            const posterData = row.querySelector('[data-item-name], [data-film-name]');
            const stripYear = (s) => (s || '').replace(/^Poster for\s+/i, '').replace(/\s*\(\d{4}\)\s*$/, '').trim();
            const title = row.querySelector('h2.primaryname, h3.film-title, .td-film-details h3, h3')?.textContent?.trim() ||
                          stripYear(posterData?.getAttribute('data-item-name') || posterData?.getAttribute('data-film-name')) ||
                          row.querySelector('.frame-title')?.textContent?.trim() ||
                          stripYear(row.querySelector('.film-poster img')?.getAttribute('alt')) ||
                          filmLink?.textContent?.trim() || 'Film';

            // Rating is "rated-N" with N = half-stars (1..10); like / rewatch / review are icon cells
            const ratingMatch = row.querySelector('.col-rating .rating, .td-rating .rating')?.className.match(/rated-(\d+)/);
            const rating = ratingMatch ? parseInt(ratingMatch[1], 10) : null;
            const liked = !!row.querySelector('.col-like .icon-liked, .td-like .icon-liked');
            const rewatchCell = row.querySelector('td.col-rewatch, td.td-rewatch');
            const rewatch = rewatchCell ? !rewatchCell.classList.contains('icon-status-off') : false;
            const reviewCell = row.querySelector('td.col-review, td.td-review');
            const review = reviewCell ? !reviewCell.classList.contains('icon-status-off') : false;

            const releaseText = row.querySelector('td.col-releaseyear, td.td-released, .releasedate')?.textContent ||
                                (posterData?.getAttribute('data-item-name') || '').match(/\((\d{4})\)\s*$/)?.[1] || '';
            const releaseYear = parseInt((releaseText.match(/\d{4}/) || [])[0], 10) || null;

            // Film slug (used to look up the runtime); links look like /film/slug/ or /member/film/slug/1/
            const slugAttr = posterData?.getAttribute('data-item-slug') || posterData?.getAttribute('data-film-slug') || '';
            const slugLink = row.querySelector('[data-details-endpoint], [data-item-link], a[href*="/film/"]');
            const slugHref = slugLink?.getAttribute('data-details-endpoint') || slugLink?.getAttribute('data-item-link') || slugLink?.getAttribute('href') || '';
            const slug = slugAttr || (slugHref.match(/\/film\/([^\/]+)/) || [])[1] || null;

            let entryDate = null;

            // 1. Link matching /for/YYYY/MM/DD/ anywhere in href
            const dateLinks = row.querySelectorAll('a[href*="/for/"], a[href*="/diary/"]');
            for (const link of dateLinks) {
                const href = link.getAttribute('href') || '';
                const m = href.match(/\/for\/(\d{4})\/(\d{1,2})\/(\d{1,2})\/?/);
                if (m) {
                    const y = parseInt(m[1], 10);
                    const mo = parseInt(m[2], 10);
                    const d = parseInt(m[3], 10);
                    entryDate = {
                        year: y,
                        month: mo,
                        day: d,
                        dateStr: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
                    };
                    break;
                }
            }

            // 2. <time datetime="...">
            if (!entryDate) {
                const timeEl = row.querySelector('time[datetime]');
                if (timeEl) {
                    const dt = timeEl.getAttribute('datetime') || '';
                    const m = dt.match(/^(\d{4})-(\d{2})-(\d{2})/);
                    if (m) {
                        entryDate = {
                            year: parseInt(m[1], 10),
                            month: parseInt(m[2], 10),
                            day: parseInt(m[3], 10),
                            dateStr: m[0]
                        };
                    }
                }
            }

            // 3. Day / Month columns
            if (!entryDate) {
                const dayEl = row.querySelector('.td-day, .diary-day, td.day');
                const dayNum = dayEl ? parseInt(dayEl.textContent.trim(), 10) : NaN;
                if (!isNaN(dayNum) && dayNum >= 1 && dayNum <= 31) {
                    const monthEl = row.querySelector('.td-calendar, .td-month, td.month');
                    const monthNum = monthEl ? parseMonthText(monthEl.textContent) : null;
                    const useYear = lastDate ? lastDate.year : defaultYear;
                    if (monthNum) {
                        entryDate = {
                            year: useYear,
                            month: monthNum,
                            day: dayNum,
                            dateStr: `${useYear}-${String(monthNum).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`
                        };
                    } else if (lastDate) {
                        entryDate = {
                            year: lastDate.year,
                            month: lastDate.month,
                            day: dayNum,
                            dateStr: `${lastDate.year}-${String(lastDate.month).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`
                        };
                    }
                }
            }

            // 4. Fallback: inherit lastDate if multiple movies logged on the same day
            if (entryDate) {
                lastDate = entryDate;
            } else if (lastDate) {
                entryDate = { ...lastDate };
            }

            if (entryDate) {
                entries.push({
                    title: title.replace(/\s+/g, ' ').trim(),
                    date: entryDate.dateStr,
                    year: entryDate.year,
                    month: entryDate.month,
                    day: entryDate.day,
                    rating,
                    liked,
                    rewatch,
                    review,
                    releaseYear,
                    slug
                });
            }
        });

        return entries;
    }

    /**
     * Every item of a paginated listing, pages fetched in batches of 5 (in page order).
     * Page 1 is always fetched rather than read from the live page: the server HTML is the same
     * for every viewer, while the live DOM may already be reworked by Letterboxd's scripts
     * (e.g. owner-only rating widgets replacing the static stars).
     * If page 1 still fails after fetchDocument's retries this throws; later pages that still fail
     * are skipped and counted in `failedPages`.
     */
    async function fetchAllPages(baseUrl, extract, onProgress) {
        const firstDoc = await fetchDocument(baseUrl);
        const totalPages = detectTotalPages(firstDoc);
        const pageUrl = pageUrlFor(firstDoc, baseUrl);
        let items = extract(firstDoc);
        let failedPages = 0;

        if (totalPages > 1) {
            onProgress?.(1, totalPages, items.length);

            const BATCH_SIZE = 5;
            for (let p = 2; p <= totalPages; p += BATCH_SIZE) {
                const batch = [];
                for (let n = p; n < p + BATCH_SIZE && n <= totalPages; n++) batch.push(n);

                const results = await Promise.all(batch.map(n =>
                    fetchDocument(pageUrl(n)).then(extract).catch(() => {
                        failedPages++;
                        return [];
                    })
                ));
                results.forEach(pageItems => {
                    items = items.concat(pageItems);
                });

                onProgress?.(Math.min(p + BATCH_SIZE - 1, totalPages), totalPages, items.length);
            }
        }

        return { items, failedPages };
    }

    /**
     * Fetch complete diary across pagination
     */
    async function fetchEntireDiary(customBasePath, fallbackYear, onProgress) {
        const ctx = getDiaryContext();
        if (!ctx) throw new Error("Unable to detect Diary context.");

        const targetBasePath = customBasePath || ctx.baseUrl;
        const targetFallbackYear = fallbackYear !== undefined ? fallbackYear : ctx.urlYear;
        const cacheKey = `${targetBasePath}::${targetFallbackYear}`;

        if (cachedDiaryEntries && cachedDiaryPath === cacheKey) {
            statsMissingPages = 0; // only complete diaries are cached
            return cachedDiaryEntries;
        }

        const { items, failedPages } = await fetchAllPages(
            targetBasePath,
            (doc) => extractDiaryEntriesFromDoc(doc, targetFallbackYear),
            onProgress
        );

        // An incomplete diary isn't cached, so reopening the stats fetches it again
        statsMissingPages = failedPages;
        if (failedPages === 0) {
            cachedDiaryEntries = items;
            cachedDiaryPath = cacheKey;
        }
        return items;
    }

    /**
     * Watched films grid (/member/films/ and its filters: /films/genre/horror/, /films/decade/1990s/...)
     * Examples:
     * - /antrubtor/films/
     * - /antrubtor/films/genre/horror/page/2/
     * - /antrubtor/films/by/rating/
     * (/films/diary/ is the diary, /films/reviews/ is a review list)
     */
    function getFilmsContext() {
        const match = window.location.pathname.match(/^\/([^\/]+)\/films(\/.*)?$/i);
        if (!match) return null;

        let subpath = (match[2] || '/').replace(/\/page\/\d+\/?/i, '/');
        if (/^\/(?:diary|reviews)(?:\/|$)/i.test(subpath)) return null;
        if (!subpath.endsWith('/')) subpath += '/';

        return {
            username: match[1],
            baseUrl: `/${match[1]}/films${subpath}`,
            filter: subpath.replace(/^\/|\/$/g, '').replace(/\//g, ' / ') // e.g. "genre / horror"
        };
    }

    function isFilmsPage() {
        return getFilmsContext() !== null;
    }

    /**
     * A member's whole diary, from any page (shares the diary cache with the diary stats)
     */
    async function fetchDiaryForUser(username, onProgress) {
        const basePath = `/${username}/diary/`;
        const cacheKey = `${basePath}::null`; // same key as fetchEntireDiary on /member/diary/
        if (cachedDiaryEntries && cachedDiaryPath === cacheKey) {
            return { entries: cachedDiaryEntries, failedPages: 0 };
        }
        const { items, failedPages } = await fetchAllPages(basePath, (doc) => extractDiaryEntriesFromDoc(doc, null), onProgress);
        if (failedPages === 0) {
            cachedDiaryEntries = items;
            cachedDiaryPath = cacheKey;
        }
        return { entries: items, failedPages };
    }

    /**
     * Times each film was watched: its diary entries, plus one when its first entry is marked as a
     * rewatch (it was seen before being logged). Films with no diary entry count once.
     */
    function computeFilmViews(diaryEntries) {
        const bySlug = new Map();
        diaryEntries.forEach(e => {
            if (!e.slug) return;
            const info = bySlug.get(e.slug) || { count: 0, firstDate: null, firstIsRewatch: false };
            info.count++;
            if (!info.firstDate || e.date < info.firstDate) {
                info.firstDate = e.date;
                info.firstIsRewatch = e.rewatch;
            }
            bySlug.set(e.slug, info);
        });

        const views = new Map();
        bySlug.forEach((info, slug) => views.set(slug, info.count + (info.firstIsRewatch ? 1 : 0)));
        return views;
    }

    // "Count rewatches" is on and the views come from this member's diary
    function filmViewsReady() {
        return statsMode === 'films' && countRewatches && !!filmViews && !!currentFilmsCtx &&
            filmViewsUser === currentFilmsCtx.username.toLowerCase();
    }

    // Weight of an entry in totals and watch time: 1, or the film's views on the films page with "Count rewatches"
    function viewsOf(entry) {
        return filmViewsReady() ? Math.max(1, filmViews.get(entry.slug) || 1) : 1;
    }

    async function fetchWatchedFilms(baseUrl, onProgress) {
        if (cachedFilms && cachedFilmsPath === baseUrl) {
            statsMissingPages = 0;
            return cachedFilms;
        }

        const { items, failedPages } = await fetchAllPages(baseUrl, extractMemberFilmsFromDoc, onProgress);
        const seen = new Set();
        const films = items.filter(f => !seen.has(f.slug) && seen.add(f.slug));

        statsMissingPages = failedPages;
        if (failedPages === 0) {
            cachedFilms = films;
            cachedFilmsPath = baseUrl;
        }
        return films;
    }

    /**
     * Period helpers. Diary dates are 'YYYY-MM-DD' strings, so they compare as strings.
     */
    function parseDateStr(dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        return new Date(y, m - 1, d);
    }

    function toDateStr(date) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    function formatDateStr(dateStr, withYear = true) {
        const d = parseDateStr(dateStr);
        const monthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return `${monthsEn[d.getMonth()]} ${d.getDate()}${withYear ? `, ${d.getFullYear()}` : ''}`;
    }

    // "Mar 3 – Jun 1, 2025" or "Nov 3, 2024 – Feb 1, 2025"
    function formatRangeLabel(range) {
        const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
        if (range.from === range.to) return formatDateStr(range.from);
        return `${formatDateStr(range.from, !sameYear)} – ${formatDateStr(range.to)}`;
    }

    /**
     * Entries of the selected period: 'all', a year, or 'range' (inclusive from / to dates).
     * The films page has no dates: everything is in the period.
     */
    function entriesForSelection(entries, selection = currentSelectedYear, range = currentRange) {
        if (statsMode === 'films' || selection === 'all') return entries;
        if (selection === 'range') {
            return range ? entries.filter(e => e.date >= range.from && e.date <= range.to) : entries;
        }
        return entries.filter(e => e.year === selection);
    }

    /**
     * Compute activity statistics (Heatmap + Weekdays + Months + Highlights)
     * `selection` is a year (e.g. 2026), 'all' (All-Time across all diary years) or 'range' (uses `range`)
     */
    function computeDiaryStats(allEntries, selection, range) {
        const kind = selection === 'all' ? 'all' : (selection === 'range' && range ? 'range' : 'year');
        const isAllTime = (kind === 'all');
        const targetEntries = entriesForSelection(allEntries, selection, range);

        const dateFilmMap = {};
        targetEntries.forEach(e => {
            if (!dateFilmMap[e.date]) dateFilmMap[e.date] = [];
            dateFilmMap[e.date].push(e);
        });

        const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        const dayShorts = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        const dayCounts = [0, 0, 0, 0, 0, 0, 0];

        const monthNames = [
            'January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'
        ];
        const monthShorts = [
            'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
            'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
        ];
        const monthCounts = new Array(12).fill(0);

        let maxInSingleDay = 0;
        let recordDayStr = '';
        let recordDayFilms = [];

        targetEntries.forEach(e => {
            const parts = e.date.split('-').map(Number);
            const d = new Date(parts[0], parts[1] - 1, parts[2]);
            const isoDay = (d.getDay() + 6) % 7; // Monday = 0, Sunday = 6
            dayCounts[isoDay]++;

            const mIdx = parts[1] - 1;
            if (mIdx >= 0 && mIdx < 12) {
                monthCounts[mIdx]++;
            }
        });

        Object.keys(dateFilmMap).forEach(dStr => {
            const count = dateFilmMap[dStr].length;
            if (count > maxInSingleDay) {
                maxInSingleDay = count;
                recordDayStr = dStr;
                recordDayFilms = dateFilmMap[dStr];
            }
        });

        // Determine the span: a custom range, one year, or every year with entries
        let startDate;
        let endDate;
        if (kind === 'range') {
            startDate = parseDateStr(range.from);
            endDate = parseDateStr(range.to);
        } else {
            const years = targetEntries.map(e => e.year).filter(y => y && !isNaN(y));
            const currentCalYear = new Date().getFullYear();
            const firstYear = isAllTime ? (years.length > 0 ? Math.min(...years) : currentCalYear) : selection;
            const lastYear = isAllTime ? (years.length > 0 ? Math.max(...years) : currentCalYear) : selection;
            startDate = new Date(firstYear, 0, 1);
            endDate = new Date(lastYear, 11, 31);
        }
        const minYear = startDate.getFullYear();
        const maxYear = endDate.getFullYear();
        // Dates shown in the stats carry their year when the period spans several years
        const withYear = isAllTime || minYear !== maxYear;

        const startDayOfWeek = (startDate.getDay() + 6) % 7; // Monday = 0, Sunday = 6

        const weeks = [];
        let currentWeek = [];

        for (let i = 0; i < startDayOfWeek; i++) {
            currentWeek.push({ empty: true });
        }

        const monthPositions = [];
        let lastLabeledMonthKey = '';

        const curDate = new Date(startDate);
        let totalCalendarDays = 0;

        while (curDate <= endDate) {
            totalCalendarDays++;
            const y = curDate.getFullYear();
            const m = curDate.getMonth();
            const d = curDate.getDate();
            const dStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const films = dateFilmMap[dStr] || [];
            const count = films.length;

            const monthKey = `${y}-${m}`;
            if (monthKey !== lastLabeledMonthKey) {
                // A custom range can start at the end of a month: drop that label if it would overlap the next one
                const prevLabel = monthPositions[monthPositions.length - 1];
                if (prevLabel && weeks.length - prevLabel.weekIdx < 3) monthPositions.pop();

                const label = (withYear && m === 0) ? `${y}` : monthShorts[m];
                monthPositions.push({
                    weekIdx: weeks.length,
                    label,
                    isYear: (withYear && m === 0)
                });
                lastLabeledMonthKey = monthKey;
            }

            let level = 0;
            if (count === 1) level = 1;
            else if (count === 2) level = 2;
            else if (count === 3) level = 3;
            else if (count >= 4) level = 4;

            currentWeek.push({
                empty: false,
                dateStr: dStr,
                dateObj: new Date(curDate),
                count,
                level,
                films
            });

            if (currentWeek.length === 7) {
                weeks.push(currentWeek);
                currentWeek = [];
            }

            curDate.setDate(curDate.getDate() + 1);
        }

        if (currentWeek.length > 0) {
            while (currentWeek.length < 7) {
                currentWeek.push({ empty: true });
            }
            weeks.push(currentWeek);
        }

        // Averages only count days that have already happened (current year is still in progress)
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const spanEnd = endDate < today ? endDate : today;
        const elapsedDays = Math.round((spanEnd - startDate) / 86400000) + 1;
        const totalSpanDays = Math.max(1, Math.min(totalCalendarDays, elapsedDays));

        const activeDaysCount = Object.keys(dateFilmMap).length;
        const activePercentage = Math.round((activeDaysCount / totalSpanDays) * 100);
        const totalWeeks = Math.max(1, totalSpanDays / 7);
        const avgPerWeek = (targetEntries.length / totalWeeks).toFixed(1);

        // 5. Longest consecutive days streak calculation
        const activeDates = Object.keys(dateFilmMap).sort();
        let maxStreak = 0;
        let maxStreakStartStr = '';
        let maxStreakEndStr = '';

        if (activeDates.length > 0) {
            let currentStreak = 1;
            let currentStreakStartStr = activeDates[0];
            let currentStreakEndStr = activeDates[0];

            maxStreak = 1;
            maxStreakStartStr = activeDates[0];
            maxStreakEndStr = activeDates[0];

            for (let i = 1; i < activeDates.length; i++) {
                const prevParts = activeDates[i - 1].split('-').map(Number);
                const curParts = activeDates[i].split('-').map(Number);
                const prevDayNum = Math.floor(Date.UTC(prevParts[0], prevParts[1] - 1, prevParts[2]) / 86400000);
                const curDayNum = Math.floor(Date.UTC(curParts[0], curParts[1] - 1, curParts[2]) / 86400000);

                if (curDayNum === prevDayNum + 1) {
                    currentStreak++;
                    currentStreakEndStr = activeDates[i];
                } else if (curDayNum > prevDayNum + 1) {
                    currentStreak = 1;
                    currentStreakStartStr = activeDates[i];
                    currentStreakEndStr = activeDates[i];
                }

                if (currentStreak > maxStreak) {
                    maxStreak = currentStreak;
                    maxStreakStartStr = currentStreakStartStr;
                    maxStreakEndStr = currentStreakEndStr;
                }
            }
        }

        let streakRangeStr = 'no streak';
        if (maxStreak > 0 && maxStreakStartStr && maxStreakEndStr) {
            const startParts = maxStreakStartStr.split('-').map(Number);
            const endParts = maxStreakEndStr.split('-').map(Number);
            const monthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

            if (maxStreak === 1) {
                if (withYear) {
                    streakRangeStr = `on ${monthsEn[startParts[1] - 1]} ${startParts[2]}, ${startParts[0]}`;
                } else {
                    streakRangeStr = `on ${monthsEn[startParts[1] - 1]} ${startParts[2]}`;
                }
            } else {
                const startMonth = monthsEn[startParts[1] - 1];
                const endMonth = monthsEn[endParts[1] - 1];

                if (startParts[0] === endParts[0]) {
                    const yearSuffix = withYear ? `, ${startParts[0]}` : '';
                    if (startParts[1] === endParts[1]) {
                        streakRangeStr = `${startMonth} ${startParts[2]} – ${endParts[2]}${yearSuffix}`;
                    } else {
                        streakRangeStr = `${startMonth} ${startParts[2]} – ${endMonth} ${endParts[2]}${yearSuffix}`;
                    }
                } else {
                    streakRangeStr = `${startMonth} ${startParts[2]}, ${startParts[0]} – ${endMonth} ${endParts[2]}, ${endParts[0]}`;
                }
            }
        }

        let maxMonthIdx = 0;
        let maxMonthCount = 0;
        monthCounts.forEach((c, i) => {
            if (c > maxMonthCount) {
                maxMonthCount = c;
                maxMonthIdx = i;
            }
        });

        return {
            year: selection,
            kind,
            isAllTime,
            withYear,
            minYear,
            maxYear,
            totalFilms: targetEntries.length,
            activeDaysCount,
            activePercentage,
            maxStreak,
            streakRangeStr,
            maxInSingleDay,
            recordDayStr,
            recordDayFilms,
            avgPerWeek,
            totalWeeks,
            topMonthName: maxMonthCount > 0 ? monthNames[maxMonthIdx] : '-',
            topMonthCount: maxMonthCount,
            weeks,
            monthPositions,
            dayStats: dayNames.map((name, i) => ({
                name,
                short: dayShorts[i],
                count: dayCounts[i]
            })),
            monthStats: monthNames.map((name, i) => ({
                name,
                short: monthShorts[i],
                count: monthCounts[i]
            })),
            ...computeTasteStats(targetEntries)
        };
    }

    /**
     * Ratings, rewatches, likes, reviews and release decades: shared by the diary and the films page
     */
    function computeTasteStats(targetEntries) {
        const ratingCounts = new Array(10).fill(0); // index 0 = ½★ ... index 9 = ★★★★★
        let ratingSum = 0;
        let ratedCount = 0;
        let rewatchCount = 0;
        let likedCount = 0;
        let reviewCount = 0;
        const decadeCounts = {};

        targetEntries.forEach(e => {
            if (e.rating >= 1 && e.rating <= 10) {
                ratingCounts[e.rating - 1]++;
                ratingSum += e.rating;
                ratedCount++;
            }
            if (e.rewatch) rewatchCount++;
            if (e.liked) likedCount++;
            if (e.review) reviewCount++;
            if (e.releaseYear) {
                const decade = Math.floor(e.releaseYear / 10) * 10;
                decadeCounts[decade] = (decadeCounts[decade] || 0) + 1;
            }
        });

        // Every decade between the oldest and newest film, so gaps show as empty bars
        const decadeKeys = Object.keys(decadeCounts).map(Number).sort((a, b) => a - b);
        const decadeStats = [];
        if (decadeKeys.length > 0) {
            for (let dec = decadeKeys[0]; dec <= decadeKeys[decadeKeys.length - 1]; dec += 10) {
                decadeStats.push({ name: `${dec}s`, short: `${dec}s`, count: decadeCounts[dec] || 0 });
            }
        }
        const topDecade = decadeStats.reduce((best, d) => (d.count > (best ? best.count : 0) ? d : best), null);

        const ratingShorts = ['½', '1', '1½', '2', '2½', '3', '3½', '4', '4½', '5'];

        return {
            avgRating: ratedCount > 0 ? ratingSum / ratedCount / 2 : null,
            ratedCount,
            rewatchCount,
            likedCount,
            reviewCount,
            ratingStats: ratingCounts.map((count, i) => ({
                name: `${formatStars(i + 1)} (${(i + 1) / 2})`,
                short: ratingShorts[i],
                count
            })),
            decadeStats,
            datedFilmsCount: decadeStats.reduce((sum, d) => sum + d.count, 0),
            topDecadeName: topDecade ? topDecade.name : '-',
            topDecadeCount: topDecade ? topDecade.count : 0
        };
    }

    /**
     * Films page stats: no watch dates, each film once (no rewatches)
     */
    function computeFilmsStats(films) {
        return {
            kind: 'films',
            totalFilms: films.length,
            totalViews: films.reduce((sum, f) => sum + viewsOf(f), 0), // = totalFilms unless rewatches are counted
            totalWeeks: null,
            ...computeTasteStats(films)
        };
    }

    /**
     * Half-star rating (1..10) to Letterboxd stars, e.g. 7 -> "★★★½"
     */
    function formatStars(halfStars) {
        if (!halfStars) return '';
        return '★'.repeat(Math.floor(halfStars / 2)) + (halfStars % 2 ? '½' : '');
    }

    /**
     * Films logged on today's day/month in previous years (all loaded entries, not just the selected year)
     */
    function computeOnThisDay(entries) {
        const today = new Date();
        const month = today.getMonth() + 1;
        const day = today.getDate();
        const byYear = {};

        entries.forEach(e => {
            if (e.month === month && e.day === day && e.year < today.getFullYear()) {
                if (!byYear[e.year]) byYear[e.year] = [];
                byYear[e.year].push(e);
            }
        });

        const monthsLongEn = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        return {
            label: `${monthsLongEn[month - 1]} ${day}`,
            years: Object.keys(byYear).map(Number).sort((a, b) => b - a).map(year => ({ year, films: byYear[year] }))
        };
    }

    /**
     * Statistics Floating Action Button
     */
    const SVG_STATS_ICON = `
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
            <rect x="3" y="3" width="18" height="18" rx="3.5" stroke="#99aabb" stroke-width="1.8" fill="#14181c"/>
            <rect x="6.5" y="13" width="3" height="5" rx="1" fill="#40bcf4"/>
            <rect x="10.5" y="9" width="3" height="9" rx="1" fill="#00e054"/>
            <rect x="14.5" y="6" width="3" height="12" rx="1" fill="#ff8000"/>
        </svg>
    `;

    function injectStatsButton() {
        if (document.getElementById('lbst-stats-btn')) return;
        if (!isDiaryPage() && !isFilmsPage()) return;

        const ctx = getDiaryContext();
        const tooltipText = !ctx ? 'Film Statistics'
            : ctx.urlYear ? `Statistics ${ctx.urlYear}` : 'Diary Statistics (All Time)';

        const btn = document.createElement('button');
        btn.id = 'lbst-stats-btn';
        btn.setAttribute('aria-label', tooltipText);
        btn.innerHTML = `
            ${SVG_STATS_ICON}
            <div id="lbst-stats-tooltip">${tooltipText}</div>
        `;

        btn.addEventListener('click', () => {
            openStatsModal();
        });

        document.body.appendChild(btn);
    }

    function removeStatsButton() {
        const btn = document.getElementById('lbst-stats-btn');
        if (btn) btn.remove();
    }

    /**
     * Statistics Modal Dialog
     */
    function injectStatsModal() {
        if (document.getElementById('lbst-modal-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'lbst-modal-overlay';
        overlay.innerHTML = `
            <div id="lbst-modal-container">
                <div class="lbst-modal-header">
                    <div class="lbst-header-title-box">
                        <div class="lbrnd-letterboxd-dots">
                            <span class="lbrnd-dot lbrnd-dot-orange"></span>
                            <span class="lbrnd-dot lbrnd-dot-green"></span>
                            <span class="lbrnd-dot lbrnd-dot-cyan"></span>
                        </div>
                        <div>
                            <h3 class="lbst-header-title" id="lbst-header-title">Diary Statistics</h3>
                            <p class="lbst-header-subtitle" id="lbst-header-sub">Loading diary...</p>
                        </div>
                    </div>
                    <div class="lbst-header-controls">
                        <label class="lbst-check" data-films-only title="Count every time a film was watched, from the member's diary">
                            <input type="checkbox" id="lbst-rewatch-toggle">
                            <span>Count rewatches</span>
                        </label>
                        <div class="lbst-range-inputs" id="lbst-range-inputs" data-diary-only hidden>
                            <input type="date" class="lbst-date-input" id="lbst-range-from" aria-label="From">
                            <span class="lbst-range-sep">→</span>
                            <input type="date" class="lbst-date-input" id="lbst-range-to" aria-label="To">
                        </div>
                        <select class="lbst-year-select" id="lbst-year-select" data-diary-only style="display: none;"></select>
                        <button class="lbrnd-btn-icon" id="lbst-modal-close" title="Close (Esc)">✕</button>
                    </div>
                </div>

                <!-- 1. Loading State -->
                <div id="lbst-loading-state">
                    <div class="lbst-spinner"></div>
                    <div class="lbst-loading-text" id="lbst-loading-status">Indexing diary...</div>
                    <div class="lbst-progress-bar-wrap">
                        <div class="lbst-progress-bar-fill" id="lbst-progress-fill"></div>
                    </div>
                </div>

                <!-- 2. Content View -->
                <div class="lbst-modal-body" id="lbst-content-view" style="display: none;">
                    <!-- Key metrics summary -->
                    <div class="lbst-metrics-grid">
                        <div class="lbst-metric-card lbst-watchtime-card" id="lbst-watchtime-card">
                            <div class="lbst-watchtime-main">
                                <span class="lbst-metric-label">
                                    Watch Time
                                    <span class="lbst-watchtime-status" id="lbst-watchtime-status"></span>
                                </span>
                                <span class="lbst-metric-value lbst-watchtime-value" id="lbst-metric-watchtime">0m</span>
                                <span class="lbst-metric-sub" id="lbst-metric-watchtime-days">-</span>
                            </div>
                            <div class="lbst-watchtime-details">
                                <div class="lbst-watchtime-detail">
                                    <span class="lbst-watchtime-detail-value" id="lbst-watchtime-avg">-</span>
                                    <span class="lbst-watchtime-detail-label">avg per film</span>
                                </div>
                                <div class="lbst-watchtime-detail" data-diary-only>
                                    <span class="lbst-watchtime-detail-value" id="lbst-watchtime-week">-</span>
                                    <span class="lbst-watchtime-detail-label">per week</span>
                                </div>
                            </div>
                            <div class="lbst-watchtime-progress">
                                <div class="lbst-watchtime-progress-fill" id="lbst-watchtime-progress-fill"></div>
                            </div>
                        </div>
                        <div class="lbst-metric-card">
                            <span class="lbst-metric-label" id="lbst-metric-total-label">Films Logged</span>
                            <span class="lbst-metric-value" id="lbst-metric-total">0</span>
                            <span class="lbst-metric-sub" id="lbst-metric-avg">0 / week</span>
                        </div>
                        <div class="lbst-metric-card" data-diary-only>
                            <span class="lbst-metric-label">Active Days</span>
                            <span class="lbst-metric-value" id="lbst-metric-active">0</span>
                            <span class="lbst-metric-sub" id="lbst-metric-active-pct">0% of year</span>
                        </div>
                        <div class="lbst-metric-card" data-diary-only>
                            <span class="lbst-metric-label">Longest Streak</span>
                            <span class="lbst-metric-value" id="lbst-metric-streak">0 days</span>
                            <span class="lbst-metric-sub" id="lbst-metric-streak-range">no streak</span>
                        </div>
                        <div class="lbst-metric-card" data-diary-only>
                            <span class="lbst-metric-label">Daily Record</span>
                            <span class="lbst-metric-value" id="lbst-metric-record">0</span>
                            <span class="lbst-metric-sub" id="lbst-metric-record-date">no films</span>
                        </div>
                        <div class="lbst-metric-card" data-diary-only>
                            <span class="lbst-metric-label">Top Month</span>
                            <span class="lbst-metric-value" id="lbst-metric-top-month">-</span>
                            <span class="lbst-metric-sub" id="lbst-metric-top-month-count">0 films</span>
                        </div>
                        <div class="lbst-metric-card">
                            <span class="lbst-metric-label">Average Rating</span>
                            <span class="lbst-metric-value" id="lbst-metric-avg-rating">-</span>
                            <span class="lbst-metric-sub" id="lbst-metric-avg-rating-sub">no rated films</span>
                        </div>
                        <div class="lbst-metric-card" data-diary-only>
                            <span class="lbst-metric-label">Rewatches</span>
                            <span class="lbst-metric-value" id="lbst-metric-rewatch">0</span>
                            <span class="lbst-metric-sub" id="lbst-metric-rewatch-pct">0% of films</span>
                        </div>
                        <div class="lbst-metric-card">
                            <span class="lbst-metric-label">Liked</span>
                            <span class="lbst-metric-value" id="lbst-metric-liked">0</span>
                            <span class="lbst-metric-sub" id="lbst-metric-liked-pct">0% of films</span>
                        </div>
                        <div class="lbst-metric-card">
                            <span class="lbst-metric-label">Reviews</span>
                            <span class="lbst-metric-value" id="lbst-metric-reviews">0</span>
                            <span class="lbst-metric-sub" id="lbst-metric-reviews-pct">0% of films</span>
                        </div>
                        <div class="lbst-metric-card">
                            <span class="lbst-metric-label">Top Decade</span>
                            <span class="lbst-metric-value" id="lbst-metric-top-decade">-</span>
                            <span class="lbst-metric-sub" id="lbst-metric-top-decade-count">0 films</span>
                        </div>
                    </div>

                    <!-- GitHub Heatmap Grid -->
                    <div class="lbst-section" data-diary-only>
                        <div class="lbst-section-header">
                            <h4 class="lbst-section-title">Viewing Activity</h4>
                        </div>
                        <div class="lbst-heatmap-card">
                            <div class="lbst-heatmap-wrapper">
                                <!-- Months Row -->
                                <div class="lbst-months-row" id="lbst-months-row"></div>
                                
                                <div class="lbst-grid-container">
                                    <!-- Days column -->
                                    <div class="lbst-days-col">
                                        <span class="lbst-day-label">Mon</span>
                                        <span class="lbst-day-label"></span>
                                        <span class="lbst-day-label">Wed</span>
                                        <span class="lbst-day-label"></span>
                                        <span class="lbst-day-label">Fri</span>
                                        <span class="lbst-day-label"></span>
                                        <span class="lbst-day-label"></span>
                                    </div>
                                    <!-- Weeks Columns Track -->
                                    <div class="lbst-weeks-track" id="lbst-weeks-track"></div>
                                </div>

                                <!-- Heatmap Footer Legend -->
                                <div class="lbst-heatmap-footer">
                                    <span>Less</span>
                                    <div class="lbst-legend-cells">
                                        <span class="lbst-legend-cell lbst-cell-lvl-0"></span>
                                        <span class="lbst-legend-cell lbst-cell-lvl-1"></span>
                                        <span class="lbst-legend-cell lbst-cell-lvl-2"></span>
                                        <span class="lbst-legend-cell lbst-cell-lvl-3"></span>
                                        <span class="lbst-legend-cell lbst-cell-lvl-4"></span>
                                    </div>
                                    <span>More</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Bar Chart Section with Days/Months/Ratings/Decades Toggle -->
                    <div class="lbst-section">
                        <div class="lbst-section-header">
                            <h4 class="lbst-section-title">Viewing Distribution</h4>
                            <div class="lbst-toggle-group" id="lbst-chart-toggles">
                                <button class="lbst-toggle-btn active" data-chart-mode="days" data-diary-only>Days</button>
                                <button class="lbst-toggle-btn" data-chart-mode="months" data-diary-only>Months</button>
                                <button class="lbst-toggle-btn" data-chart-mode="ratings">Ratings</button>
                                <button class="lbst-toggle-btn" data-chart-mode="decades">Decades</button>
                            </div>
                        </div>
                        <div class="lbst-chart-card">
                            <div class="lbst-chart-container" id="lbst-chart-container"></div>
                        </div>
                    </div>

                    <!-- On This Day: same date in previous years -->
                    <div class="lbst-section" data-diary-only>
                        <div class="lbst-section-header">
                            <h4 class="lbst-section-title" id="lbst-onthisday-title">On This Day</h4>
                        </div>
                        <div class="lbst-onthisday-card" id="lbst-onthisday"></div>
                    </div>
                </div>
            </div>
        `;

        // Tooltip for heatmap and bars
        let tooltip = document.getElementById('lbst-floating-tooltip');
        if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.id = 'lbst-floating-tooltip';
            document.body.appendChild(tooltip);
        }

        document.body.appendChild(overlay);

        document.getElementById('lbst-modal-close').addEventListener('click', closeStatsModal);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeStatsModal();
            else unpinTooltip();
        });

        // A pinned tooltip is fixed-positioned: drop it when the content under it scrolls away
        document.getElementById('lbst-content-view').addEventListener('scroll', unpinTooltip);
        overlay.querySelector('.lbst-heatmap-card').addEventListener('scroll', unpinTooltip);

        overlay.querySelectorAll('#lbst-chart-toggles .lbst-toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (currentChartMode === btn.dataset.chartMode) return;
                setChartMode(btn.dataset.chartMode);
                if (currentStatsData) renderBarChart(currentStatsData);
            });
        });

        document.getElementById('lbst-year-select').addEventListener('change', (e) => {
            const value = e.target.value;
            if (value === 'range') {
                // Start from the period on screen, then the dates can be adjusted
                currentRange = defaultRangeFor(currentSelectedYear);
            }
            currentSelectedYear = value === 'all' || value === 'range' ? value : parseInt(value, 10);
            updateStatsForSelectedYear();
        });

        const rewatchToggle = document.getElementById('lbst-rewatch-toggle');
        rewatchToggle.checked = countRewatches;
        rewatchToggle.addEventListener('change', () => {
            countRewatches = rewatchToggle.checked;
            try { localStorage.setItem('lbc_count_rewatches', countRewatches ? 'true' : 'false'); } catch (e) {}
            applyRewatchOption();
        });

        const fromInput = document.getElementById('lbst-range-from');
        const toInput = document.getElementById('lbst-range-to');
        const onRangeInput = (edited) => {
            if (!fromInput.value || !toInput.value) return; // half-typed date
            let from = fromInput.value;
            let to = toInput.value;
            // Moving one end past the other drags the other end along
            if (from > to) {
                if (edited === 'from') to = from;
                else from = to;
            }
            if (currentRange && currentRange.from === from && currentRange.to === to) return;
            currentRange = { from, to };
            updateStatsForSelectedYear();
        };
        fromInput.addEventListener('change', () => onRangeInput('from'));
        toInput.addEventListener('change', () => onRangeInput('to'));

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.classList.contains('active')) {
                if (pinnedTooltipCell) unpinTooltip();
                else closeStatsModal();
            }
        });
    }

    function openStatsModal() {
        injectStatsModal();
        const overlay = document.getElementById('lbst-modal-overlay');
        overlay.classList.add('active');

        const diaryCtx = getDiaryContext();
        const filmsCtx = diaryCtx ? null : getFilmsContext();
        if (!diaryCtx && !filmsCtx) return;

        statsMode = diaryCtx ? 'diary' : 'films';
        overlay.classList.toggle('is-films-mode', statsMode === 'films');

        const titleEl = document.getElementById('lbst-header-title');
        const subEl = document.getElementById('lbst-header-sub');
        loadRuntimeStore(); // read the stored runtimes while the pages load

        if (statsMode === 'films') {
            titleEl.textContent = 'Film Statistics';
            subEl.textContent = `@${filmsCtx.username} • Loading watched films...`;
            loadAndRenderFilmStats(filmsCtx);
            return;
        }

        titleEl.textContent = diaryCtx.urlYear ? `Diary Statistics • ${diaryCtx.urlYear}` : 'Diary Statistics • All Time';
        subEl.textContent = `@${diaryCtx.username} • Loading diary entries...`;
        loadAndRenderStats(diaryCtx);
    }

    function closeStatsModal() {
        const overlay = document.getElementById('lbst-modal-overlay');
        if (overlay) overlay.classList.remove('active');
        unpinTooltip();
    }

    function showStatsLoading(percent, text) {
        document.getElementById('lbst-loading-state').style.display = 'flex';
        document.getElementById('lbst-content-view').style.display = 'none';
        document.getElementById('lbst-progress-fill').style.width = `${percent}%`;
        document.getElementById('lbst-loading-status').textContent = text;
    }

    function showStatsContent() {
        document.getElementById('lbst-loading-state').style.display = 'none';
        document.getElementById('lbst-content-view').style.display = 'flex';
    }

    // onProgress callback for fetchAllPages
    function statsProgress(label) {
        return (loaded, total, count) => {
            document.getElementById('lbst-progress-fill').style.width = `${Math.max(10, Math.round((loaded / total) * 100))}%`;
            document.getElementById('lbst-loading-status').textContent = `${label}... (${count} films • Page ${loaded}/${total})`;
        };
    }

    function appendMissingPagesWarning(subEl) {
        if (statsMissingPages <= 0) return;
        const warning = document.createElement('span');
        warning.className = 'lbst-header-warning';
        warning.textContent = ` • ${statsMissingPages} page${statsMissingPages === 1 ? '' : 's'} couldn't be loaded, reopen to retry`;
        subEl.appendChild(warning);
    }

    /**
     * Year picker: All Time, every year with entries, then a custom date range
     */
    function populateYearSelect() {
        const yearSelect = document.getElementById('lbst-year-select');
        const years = Array.from(new Set(currentEntries.map(e => e.year).filter(y => y && !isNaN(y))));
        if (typeof currentSelectedYear === 'number' && !years.includes(currentSelectedYear)) years.push(currentSelectedYear);
        years.sort((a, b) => b - a);

        yearSelect.innerHTML = '';
        const addOption = (value, label) => {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            opt.selected = value === currentSelectedYear;
            yearSelect.appendChild(opt);
        };
        addOption('all', 'All Time');
        years.forEach(y => addOption(y, String(y)));
        addOption('range', 'Custom range…');
        yearSelect.style.display = 'block';
    }

    /**
     * Range shown when "Custom range" is picked: the period that was on screen
     */
    function defaultRangeFor(selection) {
        const today = toDateStr(new Date());
        if (selection === 'range' && currentRange) return currentRange;
        if (typeof selection === 'number') {
            const yearEnd = `${selection}-12-31`;
            const from = `${selection}-01-01`;
            const to = yearEnd < today && yearEnd >= from ? yearEnd : (today >= from ? today : yearEnd);
            return { from, to };
        }
        const dates = currentEntries.map(e => e.date).filter(Boolean).sort();
        const last = dates[dates.length - 1];
        return {
            from: dates[0] || `${new Date().getFullYear()}-01-01`,
            to: last && last > today ? last : today
        };
    }

    async function loadAndRenderStats(ctx) {
        if (isFetchingDiary) return;
        isFetchingDiary = true;
        showStatsLoading(10, 'Indexing diary...');

        let entries;
        try {
            entries = await fetchEntireDiary(null, undefined, statsProgress('Indexing diary'));
        } catch (err) {
            isFetchingDiary = false;
            document.getElementById('lbst-loading-status').textContent = 'Unable to load diary entries. Please try again.';
            return;
        }
        isFetchingDiary = false;
        currentEntries = entries;

        // On a year URL (e.g. /for/2026/) that year is pre-selected, on the general /diary/ All Time
        currentSelectedYear = ctx.urlYear || 'all';
        populateYearSelect();
        showStatsContent();
        updateStatsForSelectedYear();
    }

    async function updateStatsForSelectedYear() {
        const ctx = getDiaryContext();
        const username = ctx ? ctx.username : 'user';
        const isAllTime = (currentSelectedYear === 'all');
        const isRange = (currentSelectedYear === 'range');

        // All Time and custom ranges need the whole diary: on a /for/YYYY/ page only that year was fetched
        const fullDiaryPath = ctx ? ctx.baseUrl.replace(/for\/.*$/i, '') : '';
        if ((isAllTime || isRange) && ctx && ctx.urlYear && cachedDiaryPath !== `${fullDiaryPath}::null`) {
            showStatsLoading(20, 'Indexing full diary...');
            try {
                currentEntries = await fetchEntireDiary(fullDiaryPath, null, statsProgress('Indexing full diary'));
                populateYearSelect(); // the full diary may have more years
            } catch (err) {}
            showStatsContent();
        }

        // Date inputs, bounded by the diary's first entry and today
        const rangeBox = document.getElementById('lbst-range-inputs');
        rangeBox.hidden = !isRange;
        if (isRange) {
            if (!currentRange) currentRange = defaultRangeFor('all');
            const fromInput = document.getElementById('lbst-range-from');
            const toInput = document.getElementById('lbst-range-to');
            const dates = currentEntries.map(e => e.date).filter(Boolean).sort();
            const today = toDateStr(new Date());
            const last = dates[dates.length - 1];
            fromInput.min = toInput.min = dates[0] || '';
            fromInput.max = toInput.max = last && last > today ? last : today;
            fromInput.value = currentRange.from;
            toInput.value = currentRange.to;
        }

        const stats = computeDiaryStats(currentEntries, currentSelectedYear, currentRange);
        currentStatsData = stats;

        const titleEl = document.getElementById('lbst-header-title');
        const subEl = document.getElementById('lbst-header-sub');
        const filmsText = `${stats.totalFilms} film${stats.totalFilms === 1 ? '' : 's'} logged`;

        if (isAllTime) {
            titleEl.textContent = 'Diary Statistics • All Time';
            subEl.textContent = stats.minYear !== stats.maxYear
                ? `@${username} • ${filmsText} in total (${stats.minYear}–${stats.maxYear})`
                : `@${username} • ${filmsText} in total`;
        } else if (isRange) {
            const days = Math.round((parseDateStr(currentRange.to) - parseDateStr(currentRange.from)) / 86400000) + 1;
            titleEl.textContent = `Diary Statistics • ${formatRangeLabel(currentRange)}`;
            subEl.textContent = `@${username} • ${filmsText} in ${days.toLocaleString('en-US')} day${days === 1 ? '' : 's'}`;
        } else {
            titleEl.textContent = `Diary Statistics • ${currentSelectedYear}`;
            subEl.textContent = `@${username} • ${filmsText} in ${currentSelectedYear}`;
        }
        appendMissingPagesWarning(subEl);

        renderStatsUI(stats);
        requestRuntimesForCurrentView();
    }

    /**
     * Films page (/member/films/): watched films without dates
     */
    async function loadAndRenderFilmStats(ctx) {
        if (isFetchingDiary) return;
        isFetchingDiary = true;
        showStatsLoading(10, 'Indexing watched films...');

        let films;
        try {
            films = await fetchWatchedFilms(ctx.baseUrl, statsProgress('Indexing watched films'));
        } catch (err) {
            isFetchingDiary = false;
            document.getElementById('lbst-loading-status').textContent = 'Unable to load watched films. Please try again.';
            return;
        }
        isFetchingDiary = false;
        currentEntries = films;
        currentSelectedYear = 'all';
        currentRange = null;
        currentFilmsCtx = ctx;
        showStatsContent();

        const stats = computeFilmsStats(films);
        currentStatsData = stats;
        document.getElementById('lbst-header-title').textContent = ctx.filter ? `Film Statistics • ${ctx.filter}` : 'Film Statistics';

        renderFilmStatsUI(stats);
        requestRuntimesForCurrentView();
        if (countRewatches) applyRewatchOption();
    }

    /**
     * "Count rewatches" switched on or off. The first time on, the member's diary is loaded in the
     * background (the stats stay on screen); after that switching is instant.
     */
    async function applyRewatchOption() {
        if (statsMode !== 'films' || !currentFilmsCtx || !currentStatsData) return;
        const username = currentFilmsCtx.username.toLowerCase();
        const needsDiary = countRewatches && filmViewsUser !== username && !isFetchingFilmViews;

        refreshFilmTotals(); // instant when the diary is already there, "loading diary..." otherwise
        if (!needsDiary) return;

        isFetchingFilmViews = true;
        filmViewsError = false;
        try {
            const { entries, failedPages } = await fetchDiaryForUser(currentFilmsCtx.username, (loaded, total) => {
                if (countRewatches && !filmViewsReady()) {
                    document.getElementById('lbst-metric-avg').textContent = `loading diary... ${loaded}/${total} pages`;
                }
            });
            filmViews = computeFilmViews(entries);
            filmViewsUser = username;
            filmViewsMissingPages = failedPages;
        } catch (err) {
            filmViewsError = true; // switching the option off and on again retries
        } finally {
            isFetchingFilmViews = false;
        }
        refreshFilmTotals();
    }

    function refreshFilmTotals() {
        if (statsMode !== 'films' || !currentStatsData) return;
        currentStatsData = computeFilmsStats(currentEntries);
        updateFilmTotals(currentStatsData, false);
    }

    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    // Heatmap cell whose tooltip is pinned open by a click (lets the user scroll its film list)
    let pinnedTooltipCell = null;

    function placeTooltipAt(x, y) {
        const tooltip = document.getElementById('lbst-floating-tooltip');
        if (!tooltip || tooltip.style.display !== 'block') return;

        const w = tooltip.offsetWidth;
        const h = tooltip.offsetHeight;

        let left = x + 14;
        let top = y + 14;

        if (left + w + 10 > window.innerWidth) {
            left = x - w - 14;
        }
        if (top + h + 10 > window.innerHeight) {
            top = y - h - 14;
        }

        tooltip.style.left = `${Math.max(10, left)}px`;
        tooltip.style.top = `${Math.max(10, top)}px`;
    }

    function positionFloatingTooltip(e) {
        if (pinnedTooltipCell) return;
        placeTooltipAt(e.clientX, e.clientY);
    }

    function unpinTooltip() {
        const tooltip = document.getElementById('lbst-floating-tooltip');
        if (pinnedTooltipCell) {
            pinnedTooltipCell.classList.remove('is-pinned');
            pinnedTooltipCell = null;
        }
        if (tooltip) {
            tooltip.classList.remove('is-pinned');
            tooltip.style.display = 'none';
        }
    }

    /**
     * Cards shared by the diary and the films page (ratings, rewatches, likes, reviews, decades)
     */
    function fillTasteMetrics(stats) {
        const pctOfFilms = (n) => `${stats.totalFilms ? Math.round((n / stats.totalFilms) * 100) : 0}% of films`;
        document.getElementById('lbst-metric-avg-rating').textContent = stats.avgRating !== null ? `★ ${stats.avgRating.toFixed(2)}` : '-';
        document.getElementById('lbst-metric-avg-rating-sub').textContent = stats.ratedCount > 0
            ? `from ${stats.ratedCount.toLocaleString('en-US')} rated film${stats.ratedCount === 1 ? '' : 's'}`
            : 'no rated films';
        document.getElementById('lbst-metric-rewatch').textContent = stats.rewatchCount.toLocaleString('en-US');
        document.getElementById('lbst-metric-rewatch-pct').textContent = pctOfFilms(stats.rewatchCount);
        document.getElementById('lbst-metric-liked').textContent = stats.likedCount.toLocaleString('en-US');
        document.getElementById('lbst-metric-liked-pct').textContent = pctOfFilms(stats.likedCount);
        document.getElementById('lbst-metric-reviews').textContent = stats.reviewCount.toLocaleString('en-US');
        document.getElementById('lbst-metric-reviews-pct').textContent = pctOfFilms(stats.reviewCount);
        document.getElementById('lbst-metric-top-decade').textContent = stats.topDecadeName;
        document.getElementById('lbst-metric-top-decade-count').textContent = `${stats.topDecadeCount} film${stats.topDecadeCount === 1 ? '' : 's'}`;
    }

    function setChartMode(mode) {
        currentChartMode = mode;
        document.querySelectorAll('#lbst-chart-toggles .lbst-toggle-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.chartMode === mode);
        });
    }

    /**
     * Films page: watch time, the shared cards and the Ratings / Decades chart (no dates, so no heatmap)
     */
    function renderFilmStatsUI(stats) {
        fillTasteMetrics(stats);
        updateFilmTotals(stats, true);

        unpinTooltip();
        if (currentChartMode === 'days' || currentChartMode === 'months') setChartMode('ratings');
        renderBarChart(stats);
    }

    /**
     * Films page totals that depend on "Count rewatches": first card, header and watch time
     * (ratings, likes, reviews and decades stay per film)
     */
    function updateFilmTotals(stats, fromZero) {
        const fmt = (n) => n.toLocaleString('en-US');
        const withRewatches = filmViewsReady();
        const rewatches = stats.totalViews - stats.totalFilms;

        document.getElementById('lbst-metric-total-label').textContent = withRewatches ? 'Viewings' : 'Films Watched';
        document.getElementById('lbst-metric-total').textContent = fmt(withRewatches ? stats.totalViews : stats.totalFilms);
        let sub = 'each film counted once';
        if (countRewatches && !withRewatches) {
            sub = filmViewsError ? "couldn't load the diary" : 'loading diary...';
        } else if (withRewatches) {
            sub = `${fmt(stats.totalFilms)} films + ${fmt(rewatches)} rewatch${rewatches === 1 ? '' : 'es'}`;
        }
        document.getElementById('lbst-metric-avg').textContent = sub;

        const ctx = currentFilmsCtx;
        const subEl = document.getElementById('lbst-header-sub');
        subEl.textContent = `@${ctx.username} • ${fmt(stats.totalFilms)} film${stats.totalFilms === 1 ? '' : 's'} watched` +
            (withRewatches ? ` • ${fmt(stats.totalViews)} viewing${stats.totalViews === 1 ? '' : 's'}` : '');
        appendMissingPagesWarning(subEl);
        if (withRewatches && filmViewsMissingPages > 0) {
            const warning = document.createElement('span');
            warning.className = 'lbst-header-warning';
            warning.textContent = ` • ${filmViewsMissingPages} diary page${filmViewsMissingPages === 1 ? '' : 's'} couldn't be loaded`;
            subEl.appendChild(warning);
        }

        renderWatchTime({ fromZero });
    }

    /**
     * Render full stats interface (Summary + Heatmap + Bar chart)
     */
    function renderStatsUI(stats) {
        const isAllTime = stats.isAllTime;
        const spanLabel = { all: 'overall', range: 'of period', year: 'of year' }[stats.kind];

        // 1. Summary Metrics
        document.getElementById('lbst-metric-total-label').textContent = 'Films Logged';
        document.getElementById('lbst-metric-total').textContent = stats.totalFilms.toLocaleString('en-US');
        document.getElementById('lbst-metric-avg').textContent = `${stats.avgPerWeek} / week`;
        document.getElementById('lbst-metric-active').textContent = stats.activeDaysCount;
        document.getElementById('lbst-metric-active-pct').textContent = `${stats.activePercentage}% ${spanLabel}`;
        document.getElementById('lbst-metric-streak').textContent = `${stats.maxStreak} day${stats.maxStreak === 1 ? '' : 's'}`;
        document.getElementById('lbst-metric-streak-range').textContent = stats.streakRangeStr;
        document.getElementById('lbst-metric-record').textContent = stats.maxInSingleDay;
        document.getElementById('lbst-metric-record-date').textContent = stats.recordDayStr
            ? `on ${formatDateStr(stats.recordDayStr, stats.withYear)}`
            : 'no films';

        document.getElementById('lbst-metric-top-month').textContent = stats.topMonthName;
        document.getElementById('lbst-metric-top-month-count').textContent = `${stats.topMonthCount} film${stats.topMonthCount === 1 ? '' : 's'}${isAllTime ? ' (all-time)' : ''}`;

        fillTasteMetrics(stats);
        renderWatchTime({ fromZero: true });

        // 2. Heatmap Months Row
        const monthsRow = document.getElementById('lbst-months-row');
        monthsRow.innerHTML = '';
        stats.monthPositions.forEach(m => {
            const labelEl = document.createElement('span');
            labelEl.className = 'lbst-month-label' + (m.isYear ? ' is-year' : '');
            labelEl.style.left = `${m.weekIdx * 15}px`; // 12px cell + 3px gap
            labelEl.textContent = m.label;
            monthsRow.appendChild(labelEl);
        });

        // 3. Heatmap Weeks Track
        const weeksTrack = document.getElementById('lbst-weeks-track');
        unpinTooltip();
        weeksTrack.innerHTML = '';
        const tooltip = document.getElementById('lbst-floating-tooltip');

        const daysEn = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const monthsLongEn = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

        stats.weeks.forEach(week => {
            const col = document.createElement('div');
            col.className = 'lbst-week-col';

            week.forEach(day => {
                const cell = document.createElement('div');
                if (day.empty) {
                    cell.className = 'lbst-day-cell lbst-cell-empty';
                } else {
                    cell.className = `lbst-day-cell lbst-cell-lvl-${day.level}`;
                    cell.dataset.date = day.dateStr;

                    const fillDayTooltip = (pinned) => {
                        const dateObj = day.dateObj;
                        const formattedDate = `${daysEn[dateObj.getDay()]}, ${monthsLongEn[dateObj.getMonth()]} ${dateObj.getDate()}, ${dateObj.getFullYear()}`;

                        let filmsHtml = '';
                        if (day.films && day.films.length > 0) {
                            filmsHtml = `<ul class="lbst-tooltip-films">${day.films.map(f => `<li>${escapeHtml(f.title)}${f.rating ? ` <span class="lbst-tooltip-stars">${formatStars(f.rating)}</span>` : ''}</li>`).join('')}</ul>`;
                        }

                        const countText = day.count === 0 ? 'No films logged' : `${day.count} film${day.count === 1 ? '' : 's'} logged:`;
                        const hintText = day.count > 0
                            ? `<div class="lbst-tooltip-hint">${pinned ? 'Click elsewhere to close' : 'Click to pin'}</div>`
                            : '';

                        tooltip.innerHTML = `
                            <div class="lbst-tooltip-date">${formattedDate}</div>
                            <div class="lbst-tooltip-count">${countText}</div>
                            ${filmsHtml}
                            ${hintText}
                        `;
                        tooltip.classList.toggle('is-pinned', pinned);
                        tooltip.style.display = 'block';
                    };

                    cell.addEventListener('mouseenter', (e) => {
                        if (pinnedTooltipCell) return;
                        fillDayTooltip(false);
                        positionFloatingTooltip(e);
                    });

                    cell.addEventListener('mousemove', positionFloatingTooltip);

                    cell.addEventListener('mouseleave', () => {
                        if (!pinnedTooltipCell) tooltip.style.display = 'none';
                    });

                    // Click pins the tooltip so its film list can be scrolled
                    cell.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (pinnedTooltipCell === cell) {
                            unpinTooltip();
                            return;
                        }
                        unpinTooltip();
                        if (day.count === 0) return;
                        pinnedTooltipCell = cell;
                        cell.classList.add('is-pinned');
                        fillDayTooltip(true);
                        const rect = cell.getBoundingClientRect();
                        placeTooltipAt(rect.right - 6, rect.bottom - 6);
                    });
                }
                col.appendChild(cell);
            });

            weeksTrack.appendChild(col);
        });

        // 4. Auto-scroll heatmap to the right on multi-year spans so the latest weeks are visible first
        const heatmapCard = document.querySelector('.lbst-heatmap-card');
        if (heatmapCard) {
            if (stats.withYear) {
                requestAnimationFrame(() => {
                    heatmapCard.scrollLeft = heatmapCard.scrollWidth;
                });
            } else {
                heatmapCard.scrollLeft = 0;
            }
        }

        // 5. Bar Chart
        renderBarChart(stats);

        // 6. On This Day
        renderOnThisDay();
    }

    /**
     * Watch Time card: counts up as runtimes arrive, for the period selected in the year picker
     */
    let displayedWatchMinutes = 0;
    let watchTimeTweenFrame = null;
    let watchTimeRenderTimer = null;
    let watchTimeWasLoading = false;

    function formatDuration(minutes) {
        const total = Math.round(minutes);
        const h = Math.floor(total / 60);
        const m = total % 60;
        if (h === 0) return `${m}m`;
        return `${h.toLocaleString('en-US')}h ${String(m).padStart(2, '0')}m`;
    }

    function formatWatchDays(minutes) {
        const days = minutes / 1440;
        const shown = days >= 10 ? Math.round(days).toLocaleString('en-US') : days.toFixed(1);
        return `≈ ${shown} days nonstop`;
    }

    // Runtimes arrive one by one: repaint at most every 250 ms
    function scheduleWatchTimeRender() {
        if (watchTimeRenderTimer) return;
        watchTimeRenderTimer = setTimeout(() => {
            watchTimeRenderTimer = null;
            renderWatchTime();
        }, 250);
    }

    function replayClass(el, cls) {
        el.classList.remove(cls);
        void el.offsetWidth; // restart the CSS animation
        el.classList.add(cls);
    }

    function tweenWatchTime(from, to, duration, describe) {
        const valueEl = document.getElementById('lbst-metric-watchtime');
        const daysEl = document.getElementById('lbst-metric-watchtime-days');
        if (watchTimeTweenFrame) cancelAnimationFrame(watchTimeTweenFrame);
        watchTimeTweenFrame = null;

        const draw = (minutes) => {
            displayedWatchMinutes = minutes;
            valueEl.textContent = formatDuration(minutes);
            daysEl.textContent = describe(minutes);
        };

        const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (from === to || reduceMotion) {
            draw(to);
            return;
        }

        const start = performance.now();
        const step = (now) => {
            const t = Math.min(1, (now - start) / duration);
            const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
            draw(from + (to - from) * eased);
            watchTimeTweenFrame = t < 1 ? requestAnimationFrame(step) : null;
        };
        watchTimeTweenFrame = requestAnimationFrame(step);
    }

    function renderWatchTime(options = {}) {
        const card = document.getElementById('lbst-watchtime-card');
        if (!card || !currentStatsData) return;

        const stats = currentStatsData;
        const wt = computeWatchTime(entriesForSelection(currentEntries));
        const loading = wt.pendingFilms > 0;
        const doneFilms = wt.totalFilms - wt.pendingFilms;
        const fmt = (n) => n.toLocaleString('en-US');

        const statusEl = document.getElementById('lbst-watchtime-status');
        if (loading) {
            statusEl.textContent = `Fetching runtimes · ${fmt(doneFilms)} / ${fmt(wt.totalFilms)} films`;
        } else if (wt.untimedEntries > 0) {
            statusEl.textContent = `· ${fmt(wt.untimedEntries)} without runtime`;
        } else {
            statusEl.textContent = '';
        }
        const untimedNoun = statsMode === 'films'
            ? `film${wt.untimedEntries === 1 ? ' has' : 's have'}`
            : `diary entr${wt.untimedEntries === 1 ? 'y has' : 'ies have'}`;
        statusEl.title = wt.untimedEntries > 0
            ? `${fmt(wt.untimedEntries)} ${untimedNoun} no runtime on Letterboxd and ${wt.untimedEntries === 1 ? 'is' : 'are'} not counted`
            : '';

        document.getElementById('lbst-watchtime-progress-fill').style.width =
            `${wt.totalFilms ? Math.round((doneFilms / wt.totalFilms) * 100) : 100}%`;
        if (loading) card.classList.remove('is-complete');
        card.classList.toggle('is-loading', loading);

        document.getElementById('lbst-watchtime-avg').textContent =
            wt.timedEntries > 0 ? formatDuration(wt.minutes / wt.timedEntries) : '-';
        document.getElementById('lbst-watchtime-week').textContent =
            wt.minutes > 0 && stats.totalWeeks ? formatDuration(wt.minutes / stats.totalWeeks) : '-';

        const describe = (minutes) => {
            if (!stats.totalFilms) return statsMode === 'films' ? 'no films' : 'no films logged';
            if (minutes < 1) return loading ? 'counting...' : 'no runtime found';
            return formatWatchDays(minutes);
        };
        const from = options.fromZero ? 0 : displayedWatchMinutes;
        tweenWatchTime(from, wt.minutes, options.fromZero ? 900 : 650, describe);

        // One "settle" flash when the count completes (not when everything was already cached)
        if (watchTimeWasLoading && !loading && !options.fromZero) {
            replayClass(card, 'is-complete');
        }
        watchTimeWasLoading = loading && runtimeStoreLoaded;
    }

    /**
     * "On This Day": films logged on today's date in previous years
     */
    function renderOnThisDay() {
        const container = document.getElementById('lbst-onthisday');
        if (!container) return;
        container.innerHTML = '';

        const ctx = getDiaryContext();
        const onThisDay = computeOnThisDay(currentEntries);
        document.getElementById('lbst-onthisday-title').textContent = `On This Day • ${onThisDay.label}`;

        if (onThisDay.years.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'lbst-onthisday-empty';
            // On a /for/YYYY/ page only that year is loaded until "All Time" is picked
            const fullDiaryLoaded = !(ctx && ctx.urlYear) || cachedDiaryPath === `${ctx.baseUrl.replace(/for\/.*$/i, '')}::null`;
            empty.textContent = fullDiaryLoaded
                ? `Nothing logged on ${onThisDay.label} in previous years.`
                : `Select “All Time” to look back at previous years.`;
            container.appendChild(empty);
            return;
        }

        const currentYear = new Date().getFullYear();
        onThisDay.years.forEach(({ year, films }) => {
            const row = document.createElement('div');
            row.className = 'lbst-onthisday-row';

            const yearEl = document.createElement('div');
            yearEl.className = 'lbst-onthisday-year';
            const ago = currentYear - year;
            yearEl.innerHTML = `<strong>${year}</strong><span>${ago} year${ago === 1 ? '' : 's'} ago</span>`;

            const filmsEl = document.createElement('div');
            filmsEl.className = 'lbst-onthisday-films';
            films.forEach(f => {
                const chip = document.createElement('span');
                chip.className = 'lbst-onthisday-film';
                chip.textContent = f.title;
                if (f.rating) {
                    const stars = document.createElement('span');
                    stars.className = 'lbst-onthisday-stars';
                    stars.textContent = formatStars(f.rating);
                    chip.appendChild(stars);
                }
                filmsEl.appendChild(chip);
            });

            row.appendChild(yearEl);
            row.appendChild(filmsEl);
            container.appendChild(row);
        });
    }

    /**
     * Render Bar Chart (Days of week, Months, Ratings or Release decades)
     */
    function renderBarChart(stats) {
        const container = document.getElementById('lbst-chart-container');
        if (!container) return;
        container.innerHTML = '';

        const tooltip = document.getElementById('lbst-floating-tooltip');
        const modes = {
            days: { dataset: stats.dayStats, total: stats.totalFilms, ofLabel: 'of total' },
            months: { dataset: stats.monthStats, total: stats.totalFilms, ofLabel: 'of total' },
            ratings: { dataset: stats.ratingStats, total: stats.ratedCount, ofLabel: 'of rated films', empty: 'No rated films in this period.' },
            decades: { dataset: stats.decadeStats, total: stats.datedFilmsCount, ofLabel: 'of films', empty: 'No release years found in this period.' }
        };
        const mode = modes[currentChartMode] || modes.days;
        const dataset = mode.dataset;
        const total = mode.total || 1;

        container.classList.toggle('-dense', dataset.length > 12);

        if (mode.empty && !mode.total) {
            const empty = document.createElement('div');
            empty.className = 'lbst-chart-empty';
            empty.textContent = mode.empty;
            container.appendChild(empty);
            return;
        }

        const maxVal = Math.max(...dataset.map(d => d.count), 1);

        dataset.forEach(item => {
            const group = document.createElement('div');
            group.className = 'lbst-chart-bar-group';

            const pct = Math.round((item.count / total) * 100);
            const barHeightPct = item.count > 0 ? Math.max(6, Math.round((item.count / maxVal) * 100)) : 0;

            const valEl = document.createElement('div');
            valEl.className = 'lbst-bar-value';
            valEl.textContent = item.count;

            const trackEl = document.createElement('div');
            trackEl.className = 'lbst-bar-track';

            const fillEl = document.createElement('div');
            fillEl.className = 'lbst-bar-fill';
            fillEl.style.height = '0%';

            trackEl.appendChild(fillEl);

            const labelEl = document.createElement('div');
            labelEl.className = 'lbst-bar-label';
            labelEl.textContent = item.short;

            group.appendChild(valEl);
            group.appendChild(trackEl);
            group.appendChild(labelEl);

            group.addEventListener('mouseenter', (e) => {
                if (pinnedTooltipCell) return;
                tooltip.innerHTML = `
                    <div class="lbst-tooltip-date">${item.name}</div>
                    <div class="lbst-tooltip-count">${item.count} film${item.count === 1 ? '' : 's'} (${pct}% ${mode.ofLabel})</div>
                `;
                tooltip.style.display = 'block';
                positionFloatingTooltip(e);
            });

            group.addEventListener('mousemove', positionFloatingTooltip);

            group.addEventListener('mouseleave', () => {
                if (!pinnedTooltipCell) tooltip.style.display = 'none';
            });

            container.appendChild(group);

            // Animate bar fill
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    fillEl.style.height = `${barHeightPct}%`;
                });
            });
        });
    }

    /* ==========================================================================
       Letterboxd Follow Check (who doesn't follow back)
       ========================================================================== */

    const MEMBERS_PER_PAGE = 25;
    const MAX_FOLLOW_LIST_SIZE = 5000; // 200 pages per list, beyond that the scan is too slow

    let cachedFollowData = null; // { username, following: Map, followers: Map }
    let isFetchingFollows = false;
    let currentFollowTab = 'not-following-back'; // or 'not-followed-back'

    /**
     * Examples:
     * - /antrubtor/following/
     * - /antrubtor/followers/
     * - /antrubtor/followers/by/name/page/2/
     */
    function isFollowPage() {
        return /^\/[^\/]+\/(?:following|followers)(?:\/|$)/i.test(window.location.pathname);
    }

    function getFollowContext() {
        const match = window.location.pathname.match(/^\/([^\/]+)\/(following|followers)(?:\/|$)/i);
        if (!match) return null;
        return {
            username: match[1],
            kind: match[2].toLowerCase()
        };
    }

    function extractMembersFromDoc(doc) {
        const members = [];
        doc.querySelectorAll('table.member-table tbody tr, table.person-table tbody tr').forEach(row => {
            const link = row.querySelector('a.name') || row.querySelector('.person-summary h3 a');
            const href = link?.getAttribute('href') || '';
            const m = href.match(/^\/([^\/]+)\/?$/);
            if (!m) return;

            const img = row.querySelector('a.avatar img, .avatar img');
            // Native Follow / Following buttons (only rendered when logged in) carry the action endpoints
            const followBtn = row.querySelector('.js-button-follow');
            const unfollowBtn = row.querySelector('.js-button-following');
            members.push({
                username: m[1].toLowerCase(),
                displayName: link.textContent.replace(/\s+/g, ' ').trim() || m[1],
                avatar: img?.getAttribute('src') || '',
                link: `https://letterboxd.com/${m[1]}/`,
                followAction: followBtn?.getAttribute('data-action') || null,
                unfollowAction: unfollowBtn?.getAttribute('data-action') || null
            });
        });
        return members;
    }

    /**
     * Logged-in member. The page first declares `person = { username: "" }` as a default,
     * then a later inline script sets `person.username = "Name"` when signed in.
     */
    function getLoggedInUsername() {
        let username = null;
        for (const script of document.querySelectorAll('script:not([src])')) {
            const re = /person(?:\s*=\s*\{\s*|\.)username\s*[:=]\s*"([^"]*)"/g;
            let m;
            while ((m = re.exec(script.textContent)) !== null) {
                if (m[1]) username = m[1].toLowerCase();
            }
        }
        return username;
    }

    /**
     * Follow / unfollow a member as the logged-in user.
     * Rather than replaying the request, this clicks an off-screen copy of Letterboxd's own
     * follow button: the site's handler adds the CSRF token and solves the captcha that
     * following may require, then hides the clicked button once it succeeds.
     */
    function setFollowState(member, follow) {
        return new Promise((resolve, reject) => {
            let host = document.getElementById('lbfl-native-actions');
            if (!host) {
                host = document.createElement('div');
                host.id = 'lbfl-native-actions';
                host.setAttribute('aria-hidden', 'true');
                document.body.appendChild(host);
            }

            const wrapper = document.createElement('div');
            wrapper.className = 'follow-button-wrapper js-follow-button-wrapper';
            wrapper.dataset.username = member.username;

            const unfollowLink = document.createElement('a');
            unfollowLink.href = '#';
            unfollowLink.className = 'ajax-click-action button -compact -following js-button-following';
            unfollowLink.dataset.action = member.unfollowAction || `/${member.username}/unfollow/`;
            unfollowLink.innerHTML = '<span class="button-text">Following</span>';

            const followLink = document.createElement('a');
            followLink.href = '#';
            followLink.className = 'ajax-click-action button -compact -follow js-button-follow';
            followLink.dataset.action = member.followAction || `/${member.username}/follow/`;
            followLink.dataset.captchaAction = 'follow';
            followLink.innerHTML = '<span class="button-text">Follow</span>';

            (follow ? unfollowLink : followLink).hidden = true;
            wrapper.appendChild(unfollowLink);
            wrapper.appendChild(followLink);
            host.appendChild(wrapper);

            const target = follow ? followLink : unfollowLink;
            let started = false;
            let settled = false;

            const finish = (ok) => {
                if (settled) return;
                settled = true;
                observer.disconnect();
                clearTimeout(timeout);
                wrapper.remove();
                if (ok) resolve();
                else reject(new Error('Letterboxd refused the request (see the message at the top of the page).'));
            };

            // The site marks the button `ajax-disabled` while working and sets `hidden` on success
            const observer = new MutationObserver(() => {
                if (target.hidden) {
                    finish(true);
                } else if (target.classList.contains('ajax-disabled')) {
                    started = true;
                } else if (started) {
                    // Work complete without hiding: give the success fade a moment before calling it a failure
                    setTimeout(() => finish(target.hidden), 800);
                }
            });
            observer.observe(target, { attributes: true, attributeFilter: ['class', 'hidden'] });

            // Captcha can take a while; past this point assume it failed
            const timeout = setTimeout(() => finish(target.hidden), 30000);

            target.click();
        });
    }

    /**
     * Total list size from the "Following" / "Followers" tab tooltip (e.g. title="80 people")
     */
    function detectFollowCount(doc, username, kind) {
        const links = doc.querySelectorAll(`a[href="/${username}/${kind}/" i][title]`);
        for (const a of links) {
            const digits = (a.getAttribute('title') || '').replace(/[^\d]/g, '');
            if (digits) return parseInt(digits, 10);
        }
        return null;
    }

    /**
     * Fetch every member of /user/following/ or /user/followers/
     */
    async function fetchMemberList(username, kind, onProgress) {
        const basePath = `/${username}/${kind}/`;
        const members = new Map();
        const addAll = (list) => list.forEach(m => members.set(m.username, m));

        const firstDoc = await fetchDocument(basePath);
        addAll(extractMembersFromDoc(firstDoc));

        const total = detectFollowCount(firstDoc, username, kind);
        if (total !== null && total > MAX_FOLLOW_LIST_SIZE) {
            throw new Error(`Too many ${kind} to compare (${total.toLocaleString('en-US')}, limit is ${MAX_FOLLOW_LIST_SIZE.toLocaleString('en-US')}).`);
        }

        if (total !== null) {
            const totalPages = Math.ceil(total / MEMBERS_PER_PAGE);
            onProgress?.(1, totalPages);

            const BATCH_SIZE = 5;
            for (let p = 2; p <= totalPages; p += BATCH_SIZE) {
                const batch = [];
                for (let n = p; n < p + BATCH_SIZE && n <= totalPages; n++) batch.push(n);
                const docs = await Promise.all(batch.map(n => fetchDocument(`${basePath}page/${n}/`)));
                docs.forEach(doc => addAll(extractMembersFromDoc(doc)));
                onProgress?.(Math.min(p + BATCH_SIZE - 1, totalPages), totalPages);
            }
        } else {
            // No count available: walk the "Next" links one page at a time
            let doc = firstDoc;
            let page = 1;
            while (page < MAX_FOLLOW_LIST_SIZE / MEMBERS_PER_PAGE) {
                const next = doc.querySelector('.pagination a.next, .paginate-nextprev a.next');
                if (!next) break;
                page++;
                onProgress?.(page, null);
                doc = await fetchDocument(next.getAttribute('href'));
                addAll(extractMembersFromDoc(doc));
            }
        }

        return members;
    }

    const SVG_FOLLOW_ICON = `
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
            <circle cx="9" cy="8" r="3.5" stroke="#99aabb" stroke-width="1.8"/>
            <path d="M2.5 19.5c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" stroke="#99aabb" stroke-width="1.8" stroke-linecap="round"/>
            <path d="M16 8h6" stroke="#ff8000" stroke-width="2" stroke-linecap="round"/>
            <path d="M16.5 12.5l2 2 3.5-4" stroke="#00e054" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
    `;

    function injectFollowButton() {
        if (document.getElementById('lbfl-follow-btn')) return;
        const ctx = getFollowContext();
        if (!ctx) return;

        const tooltipText = ctx.kind === 'following' ? 'Not following back' : 'Not followed back';

        const btn = document.createElement('button');
        btn.id = 'lbfl-follow-btn';
        btn.setAttribute('aria-label', tooltipText);
        btn.innerHTML = `
            ${SVG_FOLLOW_ICON}
            <div id="lbfl-follow-tooltip">${tooltipText}</div>
        `;
        btn.addEventListener('click', openFollowModal);
        document.body.appendChild(btn);
    }

    function removeFollowButton() {
        document.getElementById('lbfl-follow-btn')?.remove();
    }

    function injectFollowModal() {
        if (document.getElementById('lbfl-modal-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'lbfl-modal-overlay';
        overlay.innerHTML = `
            <div id="lbfl-modal-container">
                <div class="lbst-modal-header">
                    <div class="lbst-header-title-box">
                        <div class="lbrnd-letterboxd-dots">
                            <span class="lbrnd-dot lbrnd-dot-orange"></span>
                            <span class="lbrnd-dot lbrnd-dot-green"></span>
                            <span class="lbrnd-dot lbrnd-dot-cyan"></span>
                        </div>
                        <div>
                            <h3 class="lbst-header-title">Follow Check</h3>
                            <p class="lbst-header-subtitle" id="lbfl-header-sub">Loading...</p>
                        </div>
                    </div>
                    <div class="lbst-header-controls">
                        <button class="lbrnd-btn-icon" id="lbfl-modal-close" title="Close (Esc)">✕</button>
                    </div>
                </div>

                <div id="lbfl-loading-state">
                    <div class="lbst-spinner"></div>
                    <div class="lbst-loading-text" id="lbfl-loading-status">Loading members...</div>
                    <div class="lbst-progress-bar-wrap">
                        <div class="lbst-progress-bar-fill" id="lbfl-progress-fill"></div>
                    </div>
                </div>

                <div class="lbst-modal-body" id="lbfl-content-view" style="display: none;">
                    <div class="lbst-section-header">
                        <div class="lbst-toggle-group">
                            <button class="lbst-toggle-btn" data-tab="not-following-back" id="lbfl-tab-not-following-back"></button>
                            <button class="lbst-toggle-btn" data-tab="not-followed-back" id="lbfl-tab-not-followed-back"></button>
                        </div>
                        <input type="search" class="lbfl-search" id="lbfl-search" placeholder="Filter by name..." autocomplete="off">
                    </div>
                    <p class="lbfl-tab-desc" id="lbfl-tab-desc"></p>
                    <div class="lbfl-member-list" id="lbfl-member-list"></div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        document.getElementById('lbfl-modal-close').addEventListener('click', closeFollowModal);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeFollowModal();
        });

        overlay.querySelectorAll('.lbst-toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                currentFollowTab = btn.dataset.tab;
                renderFollowResults();
            });
        });

        document.getElementById('lbfl-search').addEventListener('input', renderFollowResults);

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.classList.contains('active')) {
                closeFollowModal();
            }
        });
    }

    function openFollowModal() {
        const ctx = getFollowContext();
        if (!ctx) return;

        injectFollowModal();
        document.getElementById('lbfl-modal-overlay').classList.add('active');

        // Default tab matches the page: /following/ -> who doesn't follow back, /followers/ -> who isn't followed back
        currentFollowTab = ctx.kind === 'following' ? 'not-following-back' : 'not-followed-back';
        document.getElementById('lbfl-search').value = '';

        loadFollowData(ctx.username);
    }

    function closeFollowModal() {
        document.getElementById('lbfl-modal-overlay')?.classList.remove('active');
    }

    async function loadFollowData(username) {
        const loadingView = document.getElementById('lbfl-loading-state');
        const contentView = document.getElementById('lbfl-content-view');
        const statusText = document.getElementById('lbfl-loading-status');
        const progressFill = document.getElementById('lbfl-progress-fill');
        const subEl = document.getElementById('lbfl-header-sub');

        if (cachedFollowData && cachedFollowData.username === username.toLowerCase()) {
            loadingView.style.display = 'none';
            contentView.style.display = 'flex';
            renderFollowResults();
            return;
        }
        if (isFetchingFollows) return;
        isFetchingFollows = true;

        loadingView.style.display = 'flex';
        contentView.style.display = 'none';
        progressFill.style.width = '5%';
        subEl.textContent = `@${username} • Comparing following and followers...`;

        // Following counts as the first half of the bar, followers as the second half
        const progressFor = (step, label) => (loaded, total) => {
            const ratio = total ? loaded / total : 0.5;
            progressFill.style.width = `${Math.max(5, Math.round((step + ratio) * 50))}%`;
            statusText.textContent = `Loading ${label}... (page ${loaded}${total ? `/${total}` : ''})`;
        };

        try {
            statusText.textContent = 'Loading following...';
            const following = await fetchMemberList(username, 'following', progressFor(0, 'following'));
            statusText.textContent = 'Loading followers...';
            const followers = await fetchMemberList(username, 'followers', progressFor(1, 'followers'));

            cachedFollowData = { username: username.toLowerCase(), displayUsername: username, following, followers };
            loadingView.style.display = 'none';
            contentView.style.display = 'flex';
            renderFollowResults();
        } catch (err) {
            statusText.textContent = err && err.message && err.message.startsWith('Too many')
                ? err.message
                : 'Unable to load following / followers. Please try again.';
            subEl.textContent = `@${username}`;
        } finally {
            isFetchingFollows = false;
        }
    }

    function getFollowLists() {
        const { following, followers } = cachedFollowData;
        return {
            notFollowingBack: [...following.values()].filter(m => !followers.has(m.username)),
            notFollowedBack: [...followers.values()].filter(m => !following.has(m.username))
        };
    }

    function updateFollowCounts() {
        const { displayUsername, following, followers } = cachedFollowData;
        const { notFollowingBack, notFollowedBack } = getFollowLists();

        document.getElementById('lbfl-header-sub').textContent =
            `@${displayUsername} • following ${following.size.toLocaleString('en-US')} • ${followers.size.toLocaleString('en-US')} follower${followers.size === 1 ? '' : 's'}`;

        const tabFollowing = document.getElementById('lbfl-tab-not-following-back');
        const tabFollowers = document.getElementById('lbfl-tab-not-followed-back');
        tabFollowing.textContent = `Don't follow back (${notFollowingBack.length})`;
        tabFollowers.textContent = `Not followed back (${notFollowedBack.length})`;
        tabFollowing.classList.toggle('active', currentFollowTab === 'not-following-back');
        tabFollowers.classList.toggle('active', currentFollowTab === 'not-followed-back');
    }

    /**
     * Follow / Unfollow button on a member card. After a click the card stays in place with the
     * opposite action (so a mistake can be undone); it leaves the list on the next re-render.
     */
    function createFollowActionButton(member, isFollowing) {
        const btn = document.createElement('button');
        btn.type = 'button';

        const setState = (following) => {
            btn.className = `lbfl-action-btn ${following ? '-unfollow' : '-follow'}`;
            btn.textContent = following ? 'Unfollow' : 'Follow';
            btn.dataset.following = following ? 'true' : 'false';
        };
        setState(isFollowing);

        btn.addEventListener('click', async () => {
            if (btn.disabled) return;
            const follow = btn.dataset.following !== 'true';
            btn.disabled = true;
            btn.textContent = follow ? 'Following...' : 'Unfollowing...';

            try {
                await setFollowState(member, follow);
                if (follow) cachedFollowData.following.set(member.username, member);
                else cachedFollowData.following.delete(member.username);
                setState(follow);
                updateFollowCounts();
            } catch (err) {
                setState(!follow);
                btn.classList.add('-error');
                btn.title = err && err.message ? err.message : 'Request failed';
                btn.textContent = 'Error';
                setTimeout(() => {
                    btn.classList.remove('-error');
                    setState(!follow);
                }, 2500);
            } finally {
                btn.disabled = false;
            }
        });

        return btn;
    }

    function renderFollowResults() {
        if (!cachedFollowData) return;
        const { displayUsername, following } = cachedFollowData;
        const { notFollowingBack, notFollowedBack } = getFollowLists();

        updateFollowCounts();

        // Actions only make sense on your own lists while logged in
        const canAct = getLoggedInUsername() === cachedFollowData.username;

        const isFollowingTab = currentFollowTab === 'not-following-back';
        document.getElementById('lbfl-tab-desc').textContent = isFollowingTab
            ? `People @${displayUsername} follows who don't follow back.`
            : `People following @${displayUsername} who aren't followed back.`;

        const query = document.getElementById('lbfl-search').value.trim().toLowerCase();
        const list = (isFollowingTab ? notFollowingBack : notFollowedBack)
            .filter(m => !query || m.username.includes(query) || m.displayName.toLowerCase().includes(query));

        const container = document.getElementById('lbfl-member-list');
        container.innerHTML = '';

        if (list.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'lbfl-empty';
            empty.textContent = query ? 'No member matches this filter.' : 'Everyone is mutual here 🎉';
            container.appendChild(empty);
            return;
        }

        list.forEach(m => {
            const card = document.createElement('div');
            card.className = 'lbfl-member';

            const profileLink = document.createElement('a');
            profileLink.className = 'lbfl-member-link';
            profileLink.href = m.link;
            profileLink.target = '_blank';
            profileLink.rel = 'noopener';

            const img = document.createElement('img');
            img.className = 'lbfl-member-avatar';
            img.alt = '';
            img.loading = 'lazy';
            if (m.avatar) img.src = m.avatar;

            const info = document.createElement('div');
            info.className = 'lbfl-member-info';
            const name = document.createElement('span');
            name.className = 'lbfl-member-name';
            name.textContent = m.displayName;
            const handle = document.createElement('span');
            handle.className = 'lbfl-member-handle';
            handle.textContent = `@${m.username}`;
            info.appendChild(name);
            info.appendChild(handle);

            profileLink.appendChild(img);
            profileLink.appendChild(info);
            card.appendChild(profileLink);

            if (canAct) {
                card.appendChild(createFollowActionButton(m, following.has(m.username)));
            }
            container.appendChild(card);
        });
    }

    /* ==========================================================================
       Letterboxd Taste Compatibility (compare ratings with another member)
       ========================================================================== */

    const MAX_FILM_PAGES = 150; // 72 films per page: ~10,800 films per member

    const memberFilmsCache = new Map(); // films page URL -> Map(slug -> film)
    let isFetchingCompat = false;
    let currentCompatData = null; // { friend, me, ...computeCompatibility() }
    let currentCompatTab = 'both-loved'; // 'both-loved', 'disagree' or 'recommend'

    /**
     * Someone else's profile page (/dave/) while logged in
     */
    function isCompatPage() {
        return getCompatContext() !== null;
    }

    function getCompatContext() {
        if (!document.body || !document.body.classList.contains('screen-member-profile')) return null;
        const friend = document.body.getAttribute('data-owner') || (window.location.pathname.match(/^\/([^\/]+)\/?$/) || [])[1];
        const me = getLoggedInUsername();
        if (!friend || !me || friend.toLowerCase() === me) return null;
        return { friend, me };
    }

    function extractMemberFilmsFromDoc(doc) {
        const films = [];
        doc.querySelectorAll('ul.grid li.griditem, ul.poster-list li.posteritem, ul.poster-list li.poster-container').forEach(li => {
            const poster = li.querySelector('[data-item-slug], [data-film-slug]');
            if (!poster) return;

            const slug = poster.getAttribute('data-item-slug') || poster.getAttribute('data-film-slug');
            const fullName = poster.getAttribute('data-item-name') || poster.getAttribute('data-film-name') || slug;
            const ratingMatch = li.querySelector('.poster-viewingdata .rating')?.className.match(/rated-(\d+)/);
            const name = fullName.replace(/\s*\(\d{4}\)\s*$/, '');
            const year = (fullName.match(/\((\d{4})\)\s*$/) || [])[1] || '';

            films.push({
                slug,
                name,
                title: name, // same shape as diary entries for the shared stats
                year,
                releaseYear: year ? parseInt(year, 10) : null,
                link: `https://letterboxd.com${poster.getAttribute('data-item-link') || `/film/${slug}/`}`,
                rating: ratingMatch ? parseInt(ratingMatch[1], 10) : null,
                liked: !!li.querySelector('.poster-viewingdata .icon-liked'),
                review: !!li.querySelector('.poster-viewingdata .icon-review')
            });
        });
        return films;
    }

    /**
     * Every film a member has watched (/user/films/) or only those they rated (/user/films/rated/.5-5/)
     */
    async function fetchMemberFilms(username, ratedOnly, onProgress) {
        const baseUrl = `/${username}/films/${ratedOnly ? 'rated/.5-5/' : ''}`;
        if (memberFilmsCache.has(baseUrl)) return memberFilmsCache.get(baseUrl);

        const films = new Map();
        const addAll = (list) => list.forEach(f => films.set(f.slug, f));

        const firstDoc = await fetchDocument(baseUrl);
        const totalPages = detectTotalPages(firstDoc);
        if (totalPages > MAX_FILM_PAGES) {
            throw Object.assign(new Error(`@${username} has too many films to compare (limit is about ${(MAX_FILM_PAGES * 72).toLocaleString('en-US')}).`), { userFacing: true });
        }

        addAll(extractMemberFilmsFromDoc(firstDoc));
        onProgress?.(1, totalPages);

        const pageUrl = pageUrlFor(firstDoc, baseUrl);
        const BATCH_SIZE = 5;
        for (let p = 2; p <= totalPages; p += BATCH_SIZE) {
            const batch = [];
            for (let n = p; n < p + BATCH_SIZE && n <= totalPages; n++) batch.push(n);
            const docs = await Promise.all(batch.map(n => fetchDocument(pageUrl(n))));
            docs.forEach(doc => addAll(extractMemberFilmsFromDoc(doc)));
            onProgress?.(Math.min(p + BATCH_SIZE - 1, totalPages), totalPages);
        }

        memberFilmsCache.set(baseUrl, films);
        return films;
    }

    /**
     * Ratings are half-stars (1..10). The score drops 40 points per star of average gap:
     * identical ratings = 100%, 1★ apart on average = 60%, 2.5★ apart or more = 0%.
     */
    function computeCompatibility(myFilms, theirRatedFilms) {
        const common = [];
        theirRatedFilms.forEach((theirs, slug) => {
            const mine = myFilms.get(slug);
            if (mine && mine.rating && theirs.rating) {
                common.push({ ...theirs, myRating: mine.rating, theirRating: theirs.rating, gap: Math.abs(mine.rating - theirs.rating) });
            }
        });

        const avgGap = common.length > 0 ? common.reduce((sum, f) => sum + f.gap, 0) / common.length / 2 : null;
        const score = avgGap === null ? null : Math.max(0, Math.min(100, Math.round(100 - avgGap * 40)));
        const bySum = (a, b) => (b.myRating + b.theirRating) - (a.myRating + a.theirRating);

        return {
            common,
            avgGap,
            score,
            bothLoved: common.filter(f => f.myRating >= 8 && f.theirRating >= 8).sort(bySum),
            disagreements: common.filter(f => f.gap >= 3).sort((a, b) => b.gap - a.gap || bySum(a, b)),
            // Their 4★+ films you have never logged
            recommendations: [...theirRatedFilms.values()].filter(f => f.rating >= 8 && !myFilms.has(f.slug)).sort((a, b) => b.rating - a.rating)
        };
    }

    function compatLabel(score) {
        if (score >= 85) return 'Soulmates';
        if (score >= 70) return 'Great match';
        if (score >= 55) return 'Good match';
        if (score >= 40) return 'Some common ground';
        return 'Opposite tastes';
    }

    const SVG_COMPAT_ICON = `
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
            <circle cx="9" cy="12" r="6" stroke="#ff8000" stroke-width="1.8"/>
            <circle cx="15" cy="12" r="6" stroke="#40bcf4" stroke-width="1.8"/>
            <path d="M12 7.2a6 6 0 0 1 0 9.6a6 6 0 0 1 0-9.6z" fill="#00e054"/>
        </svg>
    `;

    function injectCompatButton() {
        if (document.getElementById('lbcp-compat-btn')) return;
        const ctx = getCompatContext();
        if (!ctx) return;

        const btn = document.createElement('button');
        btn.id = 'lbcp-compat-btn';
        btn.setAttribute('aria-label', `Taste compatibility with @${ctx.friend}`);
        btn.innerHTML = `
            ${SVG_COMPAT_ICON}
            <div id="lbcp-compat-tooltip">Taste compatibility</div>
        `;
        btn.addEventListener('click', openCompatModal);
        document.body.appendChild(btn);
    }

    function removeCompatButton() {
        document.getElementById('lbcp-compat-btn')?.remove();
    }

    function injectCompatModal() {
        if (document.getElementById('lbcp-modal-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'lbcp-modal-overlay';
        overlay.innerHTML = `
            <div id="lbcp-modal-container">
                <div class="lbst-modal-header">
                    <div class="lbst-header-title-box">
                        <div class="lbrnd-letterboxd-dots">
                            <span class="lbrnd-dot lbrnd-dot-orange"></span>
                            <span class="lbrnd-dot lbrnd-dot-green"></span>
                            <span class="lbrnd-dot lbrnd-dot-cyan"></span>
                        </div>
                        <div>
                            <h3 class="lbst-header-title">Taste Compatibility</h3>
                            <p class="lbst-header-subtitle" id="lbcp-header-sub">Loading...</p>
                        </div>
                    </div>
                    <div class="lbst-header-controls">
                        <button class="lbrnd-btn-icon" id="lbcp-modal-close" title="Close (Esc)">✕</button>
                    </div>
                </div>

                <div id="lbcp-loading-state">
                    <div class="lbst-spinner"></div>
                    <div class="lbst-loading-text" id="lbcp-loading-status">Loading ratings...</div>
                    <div class="lbst-progress-bar-wrap">
                        <div class="lbst-progress-bar-fill" id="lbcp-progress-fill"></div>
                    </div>
                </div>

                <div class="lbst-modal-body" id="lbcp-content-view" style="display: none;">
                    <div class="lbcp-score-row">
                        <div class="lbcp-score-ring" id="lbcp-score-ring"><span id="lbcp-score-value">-</span></div>
                        <div class="lbcp-score-text">
                            <span class="lbcp-score-label" id="lbcp-score-label">-</span>
                            <span class="lbcp-score-sub" id="lbcp-score-sub"></span>
                        </div>
                    </div>
                    <div class="lbst-section-header">
                        <div class="lbst-toggle-group" id="lbcp-tabs">
                            <button class="lbst-toggle-btn" data-tab="both-loved"></button>
                            <button class="lbst-toggle-btn" data-tab="disagree"></button>
                            <button class="lbst-toggle-btn" data-tab="recommend"></button>
                        </div>
                    </div>
                    <p class="lbfl-tab-desc" id="lbcp-tab-desc"></p>
                    <div class="lbcp-film-list" id="lbcp-film-list"></div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        document.getElementById('lbcp-modal-close').addEventListener('click', closeCompatModal);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeCompatModal();
        });

        overlay.querySelectorAll('#lbcp-tabs .lbst-toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                currentCompatTab = btn.dataset.tab;
                renderCompatResults();
            });
        });

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.classList.contains('active')) {
                closeCompatModal();
            }
        });
    }

    function openCompatModal() {
        const ctx = getCompatContext();
        if (!ctx) return;

        injectCompatModal();
        document.getElementById('lbcp-modal-overlay').classList.add('active');
        loadCompatData(ctx);
    }

    function closeCompatModal() {
        document.getElementById('lbcp-modal-overlay')?.classList.remove('active');
    }

    async function loadCompatData(ctx) {
        const loadingView = document.getElementById('lbcp-loading-state');
        const contentView = document.getElementById('lbcp-content-view');
        const statusText = document.getElementById('lbcp-loading-status');
        const progressFill = document.getElementById('lbcp-progress-fill');

        document.getElementById('lbcp-header-sub').textContent = `@${ctx.me} × @${ctx.friend}`;

        if (currentCompatData && currentCompatData.friend.toLowerCase() === ctx.friend.toLowerCase()) {
            loadingView.style.display = 'none';
            contentView.style.display = 'flex';
            renderCompatResults();
            return;
        }
        if (isFetchingCompat) return;
        isFetchingCompat = true;

        loadingView.style.display = 'flex';
        loadingView.classList.remove('is-message');
        contentView.style.display = 'none';
        progressFill.style.width = '5%';

        // Their ratings fill the first half of the bar, your films the second half
        const progressFor = (step, label) => (loaded, total) => {
            progressFill.style.width = `${Math.max(5, Math.round((step + loaded / total) * 50))}%`;
            statusText.textContent = `Loading ${label}... (page ${loaded}/${total})`;
        };

        try {
            statusText.textContent = `Loading @${ctx.friend}'s ratings...`;
            const theirRated = await fetchMemberFilms(ctx.friend, true, progressFor(0, `@${ctx.friend}'s ratings`));
            statusText.textContent = 'Loading your films...';
            const myFilms = await fetchMemberFilms(ctx.me, false, progressFor(1, 'your films'));

            currentCompatData = { friend: ctx.friend, me: ctx.me, ...computeCompatibility(myFilms, theirRated) };
            loadingView.style.display = 'none';
            contentView.style.display = 'flex';
            renderCompatResults();
        } catch (err) {
            statusText.textContent = err && err.userFacing ? err.message : 'Unable to load ratings. Please try again.';
            loadingView.classList.add('is-message');
        } finally {
            isFetchingCompat = false;
        }
    }

    function renderCompatResults() {
        if (!currentCompatData) return;
        const { friend, common, avgGap, score, bothLoved, disagreements, recommendations } = currentCompatData;

        // Score
        const ring = document.getElementById('lbcp-score-ring');
        ring.style.setProperty('--lbcp-score', score === null ? 0 : score);
        document.getElementById('lbcp-score-value').textContent = score === null ? '-' : `${score}%`;
        document.getElementById('lbcp-score-label').textContent = score === null ? 'No films rated by both of you' : compatLabel(score);
        document.getElementById('lbcp-score-sub').textContent = score === null
            ? `Rate some of the films @${friend} rated to get a score.`
            : `Based on ${common.length.toLocaleString('en-US')} film${common.length === 1 ? '' : 's'} you both rated • ${avgGap.toFixed(1)}★ apart on average${common.length < 10 ? ' (few films, rough estimate)' : ''}`;

        // Tabs
        const tabs = {
            'both-loved': { films: bothLoved, label: `Both loved (${bothLoved.length})`, desc: `Films you and @${friend} both rated ★★★★ or more.`, empty: 'No film you both rated ★★★★ or more yet.' },
            'disagree': { films: disagreements, label: `Disagreements (${disagreements.length})`, desc: `Films where your ratings are at least 1.5★ apart.`, empty: 'You never disagree by 1.5★ or more. Impressive.' },
            'recommend': { films: recommendations, label: `Their picks for you (${recommendations.length})`, desc: `Films @${friend} rated ★★★★ or more that you haven't logged.`, empty: `You've seen every film @${friend} rated ★★★★ or more.` }
        };
        document.querySelectorAll('#lbcp-tabs .lbst-toggle-btn').forEach(btn => {
            btn.textContent = tabs[btn.dataset.tab].label;
            btn.classList.toggle('active', btn.dataset.tab === currentCompatTab);
        });

        const tab = tabs[currentCompatTab];
        document.getElementById('lbcp-tab-desc').textContent = tab.desc;

        const container = document.getElementById('lbcp-film-list');
        container.innerHTML = '';

        if (tab.films.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'lbfl-empty';
            empty.textContent = tab.empty;
            container.appendChild(empty);
            return;
        }

        const MAX_ROWS = 200;
        tab.films.slice(0, MAX_ROWS).forEach(f => {
            const row = document.createElement('a');
            row.className = 'lbcp-film';
            row.href = f.link;
            row.target = '_blank';
            row.rel = 'noopener';

            const title = document.createElement('span');
            title.className = 'lbcp-film-title';
            title.textContent = f.name;
            if (f.year) {
                const year = document.createElement('span');
                year.className = 'lbcp-film-year';
                year.textContent = f.year;
                title.appendChild(year);
            }

            const ratings = document.createElement('span');
            ratings.className = 'lbcp-film-ratings';
            const addRating = (who, value, cls) => {
                const el = document.createElement('span');
                el.className = `lbcp-rating ${cls}`;
                el.innerHTML = `<span class="lbcp-rating-who"></span><span class="lbcp-rating-stars"></span>`;
                el.firstChild.textContent = who;
                el.lastChild.textContent = formatStars(value);
                ratings.appendChild(el);
            };
            if (currentCompatTab !== 'recommend') addRating('You', f.myRating, '-me');
            addRating(`@${friend}`, currentCompatTab === 'recommend' ? f.rating : f.theirRating, '-them');

            row.appendChild(title);
            row.appendChild(ratings);
            container.appendChild(row);
        });

        if (tab.films.length > MAX_ROWS) {
            const more = document.createElement('div');
            more.className = 'lbfl-empty';
            more.textContent = `+ ${(tab.films.length - MAX_ROWS).toLocaleString('en-US')} more`;
            container.appendChild(more);
        }
    }

    /* ==========================================================================
       Recommendations (your own profile)
       1. Favourites: the top 10% of your rated films (likes break ties).
       2. Each favourite gives its tags (genres, themes, director, cast, countries, studios,
          languages, decade) and Letterboxd's "similar films", which are the candidates.
       3. Your taste profile is a TF-IDF vector of the favourites' tags. Each candidate is scored on
          how many favourites list it as similar, its cosine similarity with the profile, and its
          Letterboxd rating. Films you've watched or have in your watchlist are left out.
       ========================================================================== */

    const RECS_STORAGE_KEY = 'lbc_recs'; // last results: { user, at, seedCount, ratedCount, items }
    const RECS_TTL_MS = 24 * 3600000;
    const FILM_META_KEY = 'lbc_film_meta'; // slug -> { f: { 'type:id': label }, r, n, y, at }
    const SIMILAR_KEY = 'lbc_similar'; // slug -> { l: [[slug, name, year, filmId, cacheKey]], at }
    const RECS_SEED_SHARE = 0.1;
    const RECS_MIN_SEEDS = 8;
    const RECS_MAX_SEEDS = 50; // 2 requests per favourite: keeps the first run under a minute
    const RECS_CANDIDATES = 60; // candidates whose tags are fetched for the final score
    const RECS_PAGE_SIZE = 24;
    const RECS_MAX_RESULTS = 48;
    const RECS_CONCURRENCY = 3; // Letterboxd's Cloudflare challenges bursts of requests
    const FEATURE_WEIGHTS = { genre: 1, theme: 1.6, mini: 1.3, director: 2.2, cast: 0.7, country: 0.4, language: 0.5, studio: 0.5, decade: 0.4 };
    const FEATURE_PATTERNS = [
        ['genre', /^\/films\/genre\/([^\/]+)\/?$/],
        ['theme', /^\/films\/theme\/([^\/]+)\//],
        ['mini', /^\/films\/mini-theme\/([^\/]+)\//],
        ['director', /^\/director\/([^\/]+)\/?$/],
        ['cast', /^\/actor\/([^\/]+)\/?$/],
        ['country', /^\/films\/country\/([^\/]+)\/?$/],
        ['language', /^\/films\/language\/([^\/]+)\/?$/],
        ['studio', /^\/studio\/([^\/]+)\/?$/]
    ];
    const FEATURE_CAPS = { cast: 8, studio: 3, language: 2, country: 3 };

    let isComputingRecs = false;
    let recsShown = RECS_PAGE_SIZE;
    let currentRecs = null;

    /**
     * Slug-keyed cache kept in extension storage, with an age limit and a size cap
     */
    function createPersistentCache(key, ttlMs, maxEntries) {
        let data = {};
        let loading = null;
        let timer = null;
        return {
            load() {
                if (!loading) {
                    loading = storageGet(key).then((stored) => {
                        data = stored && typeof stored === 'object' ? stored : {};
                    });
                }
                return loading;
            },
            get(id) {
                const entry = data[id];
                return entry && Date.now() - entry.at < ttlMs ? entry : null;
            },
            set(id, value) {
                data[id] = { ...value, at: Date.now() };
                if (timer) return;
                timer = setTimeout(() => {
                    timer = null;
                    const ids = Object.keys(data);
                    if (ids.length > maxEntries) {
                        ids.sort((a, b) => data[a].at - data[b].at)
                            .slice(0, ids.length - maxEntries)
                            .forEach(id => delete data[id]);
                    }
                    storageSet(key, data);
                }, 1500);
            }
        };
    }

    const filmMetaCache = createPersistentCache(FILM_META_KEY, 30 * 86400000, 1500);
    const similarCache = createPersistentCache(SIMILAR_KEY, 14 * 86400000, 300);

    // Runs fn over items with at most `limit` running at once; a failing item gives null
    async function mapWithConcurrency(items, limit, fn, onProgress) {
        const results = new Array(items.length).fill(null);
        let next = 0;
        let done = 0;
        const worker = async () => {
            while (next < items.length) {
                const i = next++;
                try {
                    results[i] = await fn(items[i], i);
                } catch (e) {
                    results[i] = null;
                }
                done++;
                onProgress?.(done, items.length);
            }
        };
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
        return results;
    }

    /**
     * Tags, rating and year from a film page
     */
    function extractFilmMeta(doc) {
        const f = {};
        const used = {};
        doc.querySelectorAll('a[href]').forEach(a => {
            const href = a.getAttribute('href');
            for (const [type, re] of FEATURE_PATTERNS) {
                const m = href.match(re);
                if (!m) continue;
                const key = `${type}:${m[1]}`;
                if (f[key] !== undefined) break;
                if (FEATURE_CAPS[type]) {
                    used[type] = (used[type] || 0) + 1;
                    if (used[type] > FEATURE_CAPS[type]) break;
                }
                f[key] = (a.textContent || m[1]).replace(/\s+/g, ' ').trim() || m[1];
                break;
            }
        });

        let r = null;
        let n = 0;
        let p = '';
        const ld = doc.querySelector('script[type="application/ld+json"]');
        if (ld) {
            try {
                const data = JSON.parse(ld.textContent.replace(/\/\*[\s\S]*?\*\//g, ''));
                const rating = data.aggregateRating || {};
                r = rating.ratingValue ? Number(rating.ratingValue) : null;
                n = rating.ratingCount ? Number(rating.ratingCount) : 0;
                // The real poster (custom / TMDb posters included), asked in thumbnail size
                if (typeof data.image === 'string' && data.image.startsWith('https://')) {
                    p = data.image.replace(/-0-\d+-0-\d+-crop/, '-0-230-0-345-crop');
                }
            } catch (e) {}
        }
        const yearMatch = (doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || '').match(/\((\d{4})\)\s*$/);
        const y = yearMatch ? parseInt(yearMatch[1], 10) : null;
        if (y) {
            const decade = Math.floor(y / 10) * 10;
            f[`decade:${decade}`] = `${decade}s`;
        }
        return { f, r, n, y, p };
    }

    async function fetchFilmMeta(slug) {
        const cached = filmMetaCache.get(slug);
        if (cached) return cached;
        const meta = extractFilmMeta(await fetchDocument(`/film/${slug}/`));
        filmMetaCache.set(slug, meta);
        return meta;
    }

    // Letterboxd's "similar films" for a film, most similar first (the film itself left out)
    async function fetchSimilarFilms(slug) {
        const cached = similarCache.get(slug);
        if (cached) return cached.l;
        const doc = await fetchDocument(`/film/${slug}/similar/`);
        const list = extractMoviesFromDoc(doc)
            .map(m => [m.slug.replace(/^\/film\//, '').replace(/\/$/, ''), m.name, m.year || '', m.filmId || '', m.cacheKey || ''])
            .filter(item => item[0] && item[0] !== slug);
        similarCache.set(slug, { l: list });
        return list;
    }

    /**
     * The recommendation pipeline. onProgress(step, done, total) drives the loading view.
     */
    async function computeRecommendations(username, onProgress) {
        await Promise.all([filmMetaCache.load(), similarCache.load()]);

        // 1. Watched films (ratings, likes) and watchlist
        onProgress('films', 0, 1);
        const [films, watchlist] = await Promise.all([
            fetchWatchedFilms(`/${username}/films/`, (loaded, total) => onProgress('films', loaded, total)),
            fetchAllPages(`/${username}/watchlist/`, extractMemberFilmsFromDoc).then(r => r.items).catch(() => [])
        ]);

        const rated = films.filter(f => f.rating);
        if (rated.length < 5) {
            throw Object.assign(new Error('Rate at least 5 films to get recommendations.'), { userFacing: true });
        }

        // 2. Favourites: highest rated first, liked films first among equals, then most recently added
        const seedCount = Math.min(rated.length, Math.max(RECS_MIN_SEEDS, Math.min(RECS_MAX_SEEDS, Math.ceil(rated.length * RECS_SEED_SHARE))));
        const seeds = rated
            .map((film, order) => ({ film, order }))
            .sort((a, b) => (b.film.rating - a.film.rating) || ((b.film.liked ? 1 : 0) - (a.film.liked ? 1 : 0)) || (a.order - b.order))
            .slice(0, seedCount)
            .map(x => x.film);
        const lowestSeedRating = Math.min(...seeds.map(s => s.rating));
        const seedWeight = (s) => 1 + (s.rating - lowestSeedRating) / 2 + (s.liked ? 0.5 : 0);

        const seedTasks = seeds.flatMap(s => [{ kind: 'meta', slug: s.slug }, { kind: 'similar', slug: s.slug }]);
        const seedResults = await mapWithConcurrency(seedTasks, RECS_CONCURRENCY,
            (task) => task.kind === 'meta' ? fetchFilmMeta(task.slug) : fetchSimilarFilms(task.slug),
            (done, total) => onProgress('seeds', done, total));
        const seedMeta = new Map();
        const seedSimilar = new Map();
        seedTasks.forEach((task, i) => {
            if (!seedResults[i]) return;
            (task.kind === 'meta' ? seedMeta : seedSimilar).set(task.slug, seedResults[i]);
        });

        // 3. Candidates: films similar to several favourites, minus watched / watchlist ones
        const excluded = new Set(films.map(f => f.slug).concat(watchlist.map(f => f.slug)));
        const candidates = new Map();
        seeds.forEach(seed => {
            const w = seedWeight(seed);
            (seedSimilar.get(seed.slug) || []).forEach(([slug, name, year, filmId, cacheKey], rank) => {
                if (excluded.has(slug)) return;
                const contribution = w / (1 + rank / 15);
                const c = candidates.get(slug) || { slug, name, year, filmId, cacheKey, coScore: 0, sources: [] };
                c.coScore += contribution;
                c.sources.push({ title: seed.name, contribution });
                candidates.set(slug, c);
            });
        });
        if (candidates.size === 0) {
            throw Object.assign(new Error("Couldn't find similar films for your favourites. Try again in a moment."), { userFacing: true });
        }

        const shortlist = [...candidates.values()].sort((a, b) => b.coScore - a.coScore).slice(0, RECS_CANDIDATES);
        const shortlistMeta = await mapWithConcurrency(shortlist, RECS_CONCURRENCY,
            (c) => fetchFilmMeta(c.slug),
            (done, total) => onProgress('candidates', done, total));

        // 4. TF-IDF taste profile and cosine similarity
        onProgress('scoring', 1, 1);
        const corpus = [...seedMeta.values(), ...shortlistMeta.filter(Boolean)];
        const docFreq = {};
        corpus.forEach(meta => Object.keys(meta.f).forEach(k => { docFreq[k] = (docFreq[k] || 0) + 1; }));
        const featureWeight = (k) => (FEATURE_WEIGHTS[k.split(':')[0]] || 0.5) * (Math.log((corpus.length + 1) / ((docFreq[k] || 0) + 1)) + 1);

        const profile = {};
        seeds.forEach(seed => {
            const meta = seedMeta.get(seed.slug);
            if (!meta) return;
            const w = seedWeight(seed);
            Object.keys(meta.f).forEach(k => { profile[k] = (profile[k] || 0) + w; });
        });
        Object.keys(profile).forEach(k => { profile[k] *= featureWeight(k); });
        const profileNorm = Math.sqrt(Object.values(profile).reduce((sum, v) => sum + v * v, 0)) || 1;

        const scored = shortlist.map((c, i) => {
            const meta = shortlistMeta[i];
            let cosine = 0;
            let shared = [];
            if (meta) {
                let dot = 0;
                let norm = 0;
                Object.keys(meta.f).forEach(k => {
                    const v = featureWeight(k);
                    norm += v * v;
                    if (profile[k]) {
                        dot += profile[k] * v;
                        shared.push({ key: k, label: meta.f[k], weight: profile[k] * v });
                    }
                });
                cosine = norm ? dot / (profileNorm * Math.sqrt(norm)) : 0;
            }
            // Strongest shared tags, one per kind (a director, a theme, a genre...). Decades,
            // countries and languages count in the score but say little as a reason.
            shared.sort((a, b) => b.weight - a.weight);
            const tags = [];
            const kinds = new Set();
            shared.forEach(s => {
                const kind = s.key.split(':')[0] === 'mini' ? 'theme' : s.key.split(':')[0];
                if (tags.length < 3 && !kinds.has(kind) && !['decade', 'country', 'language'].includes(kind)) {
                    kinds.add(kind);
                    tags.push(s.label);
                }
            });
            const directors = meta ? Object.keys(meta.f).filter(k => k.startsWith('director:')) : [];
            const quality = meta && meta.r ? Math.max(0, Math.min(1, (meta.r - 3) / 1.5)) * (meta.n >= 1000 ? 1 : 0.5) : 0.3;
            const because = c.sources.sort((a, b) => b.contribution - a.contribution)
                .map(s => s.title).filter((t, idx, arr) => arr.indexOf(t) === idx).slice(0, 2);
            return { ...c, meta, cosine, tags, directors, quality, because, sourceCount: c.sources.length };
        });

        const maxCo = Math.max(...scored.map(s => s.coScore), 1e-9);
        const maxCos = Math.max(...scored.map(s => s.cosine), 1e-9);
        scored.forEach(s => {
            s.score = 0.45 * (s.coScore / maxCo) + 0.4 * (s.cosine / maxCos) + 0.15 * s.quality;
        });
        scored.sort((a, b) => b.score - a.score);

        // At most 2 films per director near the top, the others move down the list
        const picked = [];
        const later = [];
        const perDirector = {};
        scored.forEach(s => {
            if (s.directors.some(d => (perDirector[d] || 0) >= 2)) {
                later.push(s);
                return;
            }
            s.directors.forEach(d => { perDirector[d] = (perDirector[d] || 0) + 1; });
            picked.push(s);
        });

        const items = picked.concat(later).slice(0, RECS_MAX_RESULTS).map(s => ({
            slug: s.slug,
            name: s.name,
            year: s.year || (s.meta && s.meta.y) || '',
            filmId: s.filmId,
            cacheKey: s.cacheKey,
            poster: s.meta && s.meta.p ? s.meta.p : '',
            avg: s.meta && s.meta.r ? s.meta.r : null,
            match: Math.round(s.score * 100),
            because: s.because,
            sourceCount: s.sourceCount,
            tags: s.tags
        }));

        return { user: username.toLowerCase(), at: Date.now(), seedCount: seeds.length, ratedCount: rated.length, items };
    }

    /**
     * Own profile page: /member/ while logged in as that member
     */
    function getRecsContext() {
        if (!document.body || !document.body.classList.contains('screen-member-profile')) return null;
        const owner = document.body.getAttribute('data-owner') || (window.location.pathname.match(/^\/([^\/]+)\/?$/) || [])[1];
        const me = getLoggedInUsername();
        if (!owner || !me || owner.toLowerCase() !== me) return null;
        return { username: owner };
    }

    function isRecsPage() {
        return getRecsContext() !== null;
    }

    const SVG_RECS_ICON = `
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
            <rect x="3" y="3" width="18" height="18" rx="3.5" stroke="#99aabb" stroke-width="1.8" fill="#14181c"/>
            <path d="M12 6.5l1.55 3.4 3.7.4-2.77 2.5.79 3.65L12 14.6l-3.27 1.85.79-3.65-2.77-2.5 3.7-.4z" fill="#00e054"/>
        </svg>
    `;

    function injectRecsButton() {
        if (document.getElementById('lbrc-recs-btn')) return;
        if (!isRecsPage()) return;

        const btn = document.createElement('button');
        btn.id = 'lbrc-recs-btn';
        btn.setAttribute('aria-label', 'Recommended for you');
        btn.innerHTML = `
            ${SVG_RECS_ICON}
            <div id="lbrc-recs-tooltip">Recommended for you</div>
        `;
        btn.addEventListener('click', openRecsModal);
        document.body.appendChild(btn);
    }

    function removeRecsButton() {
        document.getElementById('lbrc-recs-btn')?.remove();
    }

    function injectRecsModal() {
        if (document.getElementById('lbrc-modal-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'lbrc-modal-overlay';
        overlay.innerHTML = `
            <div id="lbrc-modal-container">
                <div class="lbst-modal-header">
                    <div class="lbst-header-title-box">
                        <div class="lbrnd-letterboxd-dots">
                            <span class="lbrnd-dot lbrnd-dot-orange"></span>
                            <span class="lbrnd-dot lbrnd-dot-green"></span>
                            <span class="lbrnd-dot lbrnd-dot-cyan"></span>
                        </div>
                        <div>
                            <h3 class="lbst-header-title">Recommended for You</h3>
                            <p class="lbst-header-subtitle" id="lbrc-header-sub">Loading...</p>
                        </div>
                    </div>
                    <div class="lbst-header-controls">
                        <button class="lbrc-refresh-btn" id="lbrc-refresh" title="Compute again from your latest ratings" hidden>↻ Refresh</button>
                        <button class="lbrnd-btn-icon" id="lbrc-modal-close" title="Close (Esc)">✕</button>
                    </div>
                </div>

                <div id="lbrc-loading-state">
                    <div class="lbst-spinner"></div>
                    <div class="lbst-loading-text" id="lbrc-loading-status">Reading your films...</div>
                    <div class="lbst-progress-bar-wrap">
                        <div class="lbst-progress-bar-fill" id="lbrc-progress-fill"></div>
                    </div>
                    <div class="lbrc-steps" id="lbrc-steps">
                        <span data-step="films">Your films</span>
                        <span data-step="seeds">Your favourites</span>
                        <span data-step="candidates">Similar films</span>
                        <span data-step="scoring">Scoring</span>
                    </div>
                </div>

                <div class="lbst-modal-body" id="lbrc-content-view" style="display: none;">
                    <p class="lbrc-explainer" id="lbrc-explainer"></p>
                    <div class="lbrc-grid" id="lbrc-grid"></div>
                    <button class="lbrc-more-btn" id="lbrc-more" hidden>Show more</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        document.getElementById('lbrc-modal-close').addEventListener('click', closeRecsModal);
        document.getElementById('lbrc-refresh').addEventListener('click', () => loadRecommendations(true));
        document.getElementById('lbrc-more').addEventListener('click', () => {
            recsShown += RECS_PAGE_SIZE;
            renderRecommendations();
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeRecsModal();
        });
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.classList.contains('active')) closeRecsModal();
        });
    }

    function openRecsModal() {
        injectRecsModal();
        document.getElementById('lbrc-modal-overlay').classList.add('active');
        loadRecommendations(false);
    }

    function closeRecsModal() {
        document.getElementById('lbrc-modal-overlay')?.classList.remove('active');
    }

    const RECS_STEPS = ['films', 'seeds', 'candidates', 'scoring'];

    async function loadRecommendations(forceRefresh) {
        const ctx = getRecsContext();
        if (!ctx || isComputingRecs) return;

        const loadingView = document.getElementById('lbrc-loading-state');
        const contentView = document.getElementById('lbrc-content-view');
        const statusText = document.getElementById('lbrc-loading-status');
        const progressFill = document.getElementById('lbrc-progress-fill');
        const subEl = document.getElementById('lbrc-header-sub');
        const refreshBtn = document.getElementById('lbrc-refresh');

        // Results from the last 24 hours open instantly
        if (!forceRefresh) {
            const stored = await storageGet(RECS_STORAGE_KEY);
            if (stored && stored.user === ctx.username.toLowerCase() && Date.now() - stored.at < RECS_TTL_MS && Array.isArray(stored.items)) {
                currentRecs = stored;
                recsShown = RECS_PAGE_SIZE;
                renderRecommendations();
                return;
            }
        }

        isComputingRecs = true;
        refreshBtn.hidden = true;
        loadingView.classList.remove('is-message');
        loadingView.style.display = 'flex';
        contentView.style.display = 'none';
        progressFill.style.width = '4%';
        subEl.textContent = `@${ctx.username} • Looking at what you love...`;

        const labels = {
            films: (d, t) => `Reading your films${t > 1 ? ` (page ${d}/${t})` : ''}...`,
            seeds: (d, t) => `Studying your favourites (${Math.ceil(d / 2)}/${Math.ceil(t / 2)})...`,
            candidates: (d, t) => `Comparing similar films (${d}/${t})...`,
            scoring: () => 'Scoring...'
        };
        const stepShare = { films: [0, 15], seeds: [15, 70], candidates: [70, 97], scoring: [97, 100] };
        const onProgress = (step, done, total) => {
            const [from, to] = stepShare[step];
            progressFill.style.width = `${Math.max(4, from + (to - from) * (total ? done / total : 0))}%`;
            statusText.textContent = labels[step](done, total);
            const reached = RECS_STEPS.indexOf(step);
            document.querySelectorAll('#lbrc-steps span').forEach((el, i) => {
                el.classList.toggle('is-done', i < reached);
                el.classList.toggle('is-active', i === reached);
            });
        };

        try {
            currentRecs = await computeRecommendations(ctx.username, onProgress);
            await storageSet(RECS_STORAGE_KEY, currentRecs);
            recsShown = RECS_PAGE_SIZE;
            renderRecommendations();
        } catch (err) {
            loadingView.classList.add('is-message');
            statusText.textContent = err.userFacing ? err.message : 'Unable to load recommendations. Please try again.';
            subEl.textContent = `@${ctx.username}`;
            refreshBtn.hidden = false;
        } finally {
            isComputingRecs = false;
        }
    }

    function renderRecommendations() {
        const recs = currentRecs;
        if (!recs) return;
        const ctx = getRecsContext();

        document.getElementById('lbrc-loading-state').style.display = 'none';
        document.getElementById('lbrc-content-view').style.display = 'flex';
        document.getElementById('lbrc-refresh').hidden = false;

        const ageMin = Math.round((Date.now() - recs.at) / 60000);
        const age = ageMin < 1 ? 'just now' : ageMin < 60 ? `${ageMin} min ago` : `${Math.round(ageMin / 60)} h ago`;
        document.getElementById('lbrc-header-sub').textContent =
            `@${ctx ? ctx.username : recs.user} • ${recs.items.length} films • computed ${age}`;
        document.getElementById('lbrc-explainer').textContent =
            `Based on your ${recs.seedCount} favourite films (the top 10% of your ${recs.ratedCount.toLocaleString('en-US')} ratings): films Letterboxd finds similar to them, ranked by how well their genres, themes, directors and cast match your taste. Films you've seen or have in your watchlist are left out.`;

        const grid = document.getElementById('lbrc-grid');
        grid.innerHTML = '';
        recs.items.slice(0, recsShown).forEach((item, idx) => grid.appendChild(createRecCard(item, idx)));

        const more = document.getElementById('lbrc-more');
        more.hidden = recsShown >= recs.items.length;
    }

    function createRecCard(item, idx) {
        const card = document.createElement('a');
        card.className = 'lbrc-card';
        card.href = `https://letterboxd.com/film/${encodeURIComponent(item.slug)}/`;
        card.target = '_blank';
        card.rel = 'noopener';
        card.style.animationDelay = `${Math.min(idx % RECS_PAGE_SIZE, 12) * 30}ms`;

        const posterBox = document.createElement('div');
        posterBox.className = 'lbrc-poster';
        // Poster from the film page, else the CDN path built from the film ID, else Letterboxd's resolver
        const sources = [item.poster, buildCdnPosterUrl(item.filmId, item.slug, item.cacheKey)].filter(Boolean);
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = '';
        let triedResolver = false;
        img.onerror = async () => {
            if (sources.length) {
                img.src = sources.shift();
                return;
            }
            if (!triedResolver) {
                triedResolver = true;
                const custom = await resolveCustomPosterUrl(item.slug, item.cacheKey);
                if (custom) {
                    img.src = custom;
                    return;
                }
            }
            img.remove();
        };
        if (sources.length) {
            img.src = sources.shift();
            posterBox.appendChild(img);
        }

        const info = document.createElement('div');
        info.className = 'lbrc-info';

        const title = document.createElement('div');
        title.className = 'lbrc-title';
        title.textContent = item.name;
        if (item.year) {
            const year = document.createElement('span');
            year.className = 'lbrc-year';
            year.textContent = ` ${item.year}`;
            title.appendChild(year);
        }

        const meta = document.createElement('div');
        meta.className = 'lbrc-meta';
        const match = document.createElement('span');
        match.className = 'lbrc-match';
        match.textContent = `${item.match}% match`;
        meta.appendChild(match);
        if (item.avg) {
            const avg = document.createElement('span');
            avg.className = 'lbrc-avg';
            avg.textContent = `★ ${item.avg.toFixed(1)}`;
            meta.appendChild(avg);
        }

        const because = document.createElement('div');
        because.className = 'lbrc-because';
        if (item.because && item.because.length) {
            because.append('Because you loved ');
            item.because.forEach((t, i) => {
                if (i > 0) because.append(i === item.because.length - 1 ? ' & ' : ', ');
                const b = document.createElement('strong');
                b.textContent = t;
                because.appendChild(b);
            });
            const others = (item.sourceCount || 0) - item.because.length;
            if (others > 0) because.append(` +${others}`);
        }

        const tags = document.createElement('div');
        tags.className = 'lbrc-tags';
        (item.tags || []).forEach(t => {
            const chip = document.createElement('span');
            chip.textContent = t;
            tags.appendChild(chip);
        });

        info.append(title, meta, because, tags);
        card.append(posterBox, info);
        return card;
    }

    /* ==========================================================================
       Update notice: a newer release on GitHub
       Unpacked (Chrome) extensions can't update themselves, so the notice links to the release.
       Closing it hides it for 24 hours (a newer version than the one dismissed shows right away).
       ========================================================================== */

    const RELEASES_API = 'https://api.github.com/repos/Antrubtor/LetterboxCompanion/releases/latest';
    const RELEASES_PAGE = 'https://github.com/Antrubtor/LetterboxCompanion/releases/latest';
    const UPDATE_STORAGE_KEY = 'lbc_update'; // { checkedAt, latest, url, dismissedVersion, dismissedUntil }
    const UPDATE_CHECK_INTERVAL_MS = 6 * 3600000; // GitHub allows 60 unauthenticated calls / hour
    const UPDATE_SNOOZE_MS = 24 * 3600000;

    function storageGet(key) {
        return new Promise((resolve) => {
            if (!extStorage) {
                try { resolve(JSON.parse(localStorage.getItem(key) || 'null')); } catch (e) { resolve(null); }
                return;
            }
            try {
                extStorage.get(key, (res) => resolve(res ? res[key] : null));
            } catch (e) {
                resolve(null); // extension context invalidated (extension reloaded)
            }
        });
    }

    function storageSet(key, value) {
        return new Promise((resolve) => {
            if (!extStorage) {
                try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
                resolve();
                return;
            }
            try {
                extStorage.set({ [key]: value }, () => resolve());
            } catch (e) {
                resolve();
            }
        });
    }

    // 1 if a > b, -1 if a < b, 0 if equal ("1.10.0" > "1.9.2")
    function compareVersions(a, b) {
        const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
        const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const diff = (pa[i] || 0) - (pb[i] || 0);
            if (diff !== 0) return diff > 0 ? 1 : -1;
        }
        return 0;
    }

    function installedVersion() {
        try {
            return chrome.runtime.getManifest().version;
        } catch (e) {
            return null;
        }
    }

    async function checkForUpdate() {
        const current = installedVersion();
        if (!current || enabledFeatures.updates === false) return;

        const state = (await storageGet(UPDATE_STORAGE_KEY)) || {};
        if (!state.checkedAt || Date.now() - state.checkedAt > UPDATE_CHECK_INTERVAL_MS) {
            state.checkedAt = Date.now(); // even when the call fails, so a GitHub outage isn't hammered
            try {
                const res = await fetch(RELEASES_API, { credentials: 'omit', headers: { 'Accept': 'application/vnd.github+json' } });
                if (res.ok) {
                    const release = await res.json();
                    const latest = String(release.tag_name || '').replace(/^v/i, '');
                    if (/^\d+(\.\d+)*$/.test(latest)) {
                        state.latest = latest;
                        const url = String(release.html_url || '');
                        state.url = url.startsWith('https://github.com/Antrubtor/LetterboxCompanion/') ? url : RELEASES_PAGE;
                    }
                }
            } catch (e) {}
            const stored = (await storageGet(UPDATE_STORAGE_KEY)) || {};
            await storageSet(UPDATE_STORAGE_KEY, { ...stored, checkedAt: state.checkedAt, latest: state.latest, url: state.url });
        }

        if (!state.latest || compareVersions(state.latest, current) <= 0) return;
        if (state.dismissedVersion === state.latest && Date.now() < (state.dismissedUntil || 0)) return;
        if (enabledFeatures.updates === false) return;
        showUpdateToast(state.latest, current, state.url || RELEASES_PAGE);
    }

    async function snoozeUpdate(version) {
        const stored = (await storageGet(UPDATE_STORAGE_KEY)) || {};
        await storageSet(UPDATE_STORAGE_KEY, { ...stored, dismissedVersion: version, dismissedUntil: Date.now() + UPDATE_SNOOZE_MS });
    }

    function showUpdateToast(latest, current, url) {
        if (document.getElementById('lbc-update-toast')) return;

        const toast = document.createElement('div');
        toast.id = 'lbc-update-toast';
        toast.setAttribute('role', 'status');
        toast.innerHTML = `
            <button type="button" class="lbc-update-main">
                <span class="lbrnd-letterboxd-dots">
                    <span class="lbrnd-dot lbrnd-dot-orange"></span>
                    <span class="lbrnd-dot lbrnd-dot-green"></span>
                    <span class="lbrnd-dot lbrnd-dot-cyan"></span>
                </span>
                <span class="lbc-update-text">
                    <strong></strong>
                    <span class="lbc-update-sub"></span>
                </span>
            </button>
            <button type="button" class="lbc-update-close" title="Hide for 24 hours" aria-label="Hide for 24 hours">✕</button>
        `;
        toast.querySelector('strong').textContent = `Letterboxd Companion ${latest} is out`;
        toast.querySelector('.lbc-update-sub').textContent = `You have ${current} · Get it on GitHub`;

        const hide = () => {
            toast.classList.remove('is-visible');
            setTimeout(() => toast.remove(), 300);
        };
        toast.querySelector('.lbc-update-main').addEventListener('click', () => {
            window.open(url, '_blank', 'noopener');
            snoozeUpdate(latest);
            hide();
        });
        toast.querySelector('.lbc-update-close').addEventListener('click', () => {
            snoozeUpdate(latest);
            hide();
        });

        document.body.appendChild(toast);
        requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('is-visible')));
    }

    function removeUpdateToast() {
        document.getElementById('lbc-update-toast')?.remove();
    }

    /* ==========================================================================
       Feature switches (popup) & page button switcher
       ========================================================================== */

    // Every feature is on unless switched off in the popup
    const DEFAULT_FEATURES = { picker: true, stats: true, follow: true, compat: true, recs: true, updates: true };
    let enabledFeatures = { ...DEFAULT_FEATURES };

    const PAGE_FEATURES = [
        { key: 'picker', matches: isPickablePage, inject: injectFloatingButton, remove: removeWatchlistButton },
        { key: 'stats', matches: () => isDiaryPage() || isFilmsPage(), inject: injectStatsButton, remove: removeStatsButton },
        { key: 'follow', matches: isFollowPage, inject: injectFollowButton, remove: removeFollowButton },
        { key: 'compat', matches: isCompatPage, inject: injectCompatButton, remove: removeCompatButton },
        { key: 'recs', matches: isRecsPage, inject: injectRecsButton, remove: removeRecsButton }
    ];

    /**
     * SPA navigation watcher & Button switcher
     */
    function updatePageButtons() {
        PAGE_FEATURES.forEach(feature => {
            if (enabledFeatures[feature.key] !== false && feature.matches()) {
                feature.inject();
            } else {
                feature.remove();
            }
        });
        if (enabledFeatures.updates === false) removeUpdateToast();
    }

    function loadFeatureSettings(callback) {
        if (!extStorage) {
            callback();
            return;
        }
        extStorage.get('lbc_features', (res) => {
            enabledFeatures = { ...DEFAULT_FEATURES, ...((res && res.lbc_features) || {}) };
            callback();
        });
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.lbc_features) {
                enabledFeatures = { ...DEFAULT_FEATURES, ...(changes.lbc_features.newValue || {}) };
                updatePageButtons();
            }
        });
    }

    function init() {
        // Firefox also runs the script in documents without a <body> (e.g. Cloudflare's check page)
        if (!document.body) return;

        // The popup's page shortcuts link to the signed-in member's pages
        const me = getLoggedInUsername();
        if (me) {
            storageGet('lbc_username').then((stored) => {
                if (stored !== me) storageSet('lbc_username', me);
            });
        }

        loadFeatureSettings(() => {
            updatePageButtons();
            checkForUpdate();
        });

        let lastUrl = window.location.href;
        const observer = new MutationObserver(() => {
            if (window.location.href !== lastUrl) {
                lastUrl = window.location.href;
                updatePageButtons();
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        window.addEventListener('popstate', () => {
            updatePageButtons();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

