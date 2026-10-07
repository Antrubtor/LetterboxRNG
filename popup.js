// Popup Script
document.addEventListener('DOMContentLoaded', () => {
    const toggleSound = document.getElementById('toggle-sound');

    // Sound preference lives in extension storage so content scripts on letterboxd.com can read it
    chrome.storage.local.get('lbrnd_sound', (res) => {
        toggleSound.checked = res.lbrnd_sound !== false;
    });

    toggleSound.addEventListener('change', () => {
        chrome.storage.local.set({ lbrnd_sound: toggleSound.checked });
    });
});
