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
     * Fetch a Letterboxd page and parse it (same-origin, with the user's session)
     */
    async function fetchDocument(url) {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return new DOMParser().parseFromString(await res.text(), 'text/html');
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
    let isFetchingDiary = false;
    let currentEntries = [];
    let currentSelectedYear = null;
    let currentStatsData = null;
    let currentChartMode = 'days'; // 'days', 'months', 'ratings' or 'decades'

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
                    releaseYear
                });
            }
        });

        return entries;
    }

    /**
     * Fetch complete diary across pagination (fetched in batches of 5 pages)
     */
    async function fetchEntireDiary(customBasePath, fallbackYear, onProgress) {
        const ctx = getDiaryContext();
        if (!ctx) throw new Error("Unable to detect Diary context.");

        const targetBasePath = customBasePath || ctx.baseUrl;
        const targetFallbackYear = fallbackYear !== undefined ? fallbackYear : ctx.urlYear;
        const cacheKey = `${targetBasePath}::${targetFallbackYear}`;

        if (cachedDiaryEntries && cachedDiaryPath === cacheKey) {
            return cachedDiaryEntries;
        }

        let firstPageEntries = [];
        let totalPages = 1;
        let pageUrl = (n) => `${targetBasePath}page/${n}/`;

        // Page 1 is always fetched rather than read from the live page: the server HTML is the same
        // for every viewer, while the live DOM may already be reworked by Letterboxd's scripts
        // (e.g. owner-only rating widgets replacing the static stars)
        try {
            const pageDoc = await fetchDocument(targetBasePath);
            firstPageEntries = extractDiaryEntriesFromDoc(pageDoc, targetFallbackYear);
            totalPages = detectTotalPages(pageDoc);
            pageUrl = pageUrlFor(pageDoc, targetBasePath);
        } catch (err) {
            // Network error fallback
        }

        let allEntries = [...firstPageEntries];

        if (totalPages > 1) {
            onProgress?.(1, totalPages, allEntries.length);

            const remainingPages = [];
            for (let p = 2; p <= totalPages; p++) {
                remainingPages.push(p);
            }

            const BATCH_SIZE = 5;
            for (let i = 0; i < remainingPages.length; i += BATCH_SIZE) {
                const batch = remainingPages.slice(i, i + BATCH_SIZE);
                const results = await Promise.all(batch.map(async (pageNum) => {
                    try {
                        const pageDoc = await fetchDocument(pageUrl(pageNum));
                        return extractDiaryEntriesFromDoc(pageDoc, targetFallbackYear);
                    } catch (err) {
                        return [];
                    }
                }));

                results.forEach(pageEntries => {
                    allEntries = allEntries.concat(pageEntries);
                });

                const loadedPages = Math.min(i + BATCH_SIZE + 1, totalPages);
                onProgress?.(loadedPages, totalPages, allEntries.length);
            }
        }

        cachedDiaryEntries = allEntries;
        cachedDiaryPath = cacheKey;
        return cachedDiaryEntries;
    }

    /**
     * Compute activity statistics (Heatmap + Weekdays + Months + Highlights)
     * Supports both specific year (e.g. 2026) and 'all' (All-Time across all diary years)
     */
    function computeDiaryStats(allEntries, year) {
        const isAllTime = (year === 'all');
        const targetEntries = isAllTime ? allEntries : allEntries.filter(e => e.year === year);

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

        // Determine years span
        const years = targetEntries.map(e => e.year).filter(y => y && !isNaN(y));
        const currentCalYear = new Date().getFullYear();
        const minYear = isAllTime ? (years.length > 0 ? Math.min(...years) : currentCalYear) : year;
        const maxYear = isAllTime ? (years.length > 0 ? Math.max(...years) : currentCalYear) : year;

        const startDate = new Date(minYear, 0, 1);
        const startDayOfWeek = (startDate.getDay() + 6) % 7; // Monday = 0, Sunday = 6

        const weeks = [];
        let currentWeek = [];

        for (let i = 0; i < startDayOfWeek; i++) {
            currentWeek.push({ empty: true });
        }

        const monthPositions = [];
        let lastLabeledMonthKey = '';

        const curDate = new Date(minYear, 0, 1);
        const endDate = new Date(maxYear, 11, 31);
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
                const label = (isAllTime && m === 0) ? `${y}` : monthShorts[m];
                monthPositions.push({
                    weekIdx: weeks.length,
                    label,
                    isYear: (isAllTime && m === 0)
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
                if (isAllTime) {
                    streakRangeStr = `on ${monthsEn[startParts[1] - 1]} ${startParts[2]}, ${startParts[0]}`;
                } else {
                    streakRangeStr = `on ${monthsEn[startParts[1] - 1]} ${startParts[2]}`;
                }
            } else {
                const startMonth = monthsEn[startParts[1] - 1];
                const endMonth = monthsEn[endParts[1] - 1];

                if (startParts[0] === endParts[0]) {
                    const yearSuffix = isAllTime ? `, ${startParts[0]}` : '';
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

        // 6. Ratings, rewatches, likes, reviews and release decades
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
            year,
            isAllTime,
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
        if (!isDiaryPage()) return;

        const ctx = getDiaryContext();
        const tooltipText = ctx && ctx.urlYear ? `Statistics ${ctx.urlYear}` : 'Diary Statistics (All Time)';

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
                        <select class="lbst-year-select" id="lbst-year-select" style="display: none;"></select>
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
                        <div class="lbst-metric-card">
                            <span class="lbst-metric-label">Films Logged</span>
                            <span class="lbst-metric-value" id="lbst-metric-total">0</span>
                            <span class="lbst-metric-sub" id="lbst-metric-avg">0 / week</span>
                        </div>
                        <div class="lbst-metric-card">
                            <span class="lbst-metric-label">Active Days</span>
                            <span class="lbst-metric-value" id="lbst-metric-active">0</span>
                            <span class="lbst-metric-sub" id="lbst-metric-active-pct">0% of year</span>
                        </div>
                        <div class="lbst-metric-card">
                            <span class="lbst-metric-label">Longest Streak</span>
                            <span class="lbst-metric-value" id="lbst-metric-streak">0 days</span>
                            <span class="lbst-metric-sub" id="lbst-metric-streak-range">no streak</span>
                        </div>
                        <div class="lbst-metric-card">
                            <span class="lbst-metric-label">Daily Record</span>
                            <span class="lbst-metric-value" id="lbst-metric-record">0</span>
                            <span class="lbst-metric-sub" id="lbst-metric-record-date">no films</span>
                        </div>
                        <div class="lbst-metric-card">
                            <span class="lbst-metric-label">Top Month</span>
                            <span class="lbst-metric-value" id="lbst-metric-top-month">-</span>
                            <span class="lbst-metric-sub" id="lbst-metric-top-month-count">0 films</span>
                        </div>
                        <div class="lbst-metric-card">
                            <span class="lbst-metric-label">Average Rating</span>
                            <span class="lbst-metric-value" id="lbst-metric-avg-rating">-</span>
                            <span class="lbst-metric-sub" id="lbst-metric-avg-rating-sub">no rated films</span>
                        </div>
                        <div class="lbst-metric-card">
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
                    <div class="lbst-section">
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
                                <button class="lbst-toggle-btn active" data-chart-mode="days">Days</button>
                                <button class="lbst-toggle-btn" data-chart-mode="months">Months</button>
                                <button class="lbst-toggle-btn" data-chart-mode="ratings">Ratings</button>
                                <button class="lbst-toggle-btn" data-chart-mode="decades">Decades</button>
                            </div>
                        </div>
                        <div class="lbst-chart-card">
                            <div class="lbst-chart-container" id="lbst-chart-container"></div>
                        </div>
                    </div>

                    <!-- On This Day: same date in previous years -->
                    <div class="lbst-section">
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
                currentChartMode = btn.dataset.chartMode;
                overlay.querySelectorAll('#lbst-chart-toggles .lbst-toggle-btn').forEach(b => {
                    b.classList.toggle('active', b === btn);
                });
                if (currentStatsData) renderBarChart(currentStatsData);
            });
        });

        document.getElementById('lbst-year-select').addEventListener('change', (e) => {
            currentSelectedYear = e.target.value === 'all' ? 'all' : parseInt(e.target.value, 10);
            updateStatsForSelectedYear();
        });

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

        const ctx = getDiaryContext();
        if (!ctx) return;

        const titleText = ctx.urlYear ? `Diary Statistics • ${ctx.urlYear}` : 'Diary Statistics • All Time';
        document.getElementById('lbst-header-title').textContent = titleText;
        document.getElementById('lbst-header-sub').textContent = `@${ctx.username} • Loading diary entries...`;

        loadAndRenderStats(ctx);
    }

    function closeStatsModal() {
        const overlay = document.getElementById('lbst-modal-overlay');
        if (overlay) overlay.classList.remove('active');
        unpinTooltip();
    }

    async function loadAndRenderStats(ctx) {
        if (isFetchingDiary) return;

        const loadingView = document.getElementById('lbst-loading-state');
        const contentView = document.getElementById('lbst-content-view');
        const statusText = document.getElementById('lbst-loading-status');
        const progressFill = document.getElementById('lbst-progress-fill');

        loadingView.style.display = 'flex';
        contentView.style.display = 'none';
        progressFill.style.width = '10%';
        isFetchingDiary = true;

        try {
            const entries = await fetchEntireDiary(null, undefined, (loaded, total, count) => {
                const percent = Math.round((loaded / total) * 100);
                progressFill.style.width = `${Math.max(10, percent)}%`;
                statusText.textContent = `Indexing diary... (${count} films • Page ${loaded}/${total})`;
            });

            isFetchingDiary = false;
            currentEntries = entries;

            // Extract all unique years available in diary
            const availableYears = Array.from(new Set(entries.map(e => e.year).filter(y => y && !isNaN(y)))).sort((a, b) => b - a);

            // Determine active year:
            // If on a specific year URL (e.g. /for/2026/), pre-select that year.
            // If on general /diary/, default to 'all' (All-Time multi-year view).
            if (ctx.urlYear) {
                currentSelectedYear = ctx.urlYear;
            } else {
                currentSelectedYear = 'all';
            }

            // Populate Year Selector Dropdown
            const yearSelect = document.getElementById('lbst-year-select');
            yearSelect.innerHTML = '';

            // 1. "All Time" option
            const allOpt = document.createElement('option');
            allOpt.value = 'all';
            allOpt.textContent = 'All Time';
            if (currentSelectedYear === 'all') allOpt.selected = true;
            yearSelect.appendChild(allOpt);

            // 2. Individual Year options
            availableYears.forEach(y => {
                const opt = document.createElement('option');
                opt.value = y;
                opt.textContent = y;
                if (y === currentSelectedYear) opt.selected = true;
                yearSelect.appendChild(opt);
            });

            yearSelect.style.display = 'block';

            loadingView.style.display = 'none';
            contentView.style.display = 'flex';

            updateStatsForSelectedYear();
        } catch (err) {
            isFetchingDiary = false;
            statusText.textContent = "Unable to load diary entries. Please try again.";
        }
    }

    async function updateStatsForSelectedYear() {
        const ctx = getDiaryContext();
        const username = ctx ? ctx.username : 'user';
        const isAllTime = (currentSelectedYear === 'all');

        // If 'all' was selected but we originally only fetched a single year page (/for/YYYY/), fetch full diary
        const fullDiaryPath = ctx ? ctx.baseUrl.replace(/for\/.*$/i, '') : '';
        if (isAllTime && ctx && ctx.urlYear && cachedDiaryPath !== `${fullDiaryPath}::null`) {
            const loadingView = document.getElementById('lbst-loading-state');
            const contentView = document.getElementById('lbst-content-view');
            const statusText = document.getElementById('lbst-loading-status');
            const progressFill = document.getElementById('lbst-progress-fill');

            loadingView.style.display = 'flex';
            contentView.style.display = 'none';
            progressFill.style.width = '20%';

            try {
                const fullEntries = await fetchEntireDiary(fullDiaryPath, null, (loaded, total, count) => {
                    const percent = Math.round((loaded / total) * 100);
                    progressFill.style.width = `${Math.max(10, percent)}%`;
                    statusText.textContent = `Indexing full diary... (${count} films • Page ${loaded}/${total})`;
                });
                currentEntries = fullEntries;

                // Update available years dropdown if more years were found in full diary
                const availableYears = Array.from(new Set(fullEntries.map(e => e.year).filter(y => y && !isNaN(y)))).sort((a, b) => b - a);
                const yearSelect = document.getElementById('lbst-year-select');
                yearSelect.innerHTML = '';

                const allOpt = document.createElement('option');
                allOpt.value = 'all';
                allOpt.textContent = 'All Time';
                allOpt.selected = true;
                yearSelect.appendChild(allOpt);

                availableYears.forEach(y => {
                    const opt = document.createElement('option');
                    opt.value = y;
                    opt.textContent = y;
                    yearSelect.appendChild(opt);
                });

                loadingView.style.display = 'none';
                contentView.style.display = 'flex';
            } catch (err) {
                loadingView.style.display = 'none';
                contentView.style.display = 'flex';
            }
        }

        const stats = computeDiaryStats(currentEntries, currentSelectedYear);
        currentStatsData = stats;

        const titleEl = document.getElementById('lbst-header-title');
        const subEl = document.getElementById('lbst-header-sub');

        if (isAllTime) {
            titleEl.textContent = 'Diary Statistics • All Time';
            if (stats.minYear && stats.maxYear && stats.minYear !== stats.maxYear) {
                subEl.textContent = `@${username} • ${stats.totalFilms} film${stats.totalFilms === 1 ? '' : 's'} logged in total (${stats.minYear}–${stats.maxYear})`;
            } else {
                subEl.textContent = `@${username} • ${stats.totalFilms} film${stats.totalFilms === 1 ? '' : 's'} logged in total`;
            }
        } else {
            titleEl.textContent = `Diary Statistics • ${currentSelectedYear}`;
            subEl.textContent = `@${username} • ${stats.totalFilms} film${stats.totalFilms === 1 ? '' : 's'} logged in ${currentSelectedYear}`;
        }

        renderStatsUI(stats);
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
     * Render full stats interface (Summary + Heatmap + Bar chart)
     */
    function renderStatsUI(stats) {
        const isAllTime = stats.isAllTime;

        // 1. Summary Metrics
        document.getElementById('lbst-metric-total').textContent = stats.totalFilms.toLocaleString('en-US');
        document.getElementById('lbst-metric-avg').textContent = `${stats.avgPerWeek} / week`;
        document.getElementById('lbst-metric-active').textContent = stats.activeDaysCount;
        document.getElementById('lbst-metric-active-pct').textContent = `${stats.activePercentage}% ${isAllTime ? 'overall' : 'of year'}`;
        document.getElementById('lbst-metric-streak').textContent = `${stats.maxStreak} day${stats.maxStreak === 1 ? '' : 's'}`;
        document.getElementById('lbst-metric-streak-range').textContent = stats.streakRangeStr;
        document.getElementById('lbst-metric-record').textContent = stats.maxInSingleDay;

        if (stats.recordDayStr) {
            const parts = stats.recordDayStr.split('-').map(Number);
            const monthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            if (isAllTime) {
                document.getElementById('lbst-metric-record-date').textContent = `on ${monthsEn[parts[1] - 1]} ${parts[2]}, ${parts[0]}`;
            } else {
                document.getElementById('lbst-metric-record-date').textContent = `on ${monthsEn[parts[1] - 1]} ${parts[2]}`;
            }
        } else {
            document.getElementById('lbst-metric-record-date').textContent = 'no films';
        }

        document.getElementById('lbst-metric-top-month').textContent = stats.topMonthName;
        document.getElementById('lbst-metric-top-month-count').textContent = `${stats.topMonthCount} film${stats.topMonthCount === 1 ? '' : 's'}${isAllTime ? ' (all-time)' : ''}`;

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

        // 4. Auto-scroll heatmap to the right if All-Time so latest weeks are visible first
        const heatmapCard = document.querySelector('.lbst-heatmap-card');
        if (heatmapCard) {
            if (isAllTime) {
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

            films.push({
                slug,
                name: fullName.replace(/\s*\(\d{4}\)\s*$/, ''),
                year: (fullName.match(/\((\d{4})\)\s*$/) || [])[1] || '',
                link: `https://letterboxd.com${poster.getAttribute('data-item-link') || `/film/${slug}/`}`,
                rating: ratingMatch ? parseInt(ratingMatch[1], 10) : null
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
       Feature switches (popup) & page button switcher
       ========================================================================== */

    // Every feature is on unless switched off in the popup
    const DEFAULT_FEATURES = { picker: true, stats: true, follow: true, compat: true };
    let enabledFeatures = { ...DEFAULT_FEATURES };

    const PAGE_FEATURES = [
        { key: 'picker', matches: isPickablePage, inject: injectFloatingButton, remove: removeWatchlistButton },
        { key: 'stats', matches: isDiaryPage, inject: injectStatsButton, remove: removeStatsButton },
        { key: 'follow', matches: isFollowPage, inject: injectFollowButton, remove: removeFollowButton },
        { key: 'compat', matches: isCompatPage, inject: injectCompatButton, remove: removeCompatButton }
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
        loadFeatureSettings(updatePageButtons);

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

