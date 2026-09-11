// ==UserScript==
// @name         Sniper — send text to the local relay
// @namespace    south.sniper
// @version      0.18.0
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
// ---- designated sites: add an @match line per site, then reload the page ----
// @match        https://chat.deepseek.com/*
// @match        https://*.deepseek.com/*
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '0.18.0';
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

  GM_addStyle(`
    .sniper-host { position: relative !important; }
    .sniper-btn {
      position: absolute; top: 6px; right: 6px; z-index: 2147483000;
      font: 600 11px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .02em;
      padding: 5px 9px; border-radius: 6px; cursor: pointer;
      border: 1px solid rgba(127,127,127,.45);
      background: rgba(22,22,26,.86); color: #e8e8ea;
      opacity: .55; transition: opacity .12s ease, background .12s ease;
    }
    .sniper-host:hover .sniper-btn { opacity: 1; }
    .sniper-btn:hover  { background: #2f6feb; border-color: #2f6feb; }
    .sniper-btn-msg { background: rgba(46,32,64,.86); opacity: .4; right: 6px; }
    .sniper-btn-all { background: rgba(24,58,42,.9); opacity: .4; right: 62px; }
    .sniper-btn-all:hover { background: #1f7a3d; border-color: #1f7a3d; }
    .sniper-btn-all[data-busy="1"] { background: #8a5a12; border-color: #8a5a12; opacity: 1; }
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
    .sniper-launch {
      position: fixed; left: 16px; bottom: 16px; z-index: 2147483500;
      font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
      padding: 9px 13px; border-radius: 999px; cursor: pointer;
      border: 1px solid rgba(127,127,127,.4); background: rgba(22,22,26,.9);
      color: #e8e8ea; opacity: .5; transition: opacity .12s, background .12s;
    }
    .sniper-launch:hover { opacity: 1; background: #2f6feb; border-color: #2f6feb; }
    .sniper-codebase { left: 16px; bottom: 54px; }
    .sniper-codebase:hover { background: #6b4bd6; border-color: #6b4bd6; }
    .sniper-feedback { left: 16px; bottom: 92px; }
    .sniper-feedback:hover { background: #a35a1f; border-color: #a35a1f; }
    .sniper-offer {
      position: fixed; left: 16px; bottom: 180px; z-index: 2147483550;
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
      position: fixed; left: 16px; bottom: 134px; z-index: 2147483500;
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

  let toastEl = null, toastTimer = null;
  function toast(msg, ms = 2600) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'sniper-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.innerHTML = msg;
    requestAnimationFrame(() => toastEl.setAttribute('data-in', '1'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.removeAttribute('data-in'), ms);
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
  function skeleton(el, depth = 0, max = 4) {
    if (!el || depth > max) return '';
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

    const selectors = CANDIDATES.concat(MESSAGES).map((sel) => {
      let count = 0;
      try { count = findAll(sel).length; } catch (_) { count = -1; }
      return { sel, count, role: CANDIDATES.includes(sel) ? 'code' : 'message' };
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

    // Skeleton around the biggest block of text on the page.
    let biggest = null, bigLen = 0;
    for (const el of document.querySelectorAll('div,article,section')) {
      const t = (el.innerText || '').length;
      if (t > bigLen && t < 20000) { bigLen = t; biggest = el; }
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
  function textOf(el, kind) {
    // For a code block, read the <code> child live - innerText keeps the line
    // breaks that textContent-on-a-detached-clone would preserve but that
    // innerText-on-a-clone would lose (a clone has no layout).
    if (kind !== 'message') {
      const code = el.querySelector('code');
      if (code) return (code.innerText || code.textContent || '').replace(/\u00a0/g, ' ');
    }
    // For a whole message we want innerText's paragraph breaks, so read it in
    // place - hiding our own buttons first, since innerText honours display:none.
    const btns = Array.from(el.querySelectorAll('.sniper-btn'));
    btns.forEach((b) => { b.style.display = 'none'; });
    const t = (el.innerText || el.textContent || '').replace(/\u00a0/g, ' ');
    btns.forEach((b) => { b.style.display = ''; });
    return t;
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
      } else if (r.routed === 'context') {
        toast(`<b>filed as context</b> — ${esc(r.lines)} lines of explanation.\n`
            + `Both agents read it for intent; it is not queued as code.`, 4400);
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
      const { text, info } = await stableText(() => textOf(el, 'codeblock'), null,
                                              false, needsCodeCheck('codeblock'));
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

    const btn = document.createElement('button');
    btn.className = 'sniper-btn' + (kind === 'message' ? ' sniper-btn-msg' : '');
    btn.type = 'button';
    btn.textContent = kind === 'message' ? '→ msg' : '→ Claude';
    btn.dataset.label = btn.textContent;
    btn.title = (kind === 'message'
      ? 'Send this whole message to the sniper relay.\n'
      : 'Send this code block to the sniper relay.\n')
      + 'First line may address it, e.g.  // >> src/thing.py @replace';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      captureStable(() => textOf(el, kind), btn,
        (text, info) => {
          if (text === null) return;
          send(text, { kind, lang: langOf(el), ...(info || {}) }, btn);
        },
        ev.altKey, needsCodeCheck(kind));
    });
    el.appendChild(btn);

    // A reply that arrives as a dozen organised chunks shouldn't be a dozen
    // clicks. One button, every block in this message, in order.
    if (kind === 'message') {
      const all = document.createElement('button');
      all.className = 'sniper-btn sniper-btn-all';
      all.type = 'button';
      all.textContent = '→ all';
      all.dataset.label = '→ all';
      all.title = 'Send every code block in this message, in order.\n'
                + 'Each one waits for its own text to settle first.';
      all.addEventListener('click', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        sendAll(blocksIn(el), all);
      });
      el.appendChild(all);
    }

    decorated++;
  }

  function pickSelector() {
    for (const sel of CANDIDATES) {
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
    for (const sel of MESSAGES) {
      let found = [];
      try { found = findAll(sel); } catch (_) { continue; }
      if (found.length) { found.forEach((el) => decorate(el, 'message')); break; }
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
      sendCodebase('zombie');
    } else if (k === 'r') {
      ev.preventDefault();
      sendRules();
    } else if (k === 'w') {
      ev.preventDefault();
      sendCodebase('zombie', 'rejections');
    } else if (k === 'a') {
      // Alt+A - every block in the LAST message, for when you don't want to
      // scroll back up to find its button.
      ev.preventDefault();
      const msgs = Array.from(document.querySelectorAll('.sniper-host'))
        .filter((n) => n.querySelector('.sniper-btn-all'));
      const last = msgs[msgs.length - 1];
      if (!last) { toast('no message found'); return; }
      sendAll(blocksIn(last), last.querySelector('.sniper-btn-all'));
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
  function openEnv(name) {
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
          name: '__console', type: 'console', ready: true,
          label: 'Review console', url: BASE + '/console',
        }].concat((r && r.envs) || []);

        closeEnvPanel();
        envPanel = document.createElement('div');
        envPanel.className = 'sniper-envs';
        for (const e of envs) {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = e.label || e.name;
          const s = document.createElement('small');
          s.textContent = e.type === 'console' ? 'route + apply pending drops'
                        : (e.ready ? '' : 'not created yet — ')
                          + (e.type === 'web' ? (e.url || '') : 'local app');
          b.appendChild(s);
          b.addEventListener('click', () => {
            closeEnvPanel();
            if (e.type === 'console') {
              if (typeof GM_openInTab === 'function') GM_openInTab(e.url, { active: true });
              else window.open(e.url, '_blank');
              return;
            }
            openEnv(e.name);
          });
          envPanel.appendChild(b);
        }
        document.body.appendChild(envPanel);
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
    const box = document.querySelector('textarea')
      || document.querySelector('[contenteditable="true"]');
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
         + '&name=' + encodeURIComponent(name || 'zombie'),
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
      method: 'GET', url: BASE + '/context?form=rules&name=zombie',
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
    document.body.appendChild(bar);

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
    sendCodebase('zombie', ev.altKey ? 'map' : 'full');
  });
  document.body.appendChild(codebase);

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
    sendCodebase('zombie', 'rejections');
  });
  document.body.appendChild(feedback);

  const launcher = document.createElement('button');
  launcher.className = 'sniper-launch';
  launcher.type = 'button';
  launcher.textContent = '⧉ load environment';
  launcher.title = 'Open a environment from envs.json (Alt+E)';
  launcher.addEventListener('click', (ev) => { ev.preventDefault(); envMenu(); });
  document.body.appendChild(launcher);
  document.addEventListener('click', (ev) => {
    if (envPanel && !envPanel.contains(ev.target) && ev.target !== launcher) closeEnvPanel();
  }, true);

  console.log('[sniper]', VERSION, 'loaded on', location.hostname, '->', BASE);
})();
