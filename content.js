// Media Extractor — content script (runs in every frame).
//
// Top frame: owns the floating panel, scans its own DOM, and merges in items
// that child frames report (relayed through background.js).
// Child frames: scan on request and push updates while the panel is open.
(() => {
  if (window.__mediaExtractorLoaded) return;
  window.__mediaExtractorLoaded = true;

  const IS_TOP = window === window.top;
  const LAZY_SRC_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-url'];
  const LAZY_POSTER_ATTRS = ['data-poster', 'data-poster-url'];
  const SECTIONS = [
    { type: 'iframe', title: 'Iframe src' },
    { type: 'poster', title: 'Video poster' },
    { type: 'video', title: 'Video src / source' },
    { type: 'og', title: 'og:video meta' },
  ];
  const OG_VIDEO_KEYS = ['og:video', 'og:video:url', 'og:video:secure_url'];

  // ---------------------------------------------------------------- messaging

  function sendToBackground(msg) {
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(() => {});
    } catch {
      // Extension was reloaded; this orphaned script can't talk to it anymore.
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (IS_TOP) {
      if (msg.kind === 'toggle') panel.toggle();
      else if (msg.kind === 'frame-items') panel.setFrameItems(msg.frameId, msg.frameUrl, msg.items);
    } else {
      if (msg.kind === 'scan') startReporting();
      else if (msg.kind === 'stop') stopReporting();
    }
  });

  // ----------------------------------------------------------------- scanning

  function absolute(url) {
    if (url == null) return '';
    url = String(url).trim();
    if (!url) return '';
    try {
      return new URL(url, document.baseURI).href;
    } catch {
      return url;
    }
  }

  // The document plus every open shadow root (custom video players often
  // keep their <video> inside one). Our own panel uses a closed root.
  function allRoots() {
    const roots = [document];
    for (let i = 0; i < roots.length; i++) {
      for (const el of roots[i].querySelectorAll('*')) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
    return roots;
  }

  function sizeLabel(el) {
    const w = el.videoWidth || el.clientWidth || el.width;
    const h = el.videoHeight || el.clientHeight || el.height;
    return w && h ? `${w}×${h}` : '';
  }

  function scan() {
    const items = [];
    const seen = new Set();
    const add = (type, rawUrl, notes, el) => {
      const url = absolute(rawUrl);
      if (!url || url === 'about:blank') return;
      const key = type + '|' + url;
      if (seen.has(key)) return;
      seen.add(key);
      const meta = notes.filter(Boolean);
      if (url.startsWith('blob:')) meta.push('blob / MediaSource stream');
      items.push({ type, url, meta: meta.join(' · '), el });
    };

    for (const root of allRoots()) {
      for (const f of root.querySelectorAll('iframe, frame')) {
        const label = f.title || f.name || f.id || '';
        add('iframe', f.getAttribute('src'), ['src', label, sizeLabel(f)], f);
        for (const a of LAZY_SRC_ATTRS) add('iframe', f.getAttribute(a), [a, label], f);
      }

      for (const v of root.querySelectorAll('video')) {
        const size = sizeLabel(v);
        add('poster', v.getAttribute('poster'), ['poster', size], v);
        for (const a of LAZY_POSTER_ATTRS) add('poster', v.getAttribute(a), [a, size], v);

        add('video', v.getAttribute('src'), ['src', size], v);
        for (const a of LAZY_SRC_ATTRS) add('video', v.getAttribute(a), [a, size], v);
        for (const s of v.querySelectorAll('source')) {
          const t = s.getAttribute('type');
          add('video', s.getAttribute('src'), ['<source>', t, s.getAttribute('size') || s.getAttribute('label')], v);
          for (const a of LAZY_SRC_ATTRS) add('video', s.getAttribute(a), ['<source> ' + a, t], v);
        }
        // What the browser actually picked / was assigned via JS.
        add('video', v.currentSrc, ['currentSrc (playing)', size], v);
      }
    }

    // <meta property="og:video" content="…"> (some sites use name= instead).
    const ogContent = (key) =>
      document.querySelector(`meta[property="${key}" i], meta[name="${key}" i]`)?.getAttribute('content') || '';
    const ogType = ogContent('og:video:type');
    const ogW = ogContent('og:video:width');
    const ogH = ogContent('og:video:height');
    for (const m of document.querySelectorAll('meta[property^="og:video" i], meta[name^="og:video" i]')) {
      const key = (m.getAttribute('property') || m.getAttribute('name') || '').toLowerCase();
      if (!OG_VIDEO_KEYS.includes(key)) continue;
      add('og', m.getAttribute('content'), [key, ogType, ogW && ogH ? `${ogW}×${ogH}` : ''], null);
    }
    return items;
  }

  // Re-scan when the DOM changes or a video starts loading a new source.
  function createWatcher(onChange) {
    let timer = 0;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 500);
    };
    const observer = new MutationObserver((records) => {
      if (IS_TOP && records.every((r) => panel.owns(r.target))) return;
      schedule();
    });
    const mediaEvents = ['loadstart', 'loadedmetadata'];
    return {
      start() {
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['src', 'poster', 'data-src', 'data-poster', 'data-lazy-src', 'content'],
        });
        for (const e of mediaEvents) document.addEventListener(e, schedule, true);
      },
      stop() {
        clearTimeout(timer);
        observer.disconnect();
        for (const e of mediaEvents) document.removeEventListener(e, schedule, true);
      },
    };
  }

  // ------------------------------------------------------- child frame logic

  let childWatcher = null;

  function report() {
    const items = scan().map(({ el, ...rest }) => rest);
    sendToBackground({ kind: 'frame-items', frameUrl: location.href, items });
  }

  function startReporting() {
    report();
    if (!childWatcher) {
      childWatcher = createWatcher(report);
      childWatcher.start();
    }
  }

  function stopReporting() {
    childWatcher?.stop();
    childWatcher = null;
  }

  if (!IS_TOP) return;

  // ------------------------------------------------------------- top: panel

  const ICONS = {
    logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="3"/><path d="M10 9l5 3-5 3z" fill="currentColor"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><rect x="3" y="4" width="7" height="16" rx="2" fill="currentColor"/></svg>',
    top: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><rect x="3" y="4" width="18" height="6" rx="2" fill="currentColor"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><rect x="14" y="4" width="7" height="16" rx="2" fill="currentColor"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>',
    open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    locate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>',
  };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel {
      --bg: #0f1218; --bg2: #171b23; --bg3: #1f2530; --line: #2a3140;
      --fg: #e7ebf2; --fg2: #9aa4b5; --accent: #4f8cff; --accent-fg: #fff;
      --ok: #22c55e; --iframe: #a78bfa; --poster: #f59e0b; --video: #38bdf8; --og: #f472b6;
      position: fixed; z-index: 2147483647; display: flex; flex-direction: column;
      background: var(--bg); color: var(--fg); border: 1px solid var(--line);
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 12px 40px rgba(0,0,0,.45); overflow: hidden;
      -webkit-font-smoothing: antialiased; text-align: left; letter-spacing: normal;
    }
    @media (prefers-color-scheme: light) {
      .panel {
        --bg: #ffffff; --bg2: #f5f7fa; --bg3: #eaeef4; --line: #d9dfe8;
        --fg: #141922; --fg2: #5b6576; --accent: #2563eb;
        --iframe: #7c3aed; --poster: #d97706; --video: #0284c7; --og: #db2777;
        box-shadow: 0 12px 40px rgba(15,23,42,.18);
      }
    }
    .panel.right { top: 12px; right: 12px; bottom: 12px; width: 400px; border-radius: 12px; }
    .panel.left  { top: 12px; left: 12px;  bottom: 12px; width: 400px; border-radius: 12px; }
    .panel.top   { top: 0; left: 0; right: 0; height: 360px; border-radius: 0 0 12px 12px; border-top: 0; }
    @media (max-width: 480px) {
      .panel.right, .panel.left { left: 8px; right: 8px; width: auto; }
    }

    header { display: flex; align-items: center; gap: 8px; padding: 10px 10px 10px 14px; border-bottom: 1px solid var(--line); background: var(--bg2); }
    .brand { display: flex; align-items: center; gap: 8px; font-weight: 650; font-size: 14px; flex: 1; min-width: 0; }
    .brand svg { width: 18px; height: 18px; color: var(--accent); flex: none; }
    .total { font-weight: 600; font-size: 11px; color: var(--fg2); background: var(--bg3); padding: 1px 7px; border-radius: 99px; }
    .icon-btn { all: unset; cursor: pointer; display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 7px; color: var(--fg2); }
    .icon-btn:hover { background: var(--bg3); color: var(--fg); }
    .icon-btn.active { color: var(--accent); }
    .icon-btn svg { width: 16px; height: 16px; }
    .sep { width: 1px; height: 18px; background: var(--line); margin: 0 2px; }

    .toolbar { display: flex; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
    .toolbar input {
      all: unset; flex: 1; min-width: 0; padding: 6px 10px; border-radius: 8px; font-size: 12.5px;
      background: var(--bg2); border: 1px solid var(--line); color: var(--fg);
    }
    .toolbar input:focus { border-color: var(--accent); }
    .btn {
      all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
      padding: 6px 10px; border-radius: 8px; font-size: 12px; font-weight: 600;
      background: var(--accent); color: var(--accent-fg);
    }
    .btn:hover { filter: brightness(1.08); }
    .btn svg { width: 14px; height: 14px; }
    .btn.ok { background: var(--ok); }

    .body { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 0 8px; }
    .panel.top .body { display: grid; grid-template-columns: repeat(4, minmax(300px, 1fr)); overflow: auto hidden; padding: 0; }
    .panel.top section { overflow: hidden auto; border-right: 1px solid var(--line); padding-bottom: 8px; }
    .panel.top section:last-child { border-right: 0; }

    section h3 {
      all: unset; display: flex; align-items: center; gap: 8px; padding: 10px 12px 6px;
      font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--fg2);
      position: sticky; top: 0; background: var(--bg); z-index: 1;
    }
    section h3 .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    section[data-type="iframe"] .dot { background: var(--iframe); }
    section[data-type="poster"] .dot { background: var(--poster); }
    section[data-type="video"]  .dot { background: var(--video); }
    section[data-type="og"]     .dot { background: var(--og); }
    section h3 .name { flex: 1; }
    section h3 .count { font-variant-numeric: tabular-nums; }
    .sec-copy { all: unset; cursor: pointer; font-size: 11px; font-weight: 600; text-transform: none; letter-spacing: 0; color: var(--accent); padding: 2px 6px; border-radius: 6px; }
    .sec-copy:hover { background: var(--bg3); }
    .sec-copy[hidden] { display: none; }

    ul { list-style: none; margin: 0; padding: 0 8px; }
    li { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 9px; }
    li:hover { background: var(--bg2); }
    .thumb { width: 54px; height: 34px; border-radius: 5px; object-fit: cover; flex: none; background: var(--bg3); border: 1px solid var(--line); }
    .thumb.broken { display: grid; place-items: center; color: var(--fg2); }
    .thumb.broken svg { width: 16px; height: 16px; opacity: .6; }
    .info { flex: 1; min-width: 0; }
    .url {
      display: block; font: 12px/1.35 ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--fg);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; user-select: text; cursor: text;
    }
    .meta { font-size: 11px; color: var(--fg2); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta .frame { color: var(--accent); }
    .row-btns { display: flex; gap: 2px; flex: none; }
    .row-btns .icon-btn { width: 26px; height: 26px; }
    .row-btns .copy { color: var(--accent); }
    .row-btns .copy.ok { color: var(--ok); }
    .empty { margin: 2px 20px 8px; font-size: 12px; color: var(--fg2); font-style: italic; }
    footer { padding: 7px 12px; font-size: 11px; color: var(--fg2); border-top: 1px solid var(--line); background: var(--bg2); }
    kbd { font: 10.5px ui-monospace, Consolas, monospace; padding: 1px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); }

    .highlight {
      position: fixed; z-index: 2147483646; pointer-events: none; border-radius: 4px;
      outline: 3px solid #4f8cff; background: rgba(79,140,255,.18); transition: all .12s ease;
    }
    .toast {
      position: fixed; z-index: 2147483647; left: 50%; bottom: 24px; transform: translateX(-50%);
      background: #111827; color: #fff; padding: 8px 14px; border-radius: 8px; font: 600 12.5px system-ui, sans-serif;
      box-shadow: 0 6px 24px rgba(0,0,0,.35); opacity: 0; transition: opacity .15s;
    }
    .toast.show { opacity: 1; }
  `;

  // Small DOM helper — all page-derived strings go through textContent.
  function h(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'html') el.innerHTML = v; // static ICONS only
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) if (c) el.append(c);
    return el;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Clipboard API blocked (insecure page / permissions policy): fall back.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.documentElement.append(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {}
      ta.remove();
      return ok;
    }
  }

  function shortFrame(url) {
    try {
      const u = new URL(url);
      return u.host || u.protocol.replace(':', '');
    } catch {
      return 'iframe';
    }
  }

  const panel = (() => {
    let host = null;
    let root = null;
    let els = {};
    let open = false;
    let dock = 'right';
    let filter = '';
    let localItems = [];
    const frameItems = new Map(); // frameId -> { frameUrl, items }
    const watcher = createWatcher(() => {
      localItems = scan();
      render();
    });

    try {
      chrome.storage?.local.get('dock').then((r) => {
        if (r?.dock) setDock(r.dock, false);
      }).catch(() => {});
    } catch {}

    function build() {
      host = document.createElement('media-extractor-panel');
      root = host.attachShadow({ mode: 'closed' });
      root.append(h('style', { text: CSS }));

      const dockBtn = (d, title) =>
        h('button', { class: 'icon-btn', 'data-dock': d, title, html: ICONS[d], onclick: () => setDock(d) });

      els.total = h('span', { class: 'total', text: '0' });
      els.filter = h('input', {
        type: 'search',
        placeholder: 'Filter URLs…',
        spellcheck: 'false',
        oninput: (e) => {
          filter = e.target.value.trim().toLowerCase();
          render();
        },
      });
      els.copyAll = h('button', { class: 'btn', html: ICONS.copy + '<span>Copy all</span>', onclick: copyAll });

      els.sections = {};
      const sections = SECTIONS.map(({ type, title }) => {
        const count = h('span', { class: 'count', text: '0' });
        const secCopy = h('button', { class: 'sec-copy', text: 'Copy list', onclick: () => copySection(type, secCopy) });
        const list = h('ul');
        const empty = h('p', { class: 'empty', text: 'None found' });
        els.sections[type] = { count, list, empty, secCopy };
        return h('section', { 'data-type': type }, [
          h('h3', {}, [h('span', { class: 'dot' }), h('span', { class: 'name', text: title }), count, secCopy]),
          list,
          empty,
        ]);
      });

      els.panel = h('div', { class: 'panel ' + dock }, [
        h('header', {}, [
          h('div', { class: 'brand', html: ICONS.logo }, [h('span', { text: 'Media Extractor' }), els.total]),
          h('button', { class: 'icon-btn', title: 'Rescan page', html: ICONS.refresh, onclick: refresh }),
          h('span', { class: 'sep' }),
          dockBtn('left', 'Dock left'),
          dockBtn('top', 'Dock top'),
          dockBtn('right', 'Dock right'),
          h('span', { class: 'sep' }),
          h('button', { class: 'icon-btn', title: 'Close (Esc)', html: ICONS.close, onclick: hide }),
        ]),
        h('div', { class: 'toolbar' }, [els.filter, els.copyAll]),
        h('div', { class: 'body' }, sections),
        h('footer', { html: 'Toggle with <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> · hover a row to highlight it on the page' }),
      ]);
      els.highlight = h('div', { class: 'highlight', hidden: true });
      els.toast = h('div', { class: 'toast' });
      root.append(els.panel, els.highlight, els.toast);

      els.panel.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hide();
        e.stopPropagation(); // keep page hotkeys from firing while typing in the filter
      });
      syncDockButtons();
    }

    function setDock(d, save = true) {
      if (!['left', 'top', 'right'].includes(d)) return;
      dock = d;
      if (els.panel) {
        els.panel.className = 'panel ' + d;
        syncDockButtons();
      }
      if (save) {
        try {
          chrome.storage?.local.set({ dock: d }).catch(() => {});
        } catch {}
      }
    }

    function syncDockButtons() {
      root.querySelectorAll('[data-dock]').forEach((b) => b.classList.toggle('active', b.dataset.dock === dock));
    }

    function allItems() {
      const out = localItems.map((it) => ({ ...it, frame: null }));
      for (const { frameUrl, items } of frameItems.values()) {
        for (const it of items) out.push({ ...it, frame: frameUrl });
      }
      // Same URL found by several frames: keep the first.
      const seen = new Set();
      return out.filter((it) => {
        const k = it.type + '|' + it.url;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }

    function visibleItems() {
      const items = allItems();
      return filter ? items.filter((it) => it.url.toLowerCase().includes(filter)) : items;
    }

    function render() {
      if (!open) return;
      const items = visibleItems();
      els.total.textContent = String(allItems().length);
      for (const { type } of SECTIONS) {
        const s = els.sections[type];
        const list = items.filter((it) => it.type === type);
        s.count.textContent = String(list.length);
        s.empty.hidden = list.length > 0;
        s.empty.textContent = filter ? 'No matches' : 'None found';
        s.secCopy.hidden = list.length < 2;
        s.list.replaceChildren(...list.map(row));
      }
    }

    function row(it) {
      const copyBtn = h('button', { class: 'icon-btn copy', title: 'Copy URL', html: ICONS.copy });
      copyBtn.addEventListener('click', async () => {
        const ok = await copyText(it.url);
        flash(copyBtn, ok);
      });

      const btns = [copyBtn];
      if (!it.url.startsWith('data:')) {
        btns.push(
          h('button', {
            class: 'icon-btn',
            title: 'Open in new tab',
            html: ICONS.open,
            onclick: () => window.open(it.url, '_blank', 'noopener'),
          }),
        );
      }
      if (it.el) {
        btns.push(
          h('button', {
            class: 'icon-btn',
            title: 'Scroll to element',
            html: ICONS.locate,
            onclick: () => {
              it.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              setTimeout(() => showHighlight(it.el), 400);
            },
          }),
        );
      }

      const meta = h('div', { class: 'meta' });
      if (it.frame) meta.append(h('span', { class: 'frame', text: 'in ' + shortFrame(it.frame) }), it.meta ? ' · ' : '');
      if (it.meta) meta.append(it.meta);

      const children = [];
      if (it.type === 'poster') {
        const img = h('img', { class: 'thumb', src: it.url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
        img.addEventListener('error', () => img.replaceWith(h('div', { class: 'thumb broken', title: 'Preview unavailable', html: ICONS.logo })), { once: true });
        children.push(img);
      }
      children.push(
        h('div', { class: 'info' }, [h('span', { class: 'url', title: it.url, text: it.url }), meta]),
        h('div', { class: 'row-btns' }, btns),
      );

      const li = h('li', {}, children);
      if (it.el) {
        li.addEventListener('mouseenter', () => showHighlight(it.el));
        li.addEventListener('mouseleave', hideHighlight);
      }
      return li;
    }

    function showHighlight(el) {
      if (!el.isConnected) return hideHighlight();
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return hideHighlight();
      Object.assign(els.highlight.style, {
        left: r.left + 'px',
        top: r.top + 'px',
        width: r.width + 'px',
        height: r.height + 'px',
      });
      els.highlight.hidden = false;
    }

    function hideHighlight() {
      els.highlight.hidden = true;
    }

    function flash(btn, ok) {
      if (!ok) return toast('Copy failed — select the URL and press Ctrl+C');
      btn.classList.add('ok');
      btn.innerHTML = ICONS.check;
      setTimeout(() => {
        btn.classList.remove('ok');
        btn.innerHTML = ICONS.copy;
      }, 1200);
    }

    let toastTimer = 0;
    function toast(text) {
      els.toast.textContent = text;
      els.toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1600);
    }

    async function copySection(type, btn) {
      const urls = visibleItems().filter((it) => it.type === type).map((it) => it.url);
      if (!urls.length) return;
      const ok = await copyText(urls.join('\n'));
      if (ok) {
        btn.textContent = 'Copied!';
        setTimeout(() => (btn.textContent = 'Copy list'), 1200);
      } else toast('Copy failed');
    }

    async function copyAll() {
      const items = visibleItems();
      if (!items.length) return toast('Nothing to copy');
      const text = SECTIONS.map(({ type, title }) => {
        const urls = items.filter((it) => it.type === type).map((it) => it.url);
        return urls.length ? `# ${title} (${urls.length})\n${urls.join('\n')}` : '';
      })
        .filter(Boolean)
        .join('\n\n');
      const ok = await copyText(text);
      if (ok) {
        els.copyAll.classList.add('ok');
        els.copyAll.lastChild.textContent = `Copied ${items.length}`;
        setTimeout(() => {
          els.copyAll.classList.remove('ok');
          els.copyAll.lastChild.textContent = 'Copy all';
        }, 1400);
      } else toast('Copy failed');
    }

    function refresh() {
      frameItems.clear();
      localItems = scan();
      render();
      sendToBackground({ kind: 'scan-all' });
    }

    function show() {
      if (!host) build();
      if (!host.isConnected) document.documentElement.append(host);
      open = true;
      watcher.start();
      refresh();
    }

    function hide() {
      open = false;
      watcher.stop();
      hideHighlight();
      host?.remove();
      sendToBackground({ kind: 'stop-all' });
    }

    return {
      toggle: () => (open ? hide() : show()),
      owns: (node) => !!host && (node === host || host.contains(node)),
      setFrameItems(frameId, frameUrl, items) {
        if (!open) return;
        frameItems.set(frameId, { frameUrl, items: Array.isArray(items) ? items : [] });
        render();
      },
    };
  })();

  // Exposed only for the standalone demo page (test/demo.html).
  window.__mediaExtractorPanel = panel;
})();
