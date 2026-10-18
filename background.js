// Media Extractor — service worker.
// Toggles the panel in the top frame and relays scan results from child
// frames (including cross-origin iframes) up to the top frame's panel.

const TOP = { frameId: 0 };

async function send(tabId, msg, opts) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg, opts);
  } catch {
    return undefined; // no receiver (frame gone, restricted page, etc.)
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { kind: 'toggle' }, TOP);
  } catch {
    // Content script isn't there yet (tab opened before install/reload).
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content.js'],
      });
      await send(tab.id, { kind: 'toggle' }, TOP);
    } catch (err) {
      // chrome://, the Web Store and similar pages can't be scripted.
      console.warn('Media Extractor cannot run on this page:', err?.message);
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;
  if (!tabId || !msg) return;

  switch (msg.kind) {
    // Top frame opened/refreshed the panel: ask every frame to scan.
    case 'scan-all':
      send(tabId, { kind: 'scan' });
      break;
    // Top frame closed the panel: child frames stop observing.
    case 'stop-all':
      send(tabId, { kind: 'stop' });
      break;
    // A child frame reported its items: forward them to the top frame.
    case 'frame-items':
      if (sender.frameId !== 0) {
        send(tabId, { ...msg, frameId: sender.frameId }, TOP);
      }
      break;
  }
});
