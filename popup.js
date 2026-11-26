// Popup Script
document.addEventListener('DOMContentLoaded', () => {
    const toggleSound = document.getElementById('toggle-sound');
    const featureToggles = document.querySelectorAll('.feature-toggle');

    const tiles = document.querySelectorAll('.page-tile');

    // Tiles of switched-off features stay clickable but are dimmed
    const dimTiles = (features) => {
        tiles.forEach(tile => tile.classList.toggle('is-off', features[tile.dataset.feature] === false));
    };

    // Preferences live in extension storage so content scripts on letterboxd.com can read them
    chrome.storage.local.get(['lbrnd_sound', 'lbc_features', 'lbc_username'], (res) => {
        toggleSound.checked = res.lbrnd_sound !== false;

        // Every feature is on unless switched off here
        const features = res.lbc_features || {};
        featureToggles.forEach(input => {
            input.checked = features[input.dataset.feature] !== false;
        });
        dimTiles(features);

        // Shortcuts to the signed-in member's pages (username saved by the content script)
        const username = typeof res.lbc_username === 'string' && /^[a-z0-9_-]+$/i.test(res.lbc_username) ? res.lbc_username : null;
        tiles.forEach(tile => {
            tile.href = username ? `https://letterboxd.com/${username}/${tile.dataset.path}` : 'https://letterboxd.com/';
        });
        document.getElementById('tiles-note').hidden = !!username;
    });

    toggleSound.addEventListener('change', () => {
        chrome.storage.local.set({ lbrnd_sound: toggleSound.checked });
    });

    featureToggles.forEach(input => {
        input.addEventListener('change', () => {
            const features = {};
            featureToggles.forEach(t => {
                features[t.dataset.feature] = t.checked;
            });
            chrome.storage.local.set({ lbc_features: features });
            dimTiles(features);
        });
    });

    // Installed version, and the newer release found by the content script (see checkForUpdate)
    const current = chrome.runtime.getManifest().version;
    document.getElementById('popup-version').textContent = ` • v${current}`;

    const isNewer = (a, b) => {
        const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
        const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
        }
        return false;
    };

    chrome.storage.local.get('lbc_update', (res) => {
        const update = res && res.lbc_update;
        if (!update || !update.latest || !isNewer(update.latest, current)) return;
        const banner = document.getElementById('update-banner');
        document.getElementById('update-banner-title').textContent = `Version ${update.latest} available`;
        if (typeof update.url === 'string' && update.url.startsWith('https://github.com/Antrubtor/LetterboxCompanion/')) {
            banner.href = update.url;
        }
        banner.hidden = false;
    });
});
