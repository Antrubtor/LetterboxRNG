// Popup Script
document.addEventListener('DOMContentLoaded', () => {
    const toggleSound = document.getElementById('toggle-sound');
    const featureToggles = document.querySelectorAll('.feature-toggle');

    // Preferences live in extension storage so content scripts on letterboxd.com can read them
    chrome.storage.local.get(['lbrnd_sound', 'lbc_features'], (res) => {
        toggleSound.checked = res.lbrnd_sound !== false;

        // Every feature is on unless switched off here
        const features = res.lbc_features || {};
        featureToggles.forEach(input => {
            input.checked = features[input.dataset.feature] !== false;
        });
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
        });
    });
});
