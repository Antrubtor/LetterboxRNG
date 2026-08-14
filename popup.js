// Popup Script
document.addEventListener('DOMContentLoaded', () => {
    const toggleSound = document.getElementById('toggle-sound');

    // Load saved sound preference
    const soundEnabled = localStorage.getItem('lbrnd_sound') !== 'false';
    toggleSound.checked = soundEnabled;

    toggleSound.addEventListener('change', () => {
        const isEnabled = toggleSound.checked;
        localStorage.setItem('lbrnd_sound', isEnabled ? 'true' : 'false');
        
        // Broadcast to current tab if available
        if (typeof chrome !== 'undefined' && chrome.tabs) {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]?.id) {
                    chrome.scripting?.executeScript?.({
                        target: { tabId: tabs[0].id },
                        func: (val) => { localStorage.setItem('lbrnd_sound', val ? 'true' : 'false'); },
                        args: [isEnabled]
                    }).catch(() => {});
                }
            });
        }
    });
});
