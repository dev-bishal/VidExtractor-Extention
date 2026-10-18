# Media Extractor (browser extension)

Lists every **iframe `src`**, **video poster image** and **video `src` / `<source src>`** on the
current page in a floating panel, each with a copy button.

## Install (Chrome / Edge / Brave)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose this `extractor` folder.
4. Optional: pin the icon to the toolbar.

To use it on local `file://` pages, open the extension's **Details** and enable
**Allow access to file URLs**.

## Use

- Click the toolbar icon or press **Alt+Shift+E** to open/close the panel (Esc also closes it).
- Each row has **Copy**, **Open in new tab** and **Scroll to element** (top-frame items).
  Hovering a row highlights the element on the page.
- **Copy list** copies one section; **Copy all** copies everything, grouped by type.
- The filter box narrows all sections by URL text.
- Dock the panel **left**, **top** or **right** — the choice is remembered.
- The list updates live as the page adds videos/iframes or a player switches sources.

## What it finds

| Section | Sources |
|---|---|
| Iframe src | `iframe[src]`, `frame[src]`, lazy `data-src` / `data-lazy-src` / `data-original` / `data-url` |
| Video poster | `video[poster]`, `data-poster`, `data-poster-url` |
| Video src / source | `video[src]`, each `<source src type>`, lazy `data-src` attributes, and `currentSrc` (what is actually playing) |

It also looks inside open shadow roots (custom players) and inside **every iframe on the page,
including cross-origin ones** — items found in a child frame are labelled `in <host>`.

`blob:` URLs are flagged as MediaSource streams: they are only valid inside that page, so
streaming sites (HLS/DASH) won't expose a downloadable file URL this way.

## Files

- `manifest.json` — Manifest V3 config
- `background.js` — toolbar/shortcut toggle; relays child-frame results to the top frame
- `content.js` — scanner (all frames) and the panel UI (top frame, closed shadow DOM)
- `icons/` — toolbar icons
- `test/demo.html` — sample page with every case; open `test/demo.html?standalone`
  through a local server to try the panel without installing the extension
