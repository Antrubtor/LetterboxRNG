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

    /**
     * SPA navigation watcher
     */
    function init() {
        if (isWatchlistPage()) {
            injectFloatingButton();
        }

        let lastUrl = window.location.href;
        const observer = new MutationObserver(() => {
            if (window.location.href !== lastUrl) {
                lastUrl = window.location.href;
                if (isWatchlistPage()) {
                    injectFloatingButton();
                } else {
                    const btn = document.getElementById('lbrnd-dice-btn');
                    if (btn) btn.remove();
                }
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
