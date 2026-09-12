// ==UserScript==
// @name         Sniper — send text to the local relay
// @namespace    south.sniper
// @version      0.38.0
// @description  Ship code blocks / selections from a designated page to the sniper relay on 127.0.0.1:7355
// @author       South
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_openInTab
// @grant        GM_setClipboard
// @connect      127.0.0.1
// @connect      localhost
//
// ---- designated sites --------------------------------------------------
// A browser needs @match at install time, so adding a SITE costs one re-install.
// Tuning that site's SELECTORS does not: those come from sites.json at runtime.
// @match        https://chat.deepseek.com/*
// @match        https://*.deepseek.com/*
// @match        https://chat.qwen.ai/*
// @match        https://www.kimi.ai/*
// @match        https://kimi.ai/*
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://claude.ai/*
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '0.38.0';
  const BASE  = 'http://127.0.0.1:7355';
  const KEY   = '__PASTE_YOUR_SNIPER_KEY__';

  // Tried in order; first one that matches anything wins. DeepSeek renders
  // fenced code into .md-code-block; plain <pre> covers most other sites.
  const CANDIDATES = [
    'pre',
    '.md-code-block',
    '[class*="md-code"]',
    '[class*="code-block"]',
    '[class*="codeBlock"]',
    '[class*="highlight"] > code',
    'code',
  ];

  // Whole-message targets. Confirmed against a real DeepSeek census 2026-09-10:
  // it renders markdown into .ds-markdown inside .ds-assistant-message-main-content,
  // with hashed CSS-module classes around them and a .ds-virtual-list parent
  // (so messages unmount when scrolled away - the observer re-decorates).
  // These always exist, unlike code blocks, so the button is never missing.
  const MESSAGES = [
    '.ds-markdown',
    '.ds-assistant-message-main-content',
    '[class*="markdown"]',
    '[class*="message-content"]',
    '[class*="message"] > div',
  ];

  // What a site's own entry is merged ON TOP of, so an unknown host still works.
  const CANDIDATES_FALLBACK = { code: CANDIDATES, messages: MESSAGES,
                                composer: ['textarea', '[contenteditable="true"]'] };

  // Per-site adapters, fetched from the relay (sites.json) so a selector can be
  // tuned without re-installing this script. These built-ins are the fallback
  // and the generic chain is always appended, so an unknown site still works.
  let SITE = { label: location.hostname, code: [], messages: [], composer: [] };

  function applySites(table) {
    const generic = table["*"] || {};
    const mine = table[location.hostname] || {};
    const merge = (k) => {
      const seen = new Set(), out = [];
      for (const sel of [].concat(mine[k] || [], CANDIDATES_FALLBACK[k] || [],
                                  generic[k] || [])) {
        if (sel && !seen.has(sel)) { seen.add(sel); out.push(sel); }
      }
      return out;
    };
    SITE = { label: mine.label || generic.label || location.hostname,
             code: merge("code"), messages: merge("messages"),
             composer: merge("composer"),
             // Furniture to hide before reading a message, and extra chrome
             // phrases to drop. Both per-site, both tunable without reinstalling.
             exclude: [].concat(mine.exclude || [], generic.exclude || []),
             chrome: [].concat(mine.chrome || [], generic.chrome || [])
                       .map((s) => String(s).toLowerCase()),
             // Rebuild text from screen geometry instead of DOM order.
             visualOrder: Boolean(mine.visualOrder || generic.visualOrder),
             ui: Object.assign({}, generic.ui || {}, mine.ui || {}) };

    // Where the hub sits is a per-site fact, not a constant. Pushed through CSS
    // variables so changing it is a sites.json edit, not a code edit.
    const root = document.documentElement;
    root.style.setProperty('--sniper-hub-top', (SITE.ui.hubTop || '6px'));
    root.style.setProperty('--sniper-hub-right', (SITE.ui.hubRight || '6px'));
    root.style.setProperty('--sniper-code-top', (SITE.ui.codeTop || '6px'));
    root.style.setProperty('--sniper-code-right', (SITE.ui.codeRight || '6px'));
    // The bottom-left dock (launch pill, codebase, feedback, offer, env menu)
    // is one stack; a site whose own furniture lives there (ChatGPT's sidebar
    // footer) moves the whole stack with two numbers.
    root.style.setProperty('--sniper-dock-left', (SITE.ui.dockLeft || '16px'));
    root.style.setProperty('--sniper-dock-bottom', (SITE.ui.dockBottom || '16px'));
    console.log('[sniper] site adapter:', SITE.label, SITE);
  }

  // The project the buttons act on. The relay owns this, so switching
  // environments in the console changes what this page sends - no hardcoded
  // project name anywhere, which is what lets someone else use this at all.
  let ENV = '';

  // Everything that changes the target comes through here, so the button in
  // the corner always says where the next drop is going. In a session that
  // runs for hours that label is the only thing standing between you and
  // shipping code into last week's project.
  let launcher = null;
  function setEnv(name) {
    ENV = name || '';
    if (!launcher) return;
    launcher.textContent = ENV ? ('\u29c9 ' + ENV) : '\u29c9 load environment';
    launcher.title = (ENV ? 'Edits from this chat land in "' + ENV + '". ' : '')
                   + 'Click to switch, or start a new environment (Alt+E)';
  }

  let shadowSeen = 0;      // >0 means we must use the deep walker
  let chosen = null;
  let decorated = 0;

  // Mirrors config.json. Fetched at startup; this default matches the relay's,
  // so we behave correctly even if the fetch fails.
  let ROUTING = { codeblock: 'queue', proposal: 'queue',
                  selection: 'queue', message: 'context' };
  const routeOf = (kind) => ROUTING[kind || 'codeblock'] || 'queue';

  // The structural guard is a CODE check: balanced delimiters, no duplicated
  // lines. Prose has neither property and never did - an explanation with
  // "Math.max(x, y" in a table is not corrupt, it is English. Only check what
  // is destined to be written to a file.
  const needsCodeCheck = (kind) => routeOf(kind) === 'queue';

  // ---- untrusted-text guard ------------------------------------------------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const STYLE = GM_addStyle(`
    .sniper-host { position: relative !important; }
    .sniper-btn {
      position: absolute; z-index: 2147483000;
      top: var(--sniper-code-top, 6px); right: var(--sniper-code-right, 6px);
      font: 600 11px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .02em;
      padding: 5px 9px; border-radius: 6px; cursor: pointer;
      border: 1px solid rgba(127,127,127,.45);
      background: rgba(22,22,26,.86); color: #e8e8ea;
      opacity: .55; transition: opacity .12s ease, background .12s ease;
    }
    .sniper-host:hover .sniper-btn { opacity: 1; }
    .sniper-btn:hover  { background: #2f6feb; border-color: #2f6feb; }
    /* One hub per message. Only a corner is ever needed, which is the one
       thing every chat layout leaves free. Offsets are per-site (sites.json)
       because Qwen does not put its own controls where DeepSeek does. */
    .sniper-hub {
      position: absolute; z-index: 2147483001;
      top: var(--sniper-hub-top, 6px); right: var(--sniper-hub-right, 6px);
      width: 26px; height: 26px; line-height: 1; border-radius: 50%;
      font: 600 14px/1 ui-sans-serif, system-ui, sans-serif; cursor: pointer;
      border: 1px solid rgba(127,127,127,.45);
      background: rgba(22,22,26,.86); color: #cfd4dc;
      opacity: 0; transition: opacity .12s ease, background .12s ease;
      display: flex; align-items: center; justify-content: center; padding: 0;
    }
    .sniper-host:hover > .sniper-hub { opacity: .85; }
    .sniper-hub:hover { opacity: 1 !important; background: #2f6feb; color: #fff;
                        border-color: #2f6feb; }
    .sniper-hub[data-busy="1"] { opacity: 1; background: #8a5a12;
                                 border-color: #8a5a12; color: #fff; }
    .sniper-menu {
      position: absolute; z-index: 2147483002;
      top: calc(var(--sniper-hub-top, 6px) + 30px);
      right: var(--sniper-hub-right, 6px);
      min-width: 232px; padding: 5px; border-radius: 10px;
      background: rgba(18,18,22,.98); border: 1px solid rgba(255,255,255,.16);
      box-shadow: 0 10px 30px rgba(0,0,0,.55);
    }
    .sniper-menu button {
      display: block; width: 100%; text-align: left; cursor: pointer;
      font: 600 12.5px/1.3 ui-sans-serif, system-ui, sans-serif;
      padding: 8px 10px; border: 0; border-radius: 7px;
      background: transparent; color: #e8e8ea;
    }
    .sniper-menu button:hover { background: rgba(47,111,235,.3); }
    .sniper-menu small { display: block; color: #9aa1ad; font-weight: 500;
                         font-size: 11px; margin-top: 2px; }
    .sniper-btn[data-state="ok"]   { background: #1f7a3d; border-color: #1f7a3d; opacity: 1; }
    .sniper-btn[data-state="fail"] { background: #a3271f; border-color: #a3271f; opacity: 1; }
    .sniper-toast {
      position: fixed; right: 18px; bottom: 18px; z-index: 2147483600;
      font: 500 12.5px/1.45 ui-sans-serif, system-ui, sans-serif;
      max-width: 400px; padding: 10px 13px; border-radius: 9px;
      background: rgba(18,18,22,.95); color: #f0f0f2; white-space: pre-wrap;
      border: 1px solid rgba(255,255,255,.14);
      box-shadow: 0 8px 26px rgba(0,0,0,.42);
      opacity: 0; transform: translateY(6px); transition: opacity .15s, transform .15s;
    }
    .sniper-toast[data-in="1"] { opacity: 1; transform: none; }
    .sniper-toast b { color: #7fb2ff; font-weight: 700; }
    .sniper-toast-click { cursor: pointer; border-color: rgba(127,178,255,.5); }
    .sniper-toast-click:hover { background: rgba(30,42,66,.98); }
    .sniper-launch {
      position: fixed; left: var(--sniper-dock-left, 16px); bottom: var(--sniper-dock-bottom, 16px); z-index: 2147483500;
      font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
      padding: 9px 13px; border-radius: 999px; cursor: pointer;
      border: 1px solid rgba(127,127,127,.4); background: rgba(22,22,26,.9);
      color: #e8e8ea; opacity: .5; transition: opacity .12s, background .12s;
    }
    .sniper-launch:hover { opacity: 1; background: #2f6feb; border-color: #2f6feb; }
    .sniper-codebase { left: var(--sniper-dock-left, 16px); bottom: calc(var(--sniper-dock-bottom, 16px) + 38px); }
    .sniper-codebase:hover { background: #6b4bd6; border-color: #6b4bd6; }
    .sniper-feedback { left: var(--sniper-dock-left, 16px); bottom: calc(var(--sniper-dock-bottom, 16px) + 76px); }
    .sniper-feedback:hover { background: #a35a1f; border-color: #a35a1f; }
    .sniper-offer {
      position: fixed; left: var(--sniper-dock-left, 16px); bottom: calc(var(--sniper-dock-bottom, 16px) + 164px); z-index: 2147483550;
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      max-width: 460px; padding: 10px 12px; border-radius: 10px;
      font: 500 12.5px/1.4 ui-sans-serif, system-ui, sans-serif;
      background: rgba(18,18,22,.97); color: #e8e8ea;
      border: 1px solid rgba(255,255,255,.14);
      box-shadow: 0 10px 30px rgba(0,0,0,.5);
    }
    .sniper-offer button {
      font: 600 11.5px/1 ui-sans-serif, system-ui, sans-serif; cursor: pointer;
      padding: 6px 10px; border-radius: 7px; color: #e8e8ea;
      border: 1px solid rgba(127,127,127,.45); background: rgba(40,44,54,.9);
    }
    .sniper-offer button:first-of-type { background: #2f6feb; border-color: #2f6feb; }
    .sniper-offer button:hover { filter: brightness(1.2); }
    .sniper-envs {
      position: fixed; left: var(--sniper-dock-left, 16px); bottom: calc(var(--sniper-dock-bottom, 16px) + 118px); z-index: 2147483500;
      background: rgba(18,18,22,.97); border: 1px solid rgba(255,255,255,.14);
      border-radius: 10px; padding: 6px; min-width: 240px;
      box-shadow: 0 10px 30px rgba(0,0,0,.5);
    }
    .sniper-envs button {
      display: block; width: 100%; text-align: left; cursor: pointer;
      font: 500 12.5px/1.4 ui-sans-serif, system-ui, sans-serif;
      padding: 8px 10px; border: 0; border-radius: 7px;
      background: transparent; color: #e8e8ea;
    }
    .sniper-envs button:hover { background: rgba(47,111,235,.28); }
    .sniper-envs small { display: block; color: #9aa1ad; font-size: 11px; }
  `);

  // ChatGPT (and any app that re-renders its root) throws away elements we
  // append to <body>. Everything fixed-position lives in one host under
  // <html> instead, and a keep-alive puts host and stylesheet back the moment
  // either is disconnected. Position: fixed is unaffected by the parent.
  const DOCK = document.createElement('div');
  DOCK.className = 'sniper-dock';
  function dock(el) {
    if (!DOCK.isConnected) document.documentElement.appendChild(DOCK);
    if (el && el.parentNode !== DOCK) DOCK.appendChild(el);
    return el;
  }
  function keepAlive() {
    if (!DOCK.isConnected) document.documentElement.appendChild(DOCK);
    if (STYLE && !STYLE.isConnected) (document.head || document.documentElement).appendChild(STYLE);
  }
  new MutationObserver(keepAlive).observe(document.documentElement, { childList: true });
  if (document.head) new MutationObserver(keepAlive).observe(document.head, { childList: true });
  setInterval(keepAlive, 1500);

  let toastEl = null, toastTimer = null, toastAction = null;
  function toast(msg, ms = 2600, onClick = null) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'sniper-toast';
      toastEl.addEventListener('click', () => {
        if (toastAction) { const f = toastAction; toastAction = null; f(); }
      });
      dock(toastEl);
    }
    toastEl.innerHTML = msg;
    toastAction = onClick;
    toastEl.classList.toggle('sniper-toast-click', Boolean(onClick));
    requestAnimationFrame(() => toastEl.setAttribute('data-in', '1'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.removeAttribute('data-in');
      toastAction = null;
    }, ms);
  }

  // ---- DOM access that survives shadow roots -------------------------------
  function deepAll(sel, root = document, out = [], depth = 0) {
    if (depth > 10) return out;
    try { root.querySelectorAll(sel).forEach((n) => out.push(n)); } catch (_) {}
    const hosts = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of hosts) {
      if (el.shadowRoot) { shadowSeen++; deepAll(sel, el.shadowRoot, out, depth + 1); }
    }
    return out;
  }
  const findAll = (sel) => (shadowSeen > 0 ? deepAll(sel) : Array.from(document.querySelectorAll(sel)));

  // ---- census: what can this script actually see? --------------------------
  // Find the tightest element that actually holds multi-line, code-shaped text,
  // whatever it is called. Selector guesses are how we kept missing Qwen: this
  // asks the DOM what code looks like instead of assuming a class name.
  function codeishNodes(limit = 12) {
    const out = [];
    let els;
    try { els = document.querySelectorAll('div,pre,section,article,td,span'); }
    catch (_) { return out; }
    for (const el of els) {
      if (out.length >= limit) break;
      if (el.closest && el.closest('.sniper-menu, .sniper-hub')) continue;
      let t = '';
      try { t = el.innerText || ''; } catch (_) { continue; }
      if (t.length < 40) continue;
      const nl = (t.match(/\n/g) || []).length;
      if (nl < 2) continue;
      if (!/[{};()=<>]|=>|def |function |const |class /.test(t)) continue;
      // tightest container only: skip if a child holds nearly the same text
      let tighter = false;
      for (const k of el.children) {
        let kt = '';
        try { kt = k.innerText || ''; } catch (_) {}
        if (kt.length >= t.length * 0.9) { tighter = true; break; }
      }
      if (tighter) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 90),
        lines: nl + 1, chars: t.length,
        white: (getComputedStyle(el).whiteSpace || ''),
        first: t.split('\n')[0].slice(0, 60),
      });
    }
    return out;
  }

  // What the message containers actually hold - length and shape. A census that
  // only counts selectors cannot tell an empty chat from an unreadable one.
  function messageReport(limit = 8) {
    const sels = SITE.messages.length ? SITE.messages : MESSAGES;
    for (const sel of sels) {
      let found = [];
      try { found = findAll(sel); } catch (_) { continue; }
      if (!found.length) continue;
      return found.slice(0, limit).map((el) => {
        let t = '';
        try { t = el.innerText || ''; } catch (_) {}
        return {
          sel, tag: el.tagName.toLowerCase(),
          cls: (typeof el.className === 'string' ? el.className : '').slice(0, 90),
          chars: t.length, lines: (t.match(/\n/g) || []).length + 1,
          kids: Array.from(el.children).slice(0, 6).map((k) =>
            k.tagName.toLowerCase()
            + (typeof k.className === 'string' && k.className
               ? '.' + k.className.trim().split(/\s+/)[0] : '')),
          first: t.trim().split('\n')[0].slice(0, 60),
        };
      });
    }
    return [];
  }

  function skeleton(el, depth = 0, max = 4) {
    if (!el || depth > max) return '';
    // Icon sprite sheets are enormous and say nothing. Skip them entirely.
    if (el.tagName && /^(svg|symbol|path|defs|use)$/i.test(el.tagName)) return '';
    const cls = (typeof el.className === 'string' && el.className)
      ? '.' + el.className.trim().split(/\s+/).slice(0, 4).join('.') : '';
    const kids = Array.from(el.children || []).slice(0, 6);
    let s = '  '.repeat(depth) + el.tagName.toLowerCase() + cls
          + (el.shadowRoot ? '  [#shadow-root]' : '') + '\n';
    for (const k of kids) s += skeleton(k, depth + 1, max);
    return s;
  }

  function census(reason) {
    shadowSeen = 0;
    deepAll('x-nonexistent');                    // cheap pass to count shadow roots

    const codeSels = SITE.code.length ? SITE.code : CANDIDATES;
    const msgSels = SITE.messages.length ? SITE.messages : MESSAGES;
    const selectors = codeSels.concat(msgSels).map((sel) => {
      let count = 0;
      try { count = findAll(sel).length; } catch (_) { count = -1; }
      return { sel, count, role: codeSels.includes(sel) ? 'code' : 'message' };
    });

    // Tally class names on nodes that actually carry text - this is what
    // reveals the message/code container naming when the usual ones miss.
    const tally = {};
    for (const el of document.querySelectorAll('div,section,article,span,pre,code')) {
      const t = el.innerText || '';
      if (t.length < 40 || el.children.length > 4) continue;
      const cn = typeof el.className === 'string' ? el.className.trim() : '';
      if (!cn) continue;
      for (const c of cn.split(/\s+/).slice(0, 3)) tally[c] = (tally[c] || 0) + 1;
    }
    const top_classes = Object.entries(tally)
      .sort((a, b) => b[1] - a[1]).slice(0, 25)
      .map(([cls, n]) => ({ cls, n }));

    // Skeleton around the biggest block of text on the page. Anchored on a
    // message container when we have one - "biggest text" alone picked up an
    // SVG sprite sheet on Qwen and told us nothing.
    let biggest = null, bigLen = 0;
    const msgSel = (SITE.messages.length ? SITE.messages : MESSAGES);
    for (const sel of msgSel) {
      let f = [];
      try { f = findAll(sel); } catch (_) { continue; }
      if (f.length) { biggest = f[f.length - 1]; break; }
    }
    if (!biggest) {
      for (const el of document.querySelectorAll('div,article,section')) {
        const t = (el.innerText || '').length;
        if (t > bigLen && t < 20000) { bigLen = t; biggest = el; }
      }
    }
    const anchor = biggest && biggest.parentElement ? biggest.parentElement : biggest;

    const body = {
      script_version: VERSION,
      reason,
      url: location.href,
      title: document.title,
      ready_state: document.readyState,
      iframes: document.querySelectorAll('iframe').length,
      shadow_roots: shadowSeen,
      total_elements: document.querySelectorAll('*').length,
      body_text_len: (document.body.innerText || '').length,
      chosen_selector: chosen,
      decorated,
      selectors,
      top_classes,
      // What the message containers actually hold, and anything code-shaped
      // regardless of what it is called. These two answer "is this chat empty
      // or is our reader blind", which counting selectors never could.
      messages: messageReport(),
      codeish: codeishNodes(),
      // Qwen's blocks are Monaco editors, so the numbers that decide whether a
      // capture can be complete belong in the census too.
      monaco: monacoReport(),
      // How this site builds its preview. Both DeepSeek and Qwen render HTML
      // in a sandboxed iframe; the sandbox flags decide what a game can do in
      // there (pointer lock, most notably). Measured, not assumed.
      frames: Array.from(document.querySelectorAll('iframe')).slice(0, 6)
        .map((f) => ({
          src: (f.getAttribute('src') || '').slice(0, 80),
          srcdoc: f.hasAttribute('srcdoc'),
          sandbox: f.getAttribute('sandbox'),
          allow: f.getAttribute('allow'),
          cls: (typeof f.className === 'string' ? f.className : '').slice(0, 60),
          w: Math.round(f.getBoundingClientRect().width),
          h: Math.round(f.getBoundingClientRect().height),
        })),
      canvases: Array.from(document.querySelectorAll('canvas')).slice(0, 4)
        .map((c) => ({
          cls: (typeof c.className === 'string' ? c.className : '').slice(0, 60),
          w: c.width, h: c.height,
        })),
      // Per-block language + shape, so a lang miss is visible rather than
      // silently becoming null on every drop.
      blocks: (chosen ? findAll(chosen) : []).slice(0, 20).map((b) => {
        const t = textOf(b, 'codeblock');
        const first = (t.split('\n')[0] || '').slice(0, 70);
        return {
          lang: langOf(b),
          lines: t.split('\n').length,
          addressed: /^\s*(?:\/\/|#|--|;|%|<!--|\/\*)?\s*>>/.test(t),
          // The decisive measurement: does corruption correlate with the
          // block's language label? If every `text` block is broken and every
          // `javascript` one is clean, the fault is in their renderer's
          // un-highlighted path, and no amount of waiting will fix it.
          corrupt: corruptionIn(t),
          first,
          header: ((b.closest && b.closest('[class*="code-block"], [class*="md-code"]')
                   || b.parentElement || b).textContent || '')
                   .slice(0, 40).replace(/\s+/g, ' ').trim(),
        };
      }),
      skeleton: anchor ? skeleton(anchor, 0, 5).slice(0, 6000) : null,
    };

    GM_xmlhttpRequest({
      method: 'POST', url: BASE + '/diag',
      headers: { 'Content-Type': 'application/json', 'X-Sniper-Key': KEY },
      data: JSON.stringify(body), timeout: 8000,
      onload(res) {
        if (res.status === 200) toast('<b>census sent</b> — check the relay window', 3200);
        else toast(`<b>census refused</b> (${esc(res.status)})`, 4000);
      },
      onerror() { toast('<b>relay unreachable</b>\nis the relay window still open?', 4200); },
      ontimeout() { toast('<b>census timed out</b>', 4000); },
    });
    console.log('[sniper] census', body);
  }

  // ---- sending ------------------------------------------------------------
  // Chat UIs hang furniture off their messages: a language label, a copy
  // button, a "Thinking completed" header, and - on Qwen - a line-number
  // gutter that innerText reads as a column of bare integers, often out of
  // order because it is virtualised. None of that is the explanation.
  //
  // Stripped by SHAPE rather than class name, so it works on a site whose
  // markup we have not measured. sites.json can add `chrome` phrases per host.
  const CHROME_LINES = new Set([
    'copy', 'copied', 'download', 'edit', 'share', 'retry', 'regenerate',
    'thinking completed', 'thought for a moment', 'show more', 'show less',
    'expand', 'collapse', 'run', 'preview', 'wrap', 'raw',
  ]);

  function stripChrome(text) {
    const lines = text.split('\n');
    const isNum = (s) => /^\s*\d{1,5}\s*$/.test(s);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const low = raw.trim().toLowerCase();

      if (CHROME_LINES.has(low)) continue;
      if (SITE.chrome && SITE.chrome.includes(low)) continue;

      // A run of 3+ bare numbers is a gutter, never prose. One or two could
      // legitimately be content, so leave those alone.
      if (isNum(raw)) {
        let j = i;
        while (j < lines.length && isNum(lines[j])) j++;
        if (j - i >= 3) { i = j - 1; continue; }
      }
      out.push(raw);
    }
    // collapse the blank lines the removals leave behind
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Some chats render code lines in an order that is not DOM order - Qwen does,
  // which is why a naive innerText comes back shuffled (`}` before the `{` that
  // opened it). The screen is never wrong, so rebuild reading order from
  // geometry: group text-bearing leaves into rows by their Y position, order
  // each row by X, and join.
  // Rebuilding reading order from the screen is only half the job. A syntax
  // highlighter puts every token in its own <span>, so the WHITESPACE between
  // tokens lives in no text node at all - joining runs with '' welds them
  // together (`<html lang=` comes back as `<htmllang=`) and fuses the gutter
  // number onto the first token. Those gaps ARE on screen, so measure them and
  // put the spaces back, using a run's own width/length as the character cell.
  function textByVisualOrder(el, prose) {
    const rows = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || (p.closest && p.closest('.sniper-btn, .sniper-hub, .sniper-menu')))
          return NodeFilter.FILTER_REJECT;
        // A Monaco editor sitting inside a MESSAGE is a code block, not prose.
        // What it has mounted is a fragment in recycled order, and prose mode
        // has no indentation to put back - folding that into an explanation
        // corrupts the one file both agents read for intent, and the guard
        // cannot catch it because the guard does not run on prose. Skip it;
        // a marker goes in at its own position below.
        if (prose && p.closest && p.closest('.monaco-editor'))
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      let r;
      try {
        const range = document.createRange();
        range.selectNodeContents(n);
        r = range.getBoundingClientRect();
      } catch (_) { continue; }
      if (!r || (!r.width && !r.height)) continue;
      // Normalise NBSP here, at the source. A highlighter emits them for the
      // spaces it DOES keep, and they are not spaces to any parser downstream.
      rows.push({ top: Math.round(r.top), left: r.left, right: r.right,
                  text: n.nodeValue.replace(/\u00a0/g, ' ') });
    }
    // Say where a skipped editor was. Its own rect gives the position, so the
    // marker lands in reading order with no DOM mutation - and the explanation
    // still records that a block was there, which is what makes it obvious the
    // code travels by the queue and not by the context file.
    if (prose) {
      for (const ed of el.querySelectorAll('.monaco-editor')) {
        let r;
        try { r = ed.getBoundingClientRect(); } catch (_) { continue; }
        if (!r || (!r.width && !r.height)) continue;
        const n = monacoShape(ed).total;
        rows.push({ top: Math.round(r.top), left: r.left, right: r.left,
                    text: '[code block' + (n ? ' - ' + n + ' lines' : '')
                        + ' - sniped separately, not included here]' });
      }
    }
    if (!rows.length) return { text: '', runs: 0, gutter: false };

    // Bucket by line. 4px of slack absorbs sub-pixel and superscript wobble.
    rows.sort((a, b) => a.top - b.top || a.left - b.left);
    const lines = [];
    let cur = null;
    for (const r of rows) {
      if (!cur || Math.abs(r.top - cur.top) > 4) {
        cur = { top: r.top, parts: [] };
        lines.push(cur);
      }
      cur.parts.push(r);
    }
    for (const l of lines) l.parts.sort((a, b) => a.left - b.left);

    // One character cell, measured rather than assumed. Code is monospace, so
    // width/length of any multi-character run gives it; the median shrugs off
    // a run that happens to be bold, italic or a different size.
    const cells = [];
    for (const l of lines)
      for (const p of l.parts)
        if (p.text.length > 1 && p.right > p.left)
          cells.push((p.right - p.left) / p.text.length);
    cells.sort((a, b) => a - b);
    const charW = cells.length ? cells[Math.floor(cells.length / 2)] : 0;
    const inCells = (px) => (charW > 0 ? Math.round(px / charW) : 0);

    // A line-number gutter is a first run of nothing but digits, with a real
    // gap after it. Three independent facts have to agree before we delete
    // anything: most lines look like that, the numbers ascend, and they share
    // one column. Real code does not accidentally satisfy all three.
    const looksNumbered = (l) => l.parts.length > 1
      && /^\d{1,5}$/.test(l.parts[0].text.trim())
      && (l.parts[1].left - l.parts[0].right) > Math.max(2, charW * 0.5);
    const marked = lines.filter(looksNumbered);
    let gutter = marked.length >= Math.max(3, lines.length * 0.6);
    if (gutter) {
      let rising = 0;
      for (let i = 1; i < marked.length; i++)
        if (+marked[i].parts[0].text > +marked[i - 1].parts[0].text) rising++;
      const edges = marked.map((l) => l.parts[0].right).sort((a, b) => a - b);
      const mid = edges[Math.floor(edges.length / 2)];
      const aligned = edges.filter((x) => Math.abs(x - mid) <= 3).length;
      gutter = rising >= (marked.length - 1) * 0.8
               && aligned >= marked.length * 0.8;
    }
    // Strip the number from EVERY line, not just the ones that qualified. A
    // line whose code never rendered keeps only its gutter run, and leaving
    // that in drags originX to the gutter column - which silently indents the
    // entire block by the width of the gutter. Seen live: 5 extra spaces on
    // all 29 lines of a capture, because one line said "28" and nothing else.
    if (gutter) {
      for (const l of lines) {
        if (l.parts.length && /^\d{1,5}$/.test(l.parts[0].text.trim())) l.parts.shift();
      }
    }

    // Indentation is the distance from the leftmost line, in character cells.
    // When the highlighter keeps indentation inside a text node this comes out
    // zero and the spaces arrive with the text; when it strips it to a
    // whitespace-only node the geometry puts it back. Either way it survives.
    let originX = Infinity;
    for (const l of lines) if (l.parts.length) originX = Math.min(originX, l.parts[0].left);

    // In CODE a gap is N columns and every one of them matters. In PROSE the
    // font is proportional, so "how many character cells wide is this gap" has
    // no answer - and the only thing a gap means there is "these are separate
    // words". Measure the same way, spend it differently.
    const out = lines.map((l) => {
      if (!l.parts.length) return '';
      let s = prose ? '' : ' '.repeat(Math.max(0, inCells(l.parts[0].left - originX)));
      for (let i = 0; i < l.parts.length; i++) {
        if (i > 0) {
          const px = l.parts[i].left - l.parts[i - 1].right;
          const gap = prose ? (px > 1 ? 1 : 0) : inCells(px);
          if (gap > 0) s += ' '.repeat(gap);
        }
        s += l.parts[i].text;
      }
      return s.replace(/[ \t]+$/, '');
    });
    return { text: out.join('\n'), runs: rows.length, gutter };
  }

  // A gutter renders as a narrow column of bare integers to the LEFT of the
  // code. Once rows are rebuilt it shows up as a numeric prefix on every line,
  // which is removable with certainty rather than guesswork.
  function stripGutter(text) {
    const lines = text.split('\n');
    const numbered = lines.filter((l) => /^\s*\d{1,5}\s/.test(l)).length;
    if (numbered < Math.max(3, lines.length * 0.6)) return text;
    return lines.map((l) => l.replace(/^\s*\d{1,5}\s/, '')).join('\n');
  }

  // Qwen renders a long code block only as far as the screen needs, so a read
  // stops where the layout does - the refusal log showed 29 lines of a document
  // that plainly had more, with line 28's gutter number present but its code
  // absent. Nothing in the DOM order can recover what has no box, so give it a
  // box: expand the block's own control if it has one, lift height clamps and
  // CSS containment on it and its ancestors, read, then put everything back.
  // If the text was in the DOM all along this recovers it; if the site really
  // did drop the nodes, the counts we return say so instead of guessing.
  const UNCLAMP = ['maxHeight', 'height', 'overflow', 'overflowY', 'contentVisibility',
                   'containIntrinsicSize', 'contain', 'display'];
  const EXPANDERS = /^(expand|show more|show all|more|unfold|展开|더 보기)$/i;

  function withFullLayout(el, read) {
    const undo = [];
    const clicked = [];
    try {
      // A control the site provides is always better than fighting its CSS.
      for (const b of el.querySelectorAll('button, [role="button"], a')) {
        const t = (b.textContent || '').trim();
        if (t && EXPANDERS.test(t)) { clicked.push(t); try { b.click(); } catch (_) {} }
      }
      let node = el;
      for (let up = 0; node && node !== document.body && up < 6; up++) {
        undo.push([node, node.style.cssText]);
        for (const prop of UNCLAMP) {
          if (prop === 'overflow' || prop === 'overflowY') node.style.setProperty(prop, 'visible', 'important');
          else if (prop === 'contentVisibility') node.style.setProperty('content-visibility', 'visible', 'important');
          else if (prop === 'containIntrinsicSize') node.style.setProperty('contain-intrinsic-size', 'auto', 'important');
          else if (prop === 'contain') node.style.setProperty('contain', 'none', 'important');
          else if (prop === 'display') { /* never force display - it breaks layout */ }
          else node.style.setProperty(prop, 'none', 'important');
        }
        node = node.parentElement;
      }
      void el.getBoundingClientRect();      // force one synchronous layout
      return read(clicked);
    } finally {
      for (const [n, css] of undo) n.style.cssText = css;
    }
  }

  // ---- Monaco: the block that is not text ---------------------------------
  // Qwen does not render a fenced block as markup. It mounts a whole Monaco
  // editor - the VS Code engine - per code block, and Monaco is a VIRTUAL
  // list by design: `.view-lines` holds only the lines the viewport can show,
  // `.lines-content` is an empty spacer sized to the whole document, and the
  // line divs are RECYCLED as you scroll. That one fact is behind every Qwen
  // symptom we had been treating as separate problems: the shuffled read
  // (recycled divs sit in no particular DOM order), the gutter counting
  // 27,28,29,24,25,26 (same cause), the NBSP whitespace (Monaco renders
  // spaces as NBSP), and the refusal that started this - 29 lines of a
  // 152-line document, "opens <html>, never closes it", refused correctly for
  // entirely the wrong reason. No amount of reading the screen recovers a
  // line that was never mounted. It does not exist.
  //
  // So stop reading the screen and ask the editor. Three routes, best first:
  //   1. the model      - monaco.editor, when the page left it on window.
  //                       Exact and instant, true whether or not a single
  //                       line of the document is on screen.
  //   2. mount+harvest  - give the viewport the height of the whole document
  //                       so Monaco mounts all of it, then pair each rendered
  //                       line with its gutter number.
  //   3. scroll+harvest - wheel through the block, merging what mounts.
  // Routes 2 and 3 join text to line number by the `top` Monaco puts on both,
  // which is an exact key rather than a guess - and because every line
  // arrives numbered, "complete" becomes a count we can prove, not a hope.

  const PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
  const rAF = () => new Promise((r) => requestAnimationFrame(() => r()));
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));

  // The editor element for a decorated block, whichever side of it we hold:
  // the site's <pre>, the editor itself, or something in between.
  function monacoRoot(el) {
    if (!el || !el.querySelector) return null;
    if (el.classList && el.classList.contains('monaco-editor')) return el;
    return el.querySelector('.monaco-editor')
        || (el.closest && el.closest('.monaco-editor'))
        || (el.querySelector('.view-lines') ? el : null);
  }

  // Route 1. The model holds the document; the DOM holds a viewport onto it.
  // Only reachable if the page's bundler left `monaco` on window - which is
  // the whole reason the harvest below has to exist.
  function monacoModelText(root) {
    const m = PAGE && PAGE.monaco;
    if (!root || !m || !m.editor) return null;
    try {
      for (const ed of (m.editor.getEditors && m.editor.getEditors()) || []) {
        const node = ed.getDomNode && ed.getDomNode();
        if (!node) continue;
        if (node === root || node.contains(root) || root.contains(node)) {
          const model = ed.getModel && ed.getModel();
          const v = model && model.getValue && model.getValue();
          if (v && v.trim()) return v;
        }
      }
      // One editor on the page and one model in the registry is not
      // ambiguous, and covers a Monaco too old to have getEditors().
      const models = (m.editor.getModels && m.editor.getModels()) || [];
      if (models.length === 1
          && document.querySelectorAll('.monaco-editor').length === 1) {
        const v = models[0].getValue && models[0].getValue();
        if (v && v.trim()) return v;
      }
    } catch (_) { /* a Monaco build we do not know; harvest instead */ }
    return null;
  }

  // Monaco absolutely positions every rendered line and gives the matching
  // gutter row the SAME top. That makes `top` an exact join between a line's
  // text and its number - no column detection, no ascending-run heuristic,
  // and no chance of mistaking somebody's constant for a line number.
  // Returns how many NEW lines it learned, so a scroll that achieved nothing
  // is visible to the caller instead of spinning.
  function monacoRows(root, into) {
    const view = root.querySelector('.view-lines');
    if (!view) return 0;
    const topOf = (n) => {
      const v = n && n.style && n.style.top ? parseFloat(n.style.top) : NaN;
      return Number.isFinite(v) ? Math.round(v) : null;
    };
    const numAt = new Map();
    for (const g of root.querySelectorAll('.margin-view-overlays > div')) {
      const t = topOf(g);
      const n = parseInt((g.textContent || '').trim(), 10);
      if (t !== null && Number.isFinite(n)) numAt.set(t, n);
    }
    let added = 0;
    for (const line of view.querySelectorAll('.view-line')) {
      const t = topOf(line);
      if (t === null) continue;
      const no = numAt.get(t);
      if (!Number.isFinite(no) || into.has(no)) continue;
      // Within one line the spans ARE in reading order - it is only the lines
      // that are recycled out of order. NBSP is Monaco's rendered space.
      into.set(no, (line.textContent || '').replace(/\u00a0/g, ' ')
                                           .replace(/[ \t]+$/, ''));
      added++;
    }
    return added;
  }

  // `.lines-content` is Monaco's spacer: it is sized to the WHOLE document
  // even while four lines are mounted, so it is the one honest statement in
  // the DOM of how long the document actually is.
  // The browser's maximum element height, and the largest document we will
  // believe in. Both are here because of what a real Qwen census measured on
  // 2026-09-12: .lines-content came back 16777200px tall - that is 2^24 - 16,
  // the engine's ceiling for an element, not a length Monaco chose. At a 20px
  // line that is 838,860 imaginary lines, and every completeness test built on
  // it is then unsatisfiable: the harvest brought back the ENTIRE document,
  // lines 1-243 ending in </html>, and was refused for missing 244-838860.
  // So the spacer is a HINT. The gutter is the ground truth, because Monaco
  // numbers every line it actually has.
  const MAX_ELEMENT_PX = 16000000;
  const MAX_PLAUSIBLE_LINES = 50000;

  // total: 0 means "unknown, ask the gutter" - monacoAssemble already falls
  // back to the highest line number it saw, and the harvest loop already runs
  // until scrolling stops teaching it anything. An honest zero drives both.
  function monacoShape(root) {
    const spacer = root.querySelector('.lines-content');
    const line = root.querySelector('.view-line');
    const lineH = line ? line.getBoundingClientRect().height : 0;
    const h = spacer ? parseFloat(spacer.style.height || '0') : 0;
    const n = (h > 0 && lineH > 0) ? Math.round(h / lineH) : 0;
    const trusted = n > 0 && h < MAX_ELEMENT_PX && n <= MAX_PLAUSIBLE_LINES;
    return { total: trusted ? n : 0, lineH: lineH || 19,
             spacerH: h, spacerLines: n, trusted };
  }

  // Monaco's own numbers, read and never touched. One census answers the three
  // questions the whole Monaco path rests on, instead of us guessing at them:
  // is route 1 available (did the page leave `monaco` on window), how many
  // lines does the spacer arithmetic believe the document has, and does the
  // GUTTER agree. The last one is not academic - Monaco's scrollBeyondLastLine
  // pads the scroll height past the final line, and a padded spacer would make
  // a COMPLETE capture look short by a viewport, refused forever for trailing
  // holes that were never there.
  function monacoReport() {
    const eds = document.querySelectorAll('.monaco-editor');
    const api = (PAGE && PAGE.monaco && PAGE.monaco.editor) || null;
    const count = (fn) => { try { return fn ? fn().length : null; } catch (_) { return null; } };
    return {
      editors_in_dom: eds.length,
      window_monaco: !!(PAGE && PAGE.monaco),
      api_editors: count(api && api.getEditors && api.getEditors.bind(api)),
      api_models: count(api && api.getModels && api.getModels.bind(api)),
      blocks: Array.from(eds).slice(0, 8).map((root) => {
        const shape = monacoShape(root);
        const spacer = root.querySelector('.lines-content');
        const nums = [];
        for (const g of root.querySelectorAll('.margin-view-overlays > div')) {
          const n = parseInt((g.textContent || '').trim(), 10);
          if (Number.isFinite(n)) nums.push(n);
        }
        const exact = monacoModelText(root);
        return {
          mounted: root.querySelectorAll('.view-line').length,
          line_h: shape.lineH,
          spacer_h: spacer ? Math.round(parseFloat(spacer.style.height || '0')) : null,
          computed_total: shape.total,
          spacer_lines: shape.spacerLines,
          spacer_trusted: shape.trusted,
          gutter_min: nums.length ? Math.min.apply(null, nums) : null,
          gutter_max: nums.length ? Math.max.apply(null, nums) : null,
          model_lines: exact ? exact.split('\n').length : null,
        };
      }),
    };
  }

  // Route 2. Monaco mounts what its viewport can show, so give it a viewport
  // the size of the document. Two things the older CSS unclamp got wrong and
  // this does not: it set `height: none`, which is not a value, so the clamp
  // never lifted at all; and it read back in the same tick, long before
  // Monaco's ResizeObserver had fired and re-rendered. Returns the undo list.
  async function monacoGrow(root, px) {
    const undo = [];
    const grow = (n) => {
      if (!n) return;
      undo.push([n, n.style.cssText]);
      n.style.setProperty('max-height', 'none', 'important');
      n.style.setProperty('height', px + 'px', 'important');
    };
    grow(root);
    grow(root.querySelector('.overflow-guard'));
    grow(root.querySelector('.monaco-scrollable-element'));
    // Ancestors only get their clamp lifted - forcing a height onto the
    // chat's own layout is how you break the page you are reading.
    let up = root.parentElement;
    for (let i = 0; up && up !== document.body && i < 5; i++, up = up.parentElement) {
      undo.push([up, up.style.cssText]);
      up.style.setProperty('max-height', 'none', 'important');
      up.style.setProperty('overflow', 'visible', 'important');
    }
    try { PAGE.dispatchEvent(new Event('resize')); } catch (_) {}
    await rAF(); await rAF(); await nap(140);
    return undo;
  }

  // Route 3. If the editor will not grow - automaticLayout off, or a height
  // the site pins from script - walk the viewport instead. Monaco owns the
  // wheel on its scrollable element, so a synthetic wheel scrolls the BLOCK.
  // The listener on the parent keeps that wheel from bubbling on into the
  // chat's own scroller, which would otherwise walk the whole conversation.
  async function monacoWheel(root, dy) {
    const scroller = root.querySelector('.monaco-scrollable-element') || root;
    const parent = scroller.parentElement;
    const stop = (e) => e.stopPropagation();
    if (parent) parent.addEventListener('wheel', stop, false);
    try {
      scroller.dispatchEvent(new WheelEvent('wheel', {
        deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true, composed: true,
      }));
      await rAF(); await nap(70);
    } catch (_) {
      /* a browser without WheelEvent is a browser without Monaco */
    } finally {
      if (parent) parent.removeEventListener('wheel', stop, false);
    }
  }

  // Put the harvested lines back in order, and be explicit about holes rather
  // than handing back a document that quietly has some.
  function monacoAssemble(rows, total) {
    const keys = Array.from(rows.keys());
    const n = total || (keys.length ? Math.max.apply(null, keys) : 0);
    const gaps = [];
    let run = null;
    for (let i = 1; i <= n; i++) {
      if (rows.has(i)) { if (run) { gaps.push(run); run = null; } continue; }
      if (run) run[1] = i; else run = [i, i];
    }
    if (run) gaps.push(run);
    const out = [];
    for (let i = 1; i <= n; i++) out.push(rows.has(i) ? rows.get(i) : '');
    return { text: out.join('\n'), have: rows.size, total: n,
             gaps: gaps.map((g) => (g[0] === g[1] ? String(g[0]) : g[0] + '-' + g[1])) };
  }

  // A very long document is not worth a 40,000px element - past this we stop
  // growing and let the wheel do the rest.
  const GROW_CAP = 24000;

  // The whole Monaco path. Returns null for a block that is not a Monaco
  // editor, so every other site keeps exactly the reader it already had.
  async function deepCapture(el, btn) {
    const root = monacoRoot(el);
    if (!root) return null;

    const exact = monacoModelText(root);
    if (exact) {
      return { text: exact, via: 'monaco-model', have: null, total: null, gaps: [] };
    }

    if (btn) btn.textContent = '… mounting';
    const rows = new Map();
    monacoRows(root, rows);
    const shape = monacoShape(root);
    const total = shape.total;

    // With a trusted total we grow to exactly what the document needs. Without
    // one, guessing small just means more wheeling - so take the cap.
    const want = shape.trusted
      ? Math.min(GROW_CAP, Math.max(600, total * shape.lineH + 80))
      : GROW_CAP;
    const undo = await monacoGrow(root, want);
    try {
      monacoRows(root, rows);
      // Whatever growing did not mount, scroll to. Stop as soon as a step
      // stops teaching us anything: a block that will not move further is
      // done, and spinning on it only delays an honest answer.
      const step = Math.max(200, shape.lineH * 20);
      let idle = 0;
      for (let i = 0; i < 80 && (!total || rows.size < total); i++) {
        await monacoWheel(root, step);
        idle = monacoRows(root, rows) ? 0 : idle + 1;
        if (idle >= 3) break;
      }
      for (let i = 0; i < 6; i++) await monacoWheel(root, -step * 8);  // put it back
    } finally {
      for (const u of undo) u[0].style.cssText = u[1];
    }

    const built = monacoAssemble(rows, total);
    built.via = 'monaco-harvest';
    return built;
  }

  // What the last code read actually managed to see. Sent with a refusal so
  // "it is cut off" comes with the numbers behind it.
  let lastRead = null;

  function textOf(el, kind) {
    // For a code block, read the <code> child live - innerText keeps the line
    // breaks that textContent-on-a-detached-clone would preserve but that
    // innerText-on-a-clone would lose (a clone has no layout).
    if (kind !== 'message') {
      // A Monaco block has no text to read - it has a model. Where the page
      // left that reachable it IS the answer, and every reader below this
      // line is a workaround for not having it.
      const exact = monacoModelText(monacoRoot(el));
      if (exact) {
        lastRead = { via: 'monaco-model', inDom: exact.length,
                     rendered: exact.length, took: exact.length };
        return exact;
      }
      const code = el.querySelector('code') || el;
      // Hide OUR OWN furniture before reading. On some layouts the button we
      // inject is a child of the very element we are about to read, so
      // innerText picks it up and "\u2192 Claude" lands in the captured file - it
      // did exactly that on Kimi, into line 5 of a game that then deployed.
      // Deliberately NOT SITE.exclude: that names things to drop from a
      // MESSAGE read, and on Qwen it is `.monaco-editor` - applying it here
      // would delete the code instead of the chrome.
      const mine = Array.from(
        code.querySelectorAll('.sniper-btn, .sniper-hub, .sniper-menu'));
      const wasShown = mine.map((n) => n.style.display);
      mine.forEach((n) => { n.style.display = 'none'; });
      let whole, naive;
      try {
        // textContent ignores rendering entirely, so it is the only honest
        // measure of how much text is actually IN this block.
        whole = (code.textContent || '').replace(/\u00a0/g, ' ');
        naive = (code.innerText || whole).replace(/\u00a0/g, ' ');
      } finally {
        mine.forEach((n, i) => { n.style.display = wasShown[i]; });
      }
      if (!SITE.visualOrder) {
        lastRead = { inDom: whole.length, rendered: naive.length, took: naive.length };
        return naive;
      }
      // On a site that reorders, trust the screen over the DOM - but only if
      // rebuilding actually produced something, never silently worse.
      const out = withFullLayout(code, (clicked) => {
        const visual = textByVisualOrder(code);
        const built = stripCodeHeader(stripGutter(visual.text));
        return { built, clicked, runs: visual.runs, gutter: visual.gutter };
      });
      const built = out.built;
      const dense = (t) => t.replace(/\s+/g, '').length;
      lastRead = { inDom: dense(whole), rendered: dense(naive), took: dense(built),
                   runs: out.runs, gutter: out.gutter, expanded: out.clicked };
      return (built && built.length >= naive.length * 0.4) ? built : naive;
    }
    // For a whole message we want innerText's paragraph breaks, so read it in
    // place - hiding our own furniture first, since innerText honours
    // display:none. Hide the site's too, when sites.json names it.
    const hidden = Array.from(el.querySelectorAll('.sniper-btn, .sniper-hub, .sniper-menu'));
    for (const sel of (SITE.exclude || [])) {
      try { el.querySelectorAll(sel).forEach((n) => hidden.push(n)); } catch (_) {}
    }
    const prev = hidden.map((n) => n.style.display);
    hidden.forEach((n) => { n.style.display = 'none'; });
    let t = (el.innerText || el.textContent || '').replace(/\u00a0/g, ' ');
    hidden.forEach((n, i) => { n.style.display = prev[i]; });

    // Only messages get the chrome stripped. A code block is taken verbatim -
    // a bare number in there is somebody's constant, not a gutter.
    if (kind === 'message' && SITE.visualOrder) {
      const v = textByVisualOrder(el, true).text;
      if (v && v.length >= t.length * 0.5) t = v;
    }
    return kind === 'message' ? stripChrome(t) : t;
  }

  // Words that sit in a code-block header but are NOT the language.
  const NOT_A_LANG = new Set(['copy', 'copied', 'run', 'edit', 'download', 'share',
    'preview', 'expand', 'collapse', 'wrap', 'raw', 'close', 'open']);

  // Longest first, so "javascript" wins over "java" and "typescript" over "ts".
  const KNOWN_LANGS = ['javascript', 'typescript', 'powershell', 'plaintext',
    'markdown', 'mcfunction', 'python', 'bash', 'shell', 'json', 'yaml', 'html',
    'css', 'scss', 'glsl', 'jsx', 'tsx', 'sql', 'xml', 'toml', 'diff', 'text',
    'java', 'rust', 'lua', 'cpp', 'ini', 'yml', 'js', 'ts', 'py', 'sh', 'go',
    'c', 'md'].sort((a, b) => b.length - a.length);

  // Some sites put the code block's HEADER inside the same container as the
  // code - a language label, a Copy button, a Download button. A geometric
  // read sees them as the first line. Drop a leading line only when the whole
  // line IS one of those words: a real first line of code never is.
  function stripCodeHeader(text) {
    const lines = text.split('\n');
    const junk = new Set([].concat(KNOWN_LANGS, Array.from(NOT_A_LANG),
                                   SITE.chrome || []));
    while (lines.length > 1) {
      const first = lines[0].trim().toLowerCase();
      if (first && !junk.has(first)) break;
      lines.shift();
    }
    return lines.join('\n');
  }

  // DeepSeek carries no `language-xxx` class - it renders the language as a
  // small banner above the <code>. Without this the lang field is always null,
  // and a `text` block is indistinguishable from a `javascript` one, which is
  // precisely what leaves the placer guessing at the file type.
  function langOf(el) {
    const probe = el.querySelector('code') || el;
    const m = (String(probe.className || '') + ' ' + String(el.className || ''))
      .match(/language-([\w+#.-]+)/i);
    if (m) return m[1].toLowerCase();

    for (const node of [el, probe]) {
      const d = node.getAttribute && (node.getAttribute('data-language')
             || node.getAttribute('data-lang'));
      if (d) return String(d).trim().toLowerCase();
    }

    // The banner is often one element whose textContent is the label glued to
    // its buttons - "textcopydownload". Matching a known language by PREFIX
    // recovers "text" from that; scraping the raw string does not.
    const host = (el.closest && el.closest('[class*="code-block"], [class*="md-code"]'))
              || el.parentElement || el;
    for (const n of host.querySelectorAll('div,span,button')) {
      if (n.querySelector('code') || n.tagName === 'CODE') continue;
      // Monaco puts every token in its own span, so a line holding nothing
      // but `c` or `html` looks exactly like a language banner - which is how
      // a Qwen census came back claiming a three.js page was written in C.
      // The banner is never inside the editor, so nothing in it is a banner.
      if (n.closest && n.closest('.monaco-editor, .view-lines')) continue;
      const t = (n.textContent || '').trim().toLowerCase();
      if (!t || t.length > 40) continue;
      if (NOT_A_LANG.has(t)) continue;
      const hit = KNOWN_LANGS.find((L) => t === L || t.startsWith(L));
      if (hit) return hit;
    }
    return null;
  }

  // DeepSeek re-renders a code block as it streams and as the highlighter
  // passes over it. Reading innerText mid-stream splices the old render onto a
  // partial new one - that is exactly how we got fragments like
  // "const muzzleLight = new THREE.Point" with no closing paren. So: read,
  // wait, read again, and only send once the text has stopped moving.
  // A mid-render read leaves a signature in the TEXT, not in its stability:
  // a line repeated verbatim (same indentation), or a line followed by a
  // truncated copy of itself. Stale nodes sit in the DOM indefinitely, so two
  // identical reads prove nothing - v0.6's settle check waved these straight
  // through. Compare RAW lines: trimming would flag legitimate nested `}`.
  function corruptionIn(text) {
    const ls = text.split('\n');
    for (let i = 0; i < ls.length - 1; i++) {
      const a = ls[i], b = ls[i + 1];
      if (!a.trim()) continue;
      if (a === b && a.trim().length > 1)
        return `line ${i + 2} repeats line ${i + 1} verbatim`;
      if (b.length > 12 && b.length < a.length && a.startsWith(b))
        return `line ${i + 2} is a truncated copy of line ${i + 1}`;
    }
    // A lone truncated line has no duplicate to give it away, but it leaves
    // delimiters hanging open. Positive imbalance only - a fragment that closes
    // more than it opens is normal. Braces excluded: too lopsided in fragments.
    for (const [name, op, cl] of [['parenthesis', '(', ')'], ['bracket', '[', ']']]) {
      const d = (text.split(op).length - 1) - (text.split(cl).length - 1);
      if (d > 0) return `${d} unclosed ${name}(es) — looks cut off`;
    }

    // A block that OPENS an html document but never closes it is cut off,
    // not corrupt in the repeated-line sense - a virtualised code block
    // only mounts what is on screen, and the read stops where the DOM does.
    // Only fires when the text starts a document, so a fragment is exempt.
    const head = text.slice(0, 400).toLowerCase();
    if (/^\s*(<!doctype\s+html|<html[\s>])/.test(head) &&
        !text.slice(-4000).toLowerCase().includes('</html>'))
      return 'the block opens an html document but never closes </html> - it is cut off';

    return null;
  }

  // Undo a bad render. The artifact is always "complete line, then a copy of
  // it that is identical or cut short" - so a line that is a prefix of the one
  // kept before it is debris, not content. Conservative: only drops a line
  // when the previous kept line fully contains it, and the caller re-verifies
  // the result before trusting it.
  function repairMidRender(text) {
    const ls = text.split('\n');
    const out = [], removed = [];
    for (const cur of ls) {
      const prev = out.length ? out[out.length - 1] : null;
      if (prev !== null && cur.trim() && prev.trim()
          && (cur === prev || (cur.length < prev.length && prev.startsWith(cur)))) {
        removed.push(cur.trim().slice(0, 60));
        continue;
      }
      out.push(cur);
    }
    return { text: out.join('\n'), removed };
  }

  function reportRefusal(text, reason, afterRepair) {
    try {
      GM_xmlhttpRequest({
        method: 'POST', url: BASE + '/refused',
        headers: { 'Content-Type': 'application/json', 'X-Sniper-Key': KEY },
        data: JSON.stringify({
          text, reason, after_repair: afterRepair,
          url: location.href, lang: null,
          // "it is cut off" is a claim. These are the numbers behind it:
          // how much text is in the DOM, how much of that the page rendered,
          // and how much the read took. If inDom is much larger than took,
          // the content was there and the read is at fault, not the site.
          seen: lastRead,
        }),
        timeout: 8000,
        onload() {}, onerror() {}, ontimeout() {},
      });
    } catch (_) { /* never let logging break the refusal path */ }
  }

  // Stable AND structurally sane. If it still looks mid-render when the clock
  // runs out we try to rebuild it; failing that we refuse - alt+click forces.
  function captureStable(read, btn, done, force, checkCode) {
    const SETTLE = 400, NEEDED = 3, GIVE_UP = 15000;
    const t0 = Date.now();
    let prev = read(), agree = 0, warned = false;
    const guard = checkCode !== false;   // settle always; structure only for code

    const tick = () => {
      const now = read();
      agree = (now === prev) ? agree + 1 : 0;
      prev = now;

      const bad = guard ? corruptionIn(now) : null;
      if (agree >= NEEDED && !bad) {
        if (warned && btn) btn.textContent = btn.dataset.label || '→ Claude';
        return done(now, { repaired: false });
      }
      if (Date.now() - t0 > GIVE_UP) {
        if (!bad) return done(now, { repaired: false });

        // The text settled but stayed broken - DeepSeek's own DOM is wrong, so
        // waiting longer achieves nothing. The damage is mechanical though:
        // the complete line always comes first, the mangled copy follows it.
        // Rebuild, then only accept the result if it verifies clean.
        const rep = repairMidRender(now);
        if (rep.removed.length && !corruptionIn(rep.text)) {
          if (btn) { btn.dataset.state = ''; btn.textContent = btn.dataset.label || '→ Claude'; }
          toast(`<b>repaired</b> ${esc(rep.removed.length)} mangled line(s) from a `
              + `bad render — sending. Check it in the console.`, 5200);
          return done(rep.text, { repaired: true, removed: rep.removed });
        }
        if (force) return done(now, { repaired: false, forced: true });

        // Keep the evidence. A refusal you cannot inspect afterwards is just a
        // shrug, and this is the one path where we throw text away.
        const after = rep.removed.length ? corruptionIn(rep.text) : bad;
        reportRefusal(now, bad, after);

        if (btn) { btn.dataset.state = 'fail'; btn.textContent = '✕ partial'; }
        toast(`<b>not sent — looks mid-render</b>\n${esc(bad)}.\n`
            + (rep.removed.length
                ? `Removing ${esc(rep.removed.length)} duplicate line(s) still `
                  + `leaves: ${esc(after)}.\n`
                : `Nothing looked like removable debris.\n`)
            + `Saved to refused\\ so you can look at it. `
            + `Ask for a \`\`\`javascript fence instead of \`\`\`text, or `
            + `alt+click to force.`, 9000);
        return done(null, { repaired: false });
      }
      if (!warned) {
        warned = true;
        if (btn) btn.textContent = '… settling';
      }
      setTimeout(tick, SETTLE);
    };
    setTimeout(tick, SETTLE);
  }

  // Promise wrappers, so one block and many blocks share the same path.
  function stableText(read, btn, force, checkCode) {
    return new Promise((resolve) =>
      captureStable(read, btn, (text, info) => resolve({ text, info: info || {} }),
                    force, checkCode));
  }

  // Code capture, in the order that actually recovers the text: ask the
  // editor first, and read the screen only when there is no editor to ask.
  // `stableText` stays exactly as it was - the settle loop and the structural
  // guard still own every site that renders a code block as text.
  async function captureCode(el, kind, btn, force) {
    let deep = null;
    try { deep = await deepCapture(el, btn); } catch (_) { deep = null; }

    if (deep && deep.text && deep.text.trim()) {
      const whole = !deep.total || deep.have === null || deep.have >= deep.total;
      const bad = needsCodeCheck(kind) ? corruptionIn(deep.text) : null;
      if (whole && !bad) {
        if (btn) btn.textContent = btn.dataset.label || '→ Claude';
        lastRead = { via: deep.via, have: deep.have, total: deep.total };
        // Which route recovered the text is the first thing worth knowing when
        // a capture misbehaves, and the only place it is cheap to say so.
        console.log('[sniper] captured via ' + deep.via
          + (deep.total ? ' (' + deep.have + '/' + deep.total + ' lines)' : ''));
        return { text: deep.text,
                 info: { via: deep.via, have: deep.have, total: deep.total } };
      }
      if (force) {
        return { text: deep.text, info: { via: deep.via, forced: true,
                                          have: deep.have, total: deep.total } };
      }
      // Refuse - but for the reason that is true, with the numbers behind it.
      // "Ask for a ```javascript fence" was never going to help against a
      // virtualised editor, and sending the reader after a better fence was
      // the one piece of advice guaranteed to waste their time.
      const why = whole ? bad
        : `only ${deep.have} of ${deep.total} lines ever mounted`
          + (deep.gaps.length ? ` — missing ${deep.gaps.slice(0, 4).join(', ')}` : '');
      lastRead = { via: deep.via, have: deep.have, total: deep.total };
      reportRefusal(deep.text, why, null);
      if (btn) { btn.dataset.state = 'fail'; btn.textContent = '✕ partial'; }
      toast(`<b>not sent — ${esc(why)}</b>\n`
          + `This block is a Monaco editor - it only keeps the lines that are `
          + `on screen. Scroll the block itself to the bottom once, then send `
          + `again; or alt+click to force what we have.\n`
          + `Saved to refused\\ either way.`, 9000);
      return { text: null, info: {} };
    }

    if (monacoRoot(el)) console.log('[sniper] monaco block gave nothing; reading the screen');
    return await stableText(() => textOf(el, kind), btn, force, needsCodeCheck(kind));
  }

  function postDrop(text, meta) {
    return new Promise((resolve) => {
      if (!text || !text.trim()) return resolve({ ok: false, error: 'empty' });
      GM_xmlhttpRequest({
        method: 'POST', url: BASE + '/drop',
        headers: { 'Content-Type': 'application/json', 'X-Sniper-Key': KEY },
        data: JSON.stringify({ text, url: location.href, title: document.title,
                               site: location.hostname, ...meta }),
        timeout: 15000,
        onload(res) {
          let r = {};
          try { r = JSON.parse(res.responseText); } catch (_) {}
          resolve(res.status === 200 && r.ok
            ? r : { ok: false, error: r.error || ('http ' + res.status) });
        },
        onerror()   { resolve({ ok: false, error: 'relay unreachable' }); },
        ontimeout() { resolve({ ok: false, error: 'timed out' }); },
      });
    });
  }

  function markBtn(btn, r) {
    if (!btn) return;
    if (r.ok) {
      btn.dataset.state = 'ok';
      btn.textContent = r.duplicate ? '= already' : '✓ sent';
      setTimeout(() => { btn.dataset.state = '';
                         btn.textContent = btn.dataset.label || '→ Claude'; }, 1800);
    } else {
      btn.dataset.state = 'fail';
      btn.textContent = '✕';
    }
  }

  function send(text, meta, btn) {
    if (!text || !text.trim()) { toast('nothing to send'); return; }
    postDrop(text, meta).then((r) => {
      markBtn(btn, r);
      if (!r.ok) {
        toast(`<b>not sent</b> — ${esc(r.error)}`, 4200);
      } else if (r.routed === 'env') {
        // A whole page went straight to a live environment. Offer it rather
        // than opening a tab unasked - you may still be mid-conversation.
        setEnv(r.current || r.env);
        if (btn) { btn.dataset.state = 'ok'; btn.textContent = '⧉ live'; }
        toast(`<b>⧉ ${esc(r.env)} is live</b> — ${esc(r.lines)} lines, ${esc(r.state)}.\n`
            + `Click here to open it, or ⧉ → ${esc(r.env)}.`, 8000,
            () => {
              if (typeof GM_openInTab === 'function') GM_openInTab(r.url, { active: true });
              else window.open(r.url, '_blank');
            });
      } else if (r.routed === 'context') {
        if (btn) { btn.dataset.state = 'ok'; btn.textContent = '✓ context'; }
        toast(r.duplicate
          ? `<b>already filed</b> — identical explanation is already in context.`
          : `<b>✓ filed as context</b> — ${esc(r.lines)} lines.\n`
            + `NOT in pending: explanations are read for intent, never placed.\n`
            + `Click here to see it in the console.`,
          r.duplicate ? 3400 : 7000,
          r.duplicate ? null : () => {
            const u = BASE + '/console';
            if (typeof GM_openInTab === 'function') GM_openInTab(u, { active: true });
            else window.open(u, '_blank');
          });
      } else if (r.duplicate) {
        toast('<b>already staged</b> — identical text is waiting in the queue', 3000);
      } else {
        toast(r.target
          ? `<b>sniped</b> ${esc(r.lines)} lines → <b>${esc(r.target)}</b>  @${esc(r.mode)}`
          : `<b>sniped</b> ${esc(r.lines)} lines  <i>(review at ⧉ → console)</i>`);
      }
    });
  }

  // Every code block inside one message, in document order - which is the
  // order DeepSeek wrote them, and so the order they should be applied.
  function blocksIn(el) {
    for (const sel of (chosen ? [chosen] : CANDIDATES)) {
      let f = [];
      try { f = Array.from(el.querySelectorAll(sel)); } catch (_) { continue; }
      if (f.length) return f;
    }
    return [];
  }

  // No synthetic clicking: we hold the elements and the same posting authority,
  // so drive the send loop directly. Each block still gets its own settle check.
  async function sendAll(els, btn) {
    if (!els.length) { toast('no code blocks in this message'); return; }
    if (btn && btn.dataset.busy === '1') return;
    if (btn) btn.dataset.busy = '1';

    const n = els.length;
    let sent = 0, dup = 0, failed = 0, partial = 0, fixed = 0, firstErr = null;
    for (let i = 0; i < n; i++) {
      if (btn) btn.textContent = `${i + 1}/${n}…`;
      const el = els[i];
      const { text, info } = await captureCode(el, 'codeblock', null, false);
      if (text === null) {                    // refused: unrebuildable render
        partial++;
        markBtn(el.querySelector('.sniper-btn'), { ok: false });
        continue;
      }
      if (info.repaired) fixed++;
      const r = await postDrop(text, { kind: 'codeblock', lang: langOf(el), ...info });
      if (r.ok && r.duplicate) dup++;
      else if (r.ok) sent++;
      else { failed++; firstErr = firstErr || r.error; }
      markBtn(el.querySelector('.sniper-btn'), r);
    }

    if (btn) { btn.dataset.busy = ''; btn.textContent = btn.dataset.label || '→ all'; }
    toast(`<b>${sent} sniped</b>`
      + (fixed ? ` · <b>${fixed} repaired</b>` : '')
      + (dup ? ` · ${dup} already staged` : '')
      + (partial ? ` · <b>${partial} skipped (bad render)</b>` : '')
      + (failed ? ` · <b>${failed} failed</b> (${esc(firstErr)})` : '')
      + `\nreview at ⧉ → console`, 5500);
  }

  // ---- decoration ---------------------------------------------------------
  function decorate(el, kind) {
    if (!el || el.dataset.sniper === '1') return;
    if (!(el.innerText || '').trim()) return;
    el.dataset.sniper = '1';
    el.classList.add('sniper-host');

    // Code blocks only now - whole-message actions live in the hub menu.
    const btn = document.createElement('button');
    btn.className = 'sniper-btn';
    btn.type = 'button';
    btn.textContent = '→ Claude';
    btn.dataset.label = btn.textContent;
    btn.title = 'Send this code block to the sniper relay.\n'
              + 'First line may address it, e.g.  // >> src/thing.py @replace';
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const { text, info } = await captureCode(el, kind, btn, ev.altKey);
      if (text === null) return;
      send(text, { kind, lang: langOf(el), ...(info || {}) }, btn);
    });
    el.appendChild(btn);
    decorated++;
  }

  // Two absolutely-positioned buttons per message is a bet on the host's
  // layout, and we lose that bet on any site we have not measured. One hub
  // that opens its own menu cannot collide with itself, and it needs only a
  // corner - which is the one thing every chat leaves free.
  function decorateHub(el) {
    if (!el || el.dataset.sniperHub === '1') return;
    if (!(el.innerText || '').trim()) return;
    el.dataset.sniperHub = '1';
    el.classList.add('sniper-host');

    const hub = document.createElement('button');
    hub.className = 'sniper-hub';
    hub.type = 'button';
    hub.textContent = '⌖';
    hub.title = 'Sniper: send this message or its code blocks';

    const menu = document.createElement('div');
    menu.className = 'sniper-menu';
    menu.hidden = true;

    const item = (label, sub, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      const s = document.createElement('small');
      s.textContent = sub;
      b.appendChild(s);
      b.addEventListener('click', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        menu.hidden = true;
        fn(b);
      });
      menu.appendChild(b);
      return b;
    };

    item('→ all code blocks', 'every block here, in order', (b) => {
      const blocks = blocksIn(el);
      if (!blocks.length) { toast('no code blocks in this message'); return; }
      sendAll(blocks, hub);
    });
    item('→ this message', 'the explanation — filed as context', () => {
      captureStable(() => textOf(el, 'message'), hub,
        (text, info) => {
          if (text === null) return;
          send(text, { kind: 'message', lang: null, ...(info || {}) }, hub);
        },
        false, needsCodeCheck('message'));
    });

    hub.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const opening = menu.hidden;
      closeMenus();
      if (opening) {
        const n = blocksIn(el).length;
        menu.firstChild.querySelector('small').textContent =
          n ? `${n} block${n === 1 ? '' : 's'} here, in order` : 'no code blocks here';
        menu.hidden = false;
      }
    });

    el.appendChild(hub);
    el.appendChild(menu);
    decorated++;
  }

  function closeMenus() {
    document.querySelectorAll('.sniper-menu').forEach((m) => { m.hidden = true; });
  }
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest || !ev.target.closest('.sniper-menu, .sniper-hub'))
      closeMenus();
  }, true);

  function pickSelector() {
    for (const sel of (SITE.code.length ? SITE.code : CANDIDATES)) {
      let n = 0;
      try { n = findAll(sel).length; } catch (_) { continue; }
      if (n > 0) return sel;
    }
    return null;
  }

  function sweep() {
    if (!chosen) chosen = pickSelector();
    if (chosen) findAll(chosen).forEach((el) => decorate(el, 'codeblock'));

    // Messages are decorated regardless - a chat with no code in it still needs
    // to be snipeable. First selector that matches anything wins.
    for (const sel of (SITE.messages.length ? SITE.messages : MESSAGES)) {
      let found = [];
      try { found = findAll(sel); } catch (_) { continue; }
      if (found.length) { found.forEach(decorateHub); break; }
    }
  }

  let pending = null;
  new MutationObserver(() => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; sweep(); }, 220);
  }).observe(document.documentElement, { childList: true, subtree: true });
  sweep();

  // Alt+S = send selection.  Alt+D = force a census.
  window.addEventListener('keydown', (ev) => {
    if (!ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const k = (ev.key || '').toLowerCase();
    if (k === 's') {
      const sel = String(window.getSelection() || '');
      if (!sel.trim()) { toast('no selection'); return; }
      ev.preventDefault();
      send(sel, { kind: 'selection', lang: null }, null);
    } else if (k === 'd') {
      ev.preventDefault();
      census('hotkey');
    } else if (k === 'e') {
      ev.preventDefault();
      envMenu();
    } else if (k === 'c') {
      ev.preventDefault();
      sendCodebase(ENV);
    } else if (k === 'r') {
      ev.preventDefault();
      sendRules();
    } else if (k === 'w') {
      ev.preventDefault();
      sendCodebase(ENV, 'rejections');
    } else if (k === 'a') {
      // Alt+A - every block in the LAST message, for when you don't want to
      // scroll back up to find its button.
      ev.preventDefault();
      const msgs = Array.from(document.querySelectorAll('.sniper-host'))
        .filter((n) => n.querySelector('.sniper-hub'));
      const last = msgs[msgs.length - 1];
      if (!last) { toast('no message found'); return; }
      sendAll(blocksIn(last), last.querySelector('.sniper-hub'));
    }
  }, true);

  // Pull the routing table so the page agrees with config.json about which
  // captures are code. Failure is harmless - the defaults above match.
  GM_xmlhttpRequest({
    method: 'GET', url: BASE + '/routing',
    headers: { 'X-Sniper-Key': KEY }, timeout: 8000,
    onload(res) {
      try {
        const r = JSON.parse(res.responseText);
        if (r && r.ok && r.routing) {
          ROUTING = r.routing;
          console.log('[sniper] routing', ROUTING);
        }
      } catch (_) {}
    },
    onerror() {}, ontimeout() {},
  });

  // ---- chat <-> environment binding ---------------------------------------
  // One conversation builds one project. Telling the relay which chat is in
  // front of you keeps "+ new", "load environment" and "where edits go" as a
  // single idea instead of three that drift apart.
  //
  // These are SPAs: the URL changes without a page load, so a one-shot report
  // at startup would bind the first conversation forever.
  let lastChatUrl = '';

  function reportChat(force) {
    const here = location.href;
    if (!force && here === lastChatUrl) return;
    lastChatUrl = here;
    GM_xmlhttpRequest({
      method: 'POST', url: BASE + '/bind',
      headers: { 'Content-Type': 'application/json', 'X-Sniper-Key': KEY },
      data: JSON.stringify({ url: here, site: location.hostname }),
      timeout: 8000,
      onload(res) {
        let r = {};
        try { r = JSON.parse(res.responseText); } catch (_) {}
        if (!r.ok) return;
        if (r.current) setEnv(r.current);
        if (r.switched) {
          toast(`<b>⧉ ${esc(r.current)}</b> — this chat's environment`, 2600);
          console.log('[sniper] chat switched environment to', r.current);
        }
      },
      onerror() {}, ontimeout() {},
    });
  }

  // Catch every way an SPA can change conversation.
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    history[m] = function () {
      const out = orig.apply(this, arguments);
      setTimeout(() => reportChat(false), 120);
      return out;
    };
  }
  window.addEventListener('popstate', () => setTimeout(() => reportChat(false), 120));
  window.addEventListener('focus', () => reportChat(true));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) reportChat(true);
  });
  // Belt and braces: some routers mutate the URL without any of the above.
  setInterval(() => reportChat(false), 3000);

  // Which environment the relay is pointed at. Fetched, never assumed.
  GM_xmlhttpRequest({
    method: 'GET', url: BASE + '/env',
    headers: { 'X-Sniper-Key': KEY }, timeout: 8000,
    onload(res) {
      try {
        const r = JSON.parse(res.responseText);
        if (r && r.ok && r.current) {
          setEnv(r.current);
          console.log('[sniper] environment:', ENV);
        }
        // Then let the conversation have the final say on which one it is.
        reportChat(true);
      } catch (_) {}
    },
    onerror() {}, ontimeout() {},
  });

  // And the site adapters, so a new site is a sites.json edit + reload rather
  // than another re-install.
  applySites({});                       // built-ins until the fetch lands
  GM_xmlhttpRequest({
    // The version rides along so the relay - and therefore the console -
    // knows what is actually RUNNING in this tab, not what it serves.
    method: 'GET', url: BASE + '/sites?v=' + encodeURIComponent(VERSION),
    headers: { 'X-Sniper-Key': KEY }, timeout: 8000,
    onload(res) {
      try {
        const r = JSON.parse(res.responseText);
        if (r && r.ok && r.sites) {
          applySites(r.sites);
          chosen = null;                // re-pick with the new selectors
          sweep();
        }
      } catch (_) {}
    },
    onerror() {}, ontimeout() {},
  });

  // Auto-census once the SPA has settled, so a miss reports itself.
  setTimeout(() => {
    sweep();
    census('startup');
    offerRules();
    toast(decorated
      ? `<b>sniper ${VERSION}</b> armed — ${esc(decorated)} target(s)`
        + (chosen ? `, code via <b>${esc(chosen)}</b>` : ', messages only (no code in this chat)')
      : `<b>sniper ${VERSION}</b> — <b>nothing matched</b>\ncensus sent; Alt+D to re-run`, 5200);
  }, 3000);

  // ---- environments -------------------------------------------------------
  // The page sends a NAME only. Whether that name maps to a served directory or
  // a local command lives in envs.json on the machine - so a button on a web
  // page can never become arbitrary local execution.
  // Choosing an environment from the chat tab is a declaration, not a preview:
  // bind this conversation to it FIRST, so the next block lands there even if
  // the tab never gets opened. Then open it.
  function openEnv(name) {
    GM_xmlhttpRequest({
      method: 'POST', url: BASE + '/bind',
      headers: { 'Content-Type': 'application/json', 'X-Sniper-Key': KEY },
      data: JSON.stringify({ url: location.href, env: name }), timeout: 8000,
      onload(res) {
        let r = {};
        try { r = JSON.parse(res.responseText); } catch (_) {}
        if (r && r.current) setEnv(r.current);
      },
      onerror() {}, ontimeout() {},
    });
    return launchEnv(name);
  }

  function launchEnv(name) {
    GM_xmlhttpRequest({
      method: 'POST', url: BASE + '/launch',
      headers: { 'Content-Type': 'application/json', 'X-Sniper-Key': KEY },
      data: JSON.stringify({ env: name }), timeout: 8000,
      onload(res) {
        let r = {};
        try { r = JSON.parse(res.responseText); } catch (_) {}
        if (res.status === 200 && r.ok) {
          if (r.url) {
            if (typeof GM_openInTab === 'function') GM_openInTab(r.url, { active: true });
            else window.open(r.url, '_blank');
            toast(`<b>environment open</b> — ${esc(name)}`);
          } else {
            toast(`<b>launched</b> — ${esc(name)}`);
          }
        } else {
          toast(`<b>launch failed</b> ${esc(r.error || res.status)}`, 4600);
        }
      },
      onerror() { toast('<b>relay unreachable</b>\nis the relay running?', 4200); },
      ontimeout() { toast('<b>launch timed out</b>', 4000); },
    });
  }

  // A name the folder and the URL can both carry.
  function slugify(text) {
    return String(text || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
      .replace(/^[^a-z0-9]+/, '');
  }

  // The whole of "open the console, click + new, come back and hope the
  // binding caught up", done from the tab you are already typing in. The
  // conversation is bound to the environment as it is created, the address is
  // put in the composer so the chat has a record of where its code runs, and
  // the empty world opens so there is something to refresh.
  function newEnv() {
    const guess = slugify(document.title) || 'project';
    const name = slugify(window.prompt(
      'Name this environment.\n\nIt becomes a folder under envs\\ and the last '
      + 'part of its localhost address.', guess) || '');
    if (!name) return;
    toast(`creating <b>${esc(name)}</b>…`, 2000);
    GM_xmlhttpRequest({
      method: 'POST', url: BASE + '/newenv',
      headers: { 'Content-Type': 'application/json', 'X-Sniper-Key': KEY },
      data: JSON.stringify({ name, label: document.title || name,
                             url: location.href, switch: true }),
      timeout: 12000,
      onload(res) {
        let r = {};
        try { r = JSON.parse(res.responseText); } catch (_) {}
        if (res.status !== 200 || !r.ok) {
          toast(`<b>could not create</b> ${esc(r.error || res.status)}`, 5200);
          return;
        }
        setEnv(r.current || name);
        let where = 'copied';
        try { GM_setClipboard(r.url); } catch (_) { where = ''; }
        if (insertIntoComposer(r.url)) where = 'in the composer';
        toast(`<b>\u29c9 ${esc(name)}</b> — this chat's environment now\n`
              + `${esc(r.url)} (${esc(where || 'open it from the menu')})`, 6000);
        if (r.url) {
          if (typeof GM_openInTab === 'function') GM_openInTab(r.url, { active: false });
          else window.open(r.url, '_blank');
        }
      },
      onerror() { toast('<b>relay unreachable</b>\nis the relay running?', 4200); },
      ontimeout() { toast('<b>create timed out</b>', 4000); },
    });
  }

  let envPanel = null;
  function closeEnvPanel() {
    if (envPanel) { envPanel.remove(); envPanel = null; }
  }

  function envMenu() {
    if (envPanel) { closeEnvPanel(); return; }
    GM_xmlhttpRequest({
      method: 'GET', url: BASE + '/envs',
      headers: { 'X-Sniper-Key': KEY }, timeout: 8000,
      onload(res) {
        let r = {};
        try { r = JSON.parse(res.responseText); } catch (_) {}
        // The review console is always first: routing drops belongs on a page
        // we control, not in this script.
        const envs = [{
          name: '__new', type: 'new', ready: true,
          label: '+ new environment',
        }, {
          name: '__console', type: 'console', ready: true,
          label: 'Review console', url: BASE + '/console',
        }].concat((r && r.envs) || []);

        closeEnvPanel();
        envPanel = document.createElement('div');
        envPanel.className = 'sniper-envs';
        for (const e of envs) {
          const b = document.createElement('button');
          b.type = 'button';
          const live = e.name === ENV;
          b.textContent = (live ? '\u25cf ' : '') + (e.label || e.name);
          const s = document.createElement('small');
          s.textContent = e.type === 'new' ? 'start one, bound to this chat'
                        : e.type === 'console' ? 'route + apply pending drops'
                        : (live ? 'edits from this chat land here — ' : '')
                          + (e.ready ? '' : 'not created yet — ')
                          + (e.type === 'web' ? (e.url || '') : 'local app');
          b.appendChild(s);
          b.addEventListener('click', () => {
            closeEnvPanel();
            if (e.type === 'new') { newEnv(); return; }
            if (e.type === 'console') {
              if (typeof GM_openInTab === 'function') GM_openInTab(e.url, { active: true });
              else window.open(e.url, '_blank');
              return;
            }
            openEnv(e.name);
          });
          envPanel.appendChild(b);
        }
        dock(envPanel);
      },
      onerror() { toast('<b>relay unreachable</b>\nis the relay running?', 4200); },
      ontimeout() { toast('<b>env list timed out</b>', 4000); },
    });
  }

  // ---- codebase map -------------------------------------------------------
  // The snipe system misses when DeepSeek writes blind. Hand it the file map,
  // the symbol outline, AND the >> addressing syntax, and replies come back
  // already addressed - so the placer never has to guess where anything goes.
  function insertIntoComposer(text) {
    let box = null;
    for (const sel of (SITE.composer.length ? SITE.composer
                                            : ['textarea', '[contenteditable="true"]'])) {
      try { box = document.querySelector(sel); } catch (_) { continue; }
      if (box) break;
    }
    if (!box) return false;
    try {
      box.focus();
      if (box.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(box, (box.value ? box.value + '\n\n' : '') + text);
        box.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        box.textContent = (box.textContent ? box.textContent + '\n\n' : '') + text;
        box.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
      return true;
    } catch (_) { return false; }
  }

  // form 'full' sends the actual source, not a summary of it - a chat box copes
  // fine with 60 KB and it is the difference between the model reading the code
  // and guessing at it. alt+click for the outline-only version.
  function sendCodebase(name, form) {
    const kind = form === 'map' ? 'map'
               : form === 'rejections' ? 'outcome report' : 'source';
    toast(`building the codebase ${kind}…`, 2200);
    GM_xmlhttpRequest({
      method: 'GET',
      url: BASE + '/context?form=' + (form || 'full')
         + '&name=' + encodeURIComponent(name || ENV),
      headers: { 'X-Sniper-Key': KEY }, timeout: 45000,
      onload(res) {
        let r = {};
        try { r = JSON.parse(res.responseText); } catch (_) {}
        if (res.status !== 200 || !r.ok) {
          toast(`<b>no ${esc(kind)}</b> — ${esc(r.error || res.status)}`, 4600);
          return;
        }
        const kb = (r.bytes / 1024).toFixed(1);
        // Clipboard first and always: a controlled React composer can refuse a
        // programmatic value, and at this size the paste is the reliable path.
        GM_setClipboard(r.text, 'text');
        const placed = insertIntoComposer(r.text);
        toast(placed
          ? `<b>codebase ${esc(kind)} in the composer</b> (${esc(kb)} KB)\n`
            + `also copied — Ctrl+V if it did not take`
          : `<b>codebase ${esc(kind)} copied</b> (${esc(kb)} KB)\n`
            + `paste it into the chat with Ctrl+V`, 6000);
      },
      onerror() { toast('<b>relay unreachable</b>', 4200); },
      ontimeout() { toast(`<b>${esc(kind)} timed out</b>`, 4200); },
    });
  }

  // ---- new-chat house rules ------------------------------------------------
  // A fresh chat is the only moment these rules are cheap to state and certain
  // to be in context. Offered, never auto-pasted: silently typing into someone's
  // composer is obnoxious, and the answer is sometimes "no".
  const RULES_ASKED = 'sniper.rulesAsked';

  function isNewChat() {
    // No assistant turns yet. URL alone is unreliable - the SPA rewrites it.
    for (const sel of MESSAGES) {
      let n = 0;
      try { n = document.querySelectorAll(sel).length; } catch (_) { continue; }
      if (n) return false;
    }
    return true;
  }

  function sendRules(then) {
    GM_xmlhttpRequest({
      method: 'GET',
      url: BASE + '/context?form=rules&name=' + encodeURIComponent(ENV),
      headers: { 'X-Sniper-Key': KEY }, timeout: 15000,
      onload(res) {
        let r = {};
        try { r = JSON.parse(res.responseText); } catch (_) {}
        if (res.status !== 200 || !r.ok) {
          toast(`<b>no rules</b> — ${esc(r.error || res.status)}`, 4200);
          return;
        }
        GM_setClipboard(r.text, 'text');
        const placed = insertIntoComposer(r.text);
        toast(placed
          ? '<b>house rules in the composer</b> — send them first, then brief it'
          : '<b>house rules copied</b> — paste them as your first message', 5200);
        if (then) then();
      },
      onerror() { toast('<b>relay unreachable</b>', 4200); },
    });
  }

  function offerRules() {
    if (!isNewChat()) return;
    let state = null;
    try { state = localStorage.getItem(RULES_ASKED); } catch (_) {}
    if (state === 'never') return;

    const bar = document.createElement('div');
    bar.className = 'sniper-offer';
    const msg = document.createElement('span');
    msg.textContent = 'New chat — send the code-format house rules first?';
    bar.appendChild(msg);

    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', (ev) => { ev.preventDefault(); fn(); });
      bar.appendChild(b);
      return b;
    };
    mk('send', () => sendRules(() => bar.remove()));
    mk('not now', () => bar.remove());
    mk('never', () => {
      try { localStorage.setItem(RULES_ASKED, 'never'); } catch (_) {}
      bar.remove();
    });
    dock(bar);

    // If a reply starts arriving, the moment has passed - get out of the way.
    const obs = new MutationObserver(() => {
      if (!isNewChat()) { bar.remove(); obs.disconnect(); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  const codebase = document.createElement('button');
  codebase.className = 'sniper-launch sniper-codebase';
  codebase.type = 'button';
  codebase.textContent = '⇩ codebase';
  codebase.title = 'Put the FULL source + addressing syntax into the chat, so it can '
                 + 'read the code rather than guess at it. (Alt+C)\n'
                 + 'Alt+click for the outline-only map instead.';
  codebase.addEventListener('click', (ev) => {
    ev.preventDefault();
    sendCodebase(ENV, ev.altKey ? 'map' : 'full');
  });
  dock(codebase);

  // Closes the loop. The Placer's reasons for refusing a fragment are precise
  // and currently die in rejected\ - the chat sees silence, assumes the pipe is
  // broken, and sends bigger blocks instead of fixing the named fault.
  const feedback = document.createElement('button');
  feedback.className = 'sniper-launch sniper-feedback';
  feedback.type = 'button';
  feedback.textContent = '⇧ what landed';
  feedback.title = 'Send back what landed and what did not, with the exact reason '
                 + 'each rejection was refused. (Alt+W)';
  feedback.addEventListener('click', (ev) => {
    ev.preventDefault();
    sendCodebase(ENV, 'rejections');
  });
  dock(feedback);

  launcher = document.createElement('button');
  launcher.className = 'sniper-launch';
  launcher.type = 'button';
  setEnv(ENV);
  launcher.addEventListener('click', (ev) => { ev.preventDefault(); envMenu(); });
  dock(launcher);
  document.addEventListener('click', (ev) => {
    if (envPanel && !envPanel.contains(ev.target) && ev.target !== launcher) closeEnvPanel();
  }, true);

  console.log('[sniper]', VERSION, 'loaded on', location.hostname, '->', BASE);
})();
