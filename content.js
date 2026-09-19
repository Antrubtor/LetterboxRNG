/**
 * Letterboxd Random Watchlist Picker
 * Authentic Letterboxd Design • Cross-browser (Chrome, Safari, Firefox, Edge, Brave)
 */

(function () {
    'use strict';

    if (window.__LETTERBOXD_RND_INITIALIZED__) return;
    window.__LETTERBOXD_RND_INITIALIZED__ = true;

    // Global state
    let cachedMovies = null;
    let cachedPath = '';
    let isFetching = false;
    let isSpinning = false;
    let audioCtx = null;
    let soundEnabled = localStorage.getItem('lbrnd_sound') !== 'false';
    let currentWinnerIndex = -1;

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
     * URL validation & Watchlist context extraction
     */
    function isWatchlistPage() {
        const path = window.location.pathname;
        return /^\/[^\/]+\/watchlist/i.test(path);
    }

    function getWatchlistContext() {
        const match = window.location.pathname.match(/^\/([^\/]+)\/watchlist(.*)/i);
        if (!match) return null;

        const username = match[1];
        let subpath = match[2] || '';
        subpath = subpath.replace(/\/page\/\d+\/?/i, '/');
        if (!subpath.endsWith('/')) subpath += '/';

        return {
            username,
            baseUrl: `/${username}/watchlist${subpath === '/' ? '/' : subpath}`
        };
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
     * Unique top-level film extraction without duplicates
     */
    function extractMoviesFromDocOrHtml(docOrHtml) {
        const movies = [];

        // Raw HTML string parsing (pages 2 to N)
        if (typeof docOrHtml === 'string') {
            const itemRegex = /<li[^>]*class=["'][^"']*(?:griditem|poster-container|listitem)[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
            let match;

            while ((match = itemRegex.exec(docOrHtml)) !== null) {
                const itemHtml = match[1];

                let slug = '';
                const slugMatch = itemHtml.match(/data-item-slug=["']([^"']+)["']/) ||
                                  itemHtml.match(/data-target-link=["']\/film\/([^"/]+)\/?["']/) ||
                                  itemHtml.match(/data-film-slug=["']([^"']+)["']/) ||
                                  itemHtml.match(/href=["']\/film\/([^"/]+)\/?["']/);
                if (slugMatch) slug = slugMatch[1];

                let name = '';
                const nameMatch = itemHtml.match(/data-item-name=["']([^"']+)["']/) ||
                                  itemHtml.match(/data-film-name=["']([^"']+)["']/) ||
                                  itemHtml.match(/alt=["']([^"']+)["']/);
                if (nameMatch) name = nameMatch[1];

                let year = '';
                const yearMatch = itemHtml.match(/data-film-release-year=["']([^"']+)["']/) ||
                                  (name && name.match(/\((\d{4})\)/));
                if (yearMatch) {
                    year = typeof yearMatch === 'string' ? yearMatch : yearMatch[1];
                    if (name) name = name.replace(/\s*\(\d{4}\)\s*$/, '').trim();
                }

                let filmId = '';
                const uidMatch = itemHtml.match(/film:(\d+)/) || itemHtml.match(/data-film-id=["'](\d+)["']/);
                if (uidMatch) filmId = uidMatch[1];

                let cacheKey = '';
                const cacheMatch = itemHtml.match(/cacheBustingKey["']:["']([a-zA-Z0-9]+)["']/);
                if (cacheMatch) cacheKey = cacheMatch[1];

                let poster = '';
                if (filmId && slug) {
                    poster = buildCdnPosterUrl(filmId, slug, cacheKey);
                }

                if (slug) {
                    const cleanSlug = slug.startsWith('/film/') ? slug : `/film/${slug}/`;
                    movies.push({
                        name: name || slug.replace(/[-/]/g, ' ').trim(),
                        year: year || '',
                        slug: cleanSlug,
                        filmId: filmId || '',
                        cacheKey: cacheKey || '',
                        poster: poster || '',
                        link: `https://letterboxd.com${cleanSlug}`
                    });
                }
            }

            return movies;
        }

        // Live DOM parsing (page 1)
        const doc = docOrHtml;
        const listItems = doc.querySelectorAll('ul.grid li.griditem, ul.poster-list li.poster-container, ul.poster-list li.listitem, li.griditem');

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
     * Fetch complete watchlist with concurrency batching
     */
    async function fetchEntireWatchlist(onProgress) {
        const ctx = getWatchlistContext();
        if (!ctx) throw new Error("Unable to detect Watchlist context.");

        if (cachedMovies && cachedPath === window.location.pathname) {
            return cachedMovies;
        }

        const firstPageMovies = extractMoviesFromDocOrHtml(document);
        const totalPages = detectTotalPages(document);

        let allMovies = [...firstPageMovies];

        if (totalPages > 1) {
            onProgress?.(1, totalPages, allMovies.length);

            const remainingPages = [];
            for (let p = 2; p <= totalPages; p++) {
                remainingPages.push(p);
            }

            const BATCH_SIZE = 5;
            for (let i = 0; i < remainingPages.length; i += BATCH_SIZE) {
                const batch = remainingPages.slice(i, i + BATCH_SIZE);
                const results = await Promise.all(batch.map(async (pageNum) => {
                    try {
                        const pageUrl = `${ctx.baseUrl}page/${pageNum}/`;
                        const res = await fetch(pageUrl, { credentials: 'same-origin' });
                        if (!res.ok) return [];
                        const html = await res.text();
                        return extractMoviesFromDocOrHtml(html);
                    } catch (err) {
                        return [];
                    }
                }));

                results.forEach(pageMovies => {
                    allMovies = allMovies.concat(pageMovies);
                });

                const loadedPages = Math.min(i + BATCH_SIZE + 1, totalPages);
                onProgress?.(loadedPages, totalPages, allMovies.length);
            }
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

        cachedMovies = uniqueMovies.length > 0 ? uniqueMovies : firstPageMovies;
        cachedPath = window.location.pathname;

        return cachedMovies;
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
        if (!isWatchlistPage()) return;

        const btn = document.createElement('button');
        btn.id = 'lbrnd-dice-btn';
        btn.setAttribute('aria-label', 'Pick a random movie from watchlist');
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
            soundEnabled = !soundEnabled;
            localStorage.setItem('lbrnd_sound', soundEnabled ? 'true' : 'false');
            document.getElementById('lbrnd-sound-icon').textContent = soundEnabled ? '🔊' : '🔇';
        });

        document.getElementById('lbrnd-reroll-btn').addEventListener('click', () => {
            if (!isSpinning && cachedMovies && cachedMovies.length > 0) {
                startRoulette(cachedMovies);
            }
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

        const ctx = getWatchlistContext();
        document.getElementById('lbrnd-header-sub').textContent = ctx ? `Watchlist of @${ctx.username}` : 'Letterboxd Watchlist';

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

        loadingView.style.display = 'flex';
        rouletteView.style.display = 'none';
        revealView.style.display = 'none';
        progressFill.style.width = '10%';

        isFetching = true;

        try {
            const movies = await fetchEntireWatchlist((loaded, total, count) => {
                const percent = Math.round((loaded / total) * 100);
                progressFill.style.width = `${Math.max(10, percent)}%`;
                statusText.textContent = `Indexing watchlist... (${count} films • Page ${loaded}/${total})`;
            });

            isFetching = false;

            if (!movies || movies.length === 0) {
                statusText.textContent = "No films found in this watchlist!";
                return;
            }

            document.getElementById('lbrnd-header-sub').textContent = `${movies.length.toLocaleString('en-US')} films in watchlist`;
            startRoulette(movies);
        } catch (err) {
            isFetching = false;
            statusText.textContent = "Failed to load watchlist. Please try again.";
        }
    }

    /**
     * Carousel Roulette Engine with automatic on-the-fly poster resolution
     */
    function startRoulette(movies) {
        if (isSpinning) return;
        isSpinning = true;

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
                <span class="lbrnd-poster-fallback-title">${m.name}</span>
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
                <div class="lbrnd-reel-card-title">${m.name}</div>
                <div class="lbrnd-reel-card-year">${m.year || ''}</div>
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
            directorEl.innerHTML = `Directed by <strong>${film.directors.join(', ')}</strong>`;
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
    let currentChartMode = 'days'; // 'days' or 'months'

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
            if (!filmLink && !row.querySelector('.film-poster')) return;

            const title = row.querySelector('h3.film-title, .td-film-details h3, h3')?.textContent?.trim() ||
                          filmLink?.getAttribute('data-film-name') ||
                          filmLink?.getAttribute('data-item-name') ||
                          row.querySelector('.film-poster img')?.getAttribute('alt') ||
                          filmLink?.textContent?.trim() || 'Film';

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
                    day: entryDate.day
                });
            }
        });

        return entries;
    }

    /**
     * Fetch complete diary across pagination (capped at 20 pages max for efficiency)
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

        if (window.location.pathname === targetBasePath || window.location.pathname === targetBasePath.replace(/\/$/, '')) {
            firstPageEntries = extractDiaryEntriesFromDoc(document, targetFallbackYear);
            totalPages = detectTotalPages(document);
        } else {
            try {
                const res = await fetch(targetBasePath, { credentials: 'same-origin' });
                if (res.ok) {
                    const html = await res.text();
                    const pageDoc = new DOMParser().parseFromString(html, 'text/html');
                    firstPageEntries = extractDiaryEntriesFromDoc(pageDoc, targetFallbackYear);
                    totalPages = detectTotalPages(pageDoc);
                }
            } catch (err) {
                // Network error fallback
            }
        }

        let allEntries = [...firstPageEntries];

        if (totalPages > 1) {
            onProgress?.(1, totalPages, allEntries.length);

            const maxPagesToFetch = Math.min(totalPages, 20);
            const remainingPages = [];
            for (let p = 2; p <= maxPagesToFetch; p++) {
                remainingPages.push(p);
            }

            const BATCH_SIZE = 5;
            for (let i = 0; i < remainingPages.length; i += BATCH_SIZE) {
                const batch = remainingPages.slice(i, i + BATCH_SIZE);
                const results = await Promise.all(batch.map(async (pageNum) => {
                    try {
                        const pageUrl = `${targetBasePath}page/${pageNum}/`;
                        const res = await fetch(pageUrl, { credentials: 'same-origin' });
                        if (!res.ok) return [];
                        const html = await res.text();
                        const pageDoc = new DOMParser().parseFromString(html, 'text/html');
                        return extractDiaryEntriesFromDoc(pageDoc, targetFallbackYear);
                    } catch (err) {
                        return [];
                    }
                }));

                results.forEach(pageEntries => {
                    allEntries = allEntries.concat(pageEntries);
                });

                const loadedPages = Math.min(i + BATCH_SIZE + 1, maxPagesToFetch);
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
            dateFilmMap[e.date].push(e.title);
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

        const activeDaysCount = Object.keys(dateFilmMap).length;
        const totalSpanDays = Math.max(1, totalCalendarDays);
        const activePercentage = Math.round((activeDaysCount / totalSpanDays) * 100);
        const totalWeeks = Math.max(1, isAllTime ? weeks.length : 52);
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
            }))
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

                    <!-- Bar Chart Section with Days/Months Toggle -->
                    <div class="lbst-section">
                        <div class="lbst-section-header">
                            <h4 class="lbst-section-title">Viewing Distribution</h4>
                            <div class="lbst-toggle-group">
                                <button class="lbst-toggle-btn active" id="lbst-toggle-days">Days</button>
                                <button class="lbst-toggle-btn" id="lbst-toggle-months">Months</button>
                            </div>
                        </div>
                        <div class="lbst-chart-card">
                            <div class="lbst-chart-container" id="lbst-chart-container"></div>
                        </div>
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
        });

        document.getElementById('lbst-toggle-days').addEventListener('click', () => {
            if (currentChartMode !== 'days') {
                currentChartMode = 'days';
                document.getElementById('lbst-toggle-days').classList.add('active');
                document.getElementById('lbst-toggle-months').classList.remove('active');
                if (currentStatsData) renderBarChart(currentStatsData);
            }
        });

        document.getElementById('lbst-toggle-months').addEventListener('click', () => {
            if (currentChartMode !== 'months') {
                currentChartMode = 'months';
                document.getElementById('lbst-toggle-months').classList.add('active');
                document.getElementById('lbst-toggle-days').classList.remove('active');
                if (currentStatsData) renderBarChart(currentStatsData);
            }
        });

        document.getElementById('lbst-year-select').addEventListener('change', (e) => {
            currentSelectedYear = e.target.value === 'all' ? 'all' : parseInt(e.target.value, 10);
            updateStatsForSelectedYear();
        });

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.classList.contains('active')) {
                closeStatsModal();
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
        const tooltip = document.getElementById('lbst-floating-tooltip');
        if (tooltip) tooltip.style.display = 'none';
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
        if (isAllTime && ctx && ctx.urlYear && cachedDiaryPath !== `/${ctx.username}/diary/::null`) {
            const loadingView = document.getElementById('lbst-loading-state');
            const contentView = document.getElementById('lbst-content-view');
            const statusText = document.getElementById('lbst-loading-status');
            const progressFill = document.getElementById('lbst-progress-fill');

            loadingView.style.display = 'flex';
            contentView.style.display = 'none';
            progressFill.style.width = '20%';

            try {
                const fullEntries = await fetchEntireDiary(`/${ctx.username}/diary/`, null, (loaded, total, count) => {
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

    function positionFloatingTooltip(e) {
        const tooltip = document.getElementById('lbst-floating-tooltip');
        if (!tooltip || tooltip.style.display !== 'block') return;

        let left = e.clientX + 14;
        let top = e.clientY + 14;

        if (left + 260 > window.innerWidth) {
            left = e.clientX - 270;
        }
        if (top + 160 > window.innerHeight) {
            top = e.clientY - 170;
        }

        tooltip.style.left = `${Math.max(10, left)}px`;
        tooltip.style.top = `${Math.max(10, top)}px`;
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

                    cell.addEventListener('mouseenter', (e) => {
                        const dateObj = day.dateObj;
                        const formattedDate = `${daysEn[dateObj.getDay()]}, ${monthsLongEn[dateObj.getMonth()]} ${dateObj.getDate()}, ${dateObj.getFullYear()}`;

                        let filmsHtml = '';
                        if (day.films && day.films.length > 0) {
                            filmsHtml = `<ul class="lbst-tooltip-films">${day.films.map(f => `<li>${f}</li>`).join('')}</ul>`;
                        }

                        const countText = day.count === 0 ? 'No films logged' : `${day.count} film${day.count === 1 ? '' : 's'} logged:`;

                        tooltip.innerHTML = `
                            <div class="lbst-tooltip-date">${formattedDate}</div>
                            <div class="lbst-tooltip-count">${countText}</div>
                            ${filmsHtml}
                        `;
                        tooltip.style.display = 'block';
                        positionFloatingTooltip(e);
                    });

                    cell.addEventListener('mousemove', positionFloatingTooltip);

                    cell.addEventListener('mouseleave', () => {
                        tooltip.style.display = 'none';
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
    }

    /**
     * Render Bar Chart (Days of week or Months)
     */
    function renderBarChart(stats) {
        const container = document.getElementById('lbst-chart-container');
        if (!container) return;
        container.innerHTML = '';

        const tooltip = document.getElementById('lbst-floating-tooltip');
        const isDays = currentChartMode === 'days';
        const dataset = isDays ? stats.dayStats : stats.monthStats;
        const total = stats.totalFilms || 1;
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
                tooltip.innerHTML = `
                    <div class="lbst-tooltip-date">${item.name}</div>
                    <div class="lbst-tooltip-count">${item.count} film${item.count === 1 ? '' : 's'} (${pct}% of total)</div>
                `;
                tooltip.style.display = 'block';
                positionFloatingTooltip(e);
            });

            group.addEventListener('mousemove', positionFloatingTooltip);

            group.addEventListener('mouseleave', () => {
                tooltip.style.display = 'none';
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

    /**
     * SPA navigation watcher & Button switcher
     */
    function updatePageButtons() {
        if (isWatchlistPage()) {
            removeStatsButton();
            injectFloatingButton();
        } else if (isDiaryPage()) {
            removeWatchlistButton();
            injectStatsButton();
        } else {
            removeWatchlistButton();
            removeStatsButton();
        }
    }

    function init() {
        updatePageButtons();

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

