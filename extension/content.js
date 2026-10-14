// Mail Tracker — Gmail content script.
//  * On Send: appends a 1x1 pixel to the message and routes its links through the tracker.
//  * In mail lists and open threads: shows Unopened / Opened / Clicks labels.
//  * Tells the server whenever *you* load one of your own pixels, so your views don't count.
//
// Gmail enforces Trusted Types, so this file never uses innerHTML.
(() => {
  'use strict';

  const SEND_BTN = 'div[role="button"].aoO, div[role="button"][data-tooltip^="Send"]';
  const BODY = 'div[contenteditable="true"][role="textbox"], div.editable[contenteditable="true"]';
  const POLL_MS = 30_000;
  const MAX_RECORDS = 3000;

  let settings = { baseUrl: '', secret: '', enabled: true };
  let tracked = {}; // id -> { id, subject, to, sentAt, threadId }
  const stats = {}; // id -> stats from the server
  const requested = new Set();
  let visibleIds = new Set();

  const base = () => (settings.baseUrl || '').trim().replace(/\/+$/, '');
  // After the extension is reloaded, scripts already in open Gmail tabs lose access to
  // chrome.* APIs. They must go quiet, or they'd add images that are never recorded.
  const alive = () => Boolean(globalThis.chrome?.runtime?.id);
  const configured = () => alive() && Boolean(base() && settings.secret);

  // ---------- settings & storage ----------

  async function loadSettings() {
    const s = await chrome.storage.sync.get(['baseUrl', 'secret', 'enabled']);
    settings = { baseUrl: s.baseUrl || '', secret: s.secret || '', enabled: s.enabled !== false };
  }

  Promise.all([
    loadSettings(),
    chrome.storage.local.get('tracked').then(({ tracked: t }) => (tracked = t || {})),
  ]).then(scheduleScan);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') loadSettings().then(scheduleScan);
    if (area === 'local' && changes.tracked) {
      tracked = changes.tracked.newValue || {};
      scheduleScan();
    }
  });

  async function saveRecord(patch) {
    try {
      const { tracked: cur = {} } = await chrome.storage.local.get('tracked');
      const rec = (cur[patch.id] ||= {});
      for (const [k, v] of Object.entries(patch)) if (v != null || !(k in rec)) rec[k] = v;
      const ids = Object.keys(cur);
      if (ids.length > MAX_RECORDS) {
        ids.sort((a, b) => (cur[a].sentAt || 0) - (cur[b].sentAt || 0))
          .slice(0, ids.length - MAX_RECORDS)
          .forEach((id) => delete cur[id]);
      }
      tracked = cur;
      await chrome.storage.local.set({ tracked: cur });
    } catch {
      // extension was reloaded; this tab's script is orphaned
    }
  }

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  // ---------- URLs ----------

  const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);

  function clickUrl(id, url) {
    const sig = globalThis.mtHmac(settings.secret, `${id}|${url}`).slice(0, 16);
    return `${base()}/c/${id}?u=${encodeURIComponent(url)}&s=${sig}`;
  }

  // Accepts a tracker link, or Gmail's google.com/url?q=<tracker link> wrapper.
  function parseClickUrl(href) {
    const b = base();
    if (!b || !href) return null;
    try {
      let u = new URL(href, location.href);
      if (/(^|\.)google\.com$/.test(u.hostname) && u.pathname === '/url') {
        const q = u.searchParams.get('q') || u.searchParams.get('url');
        if (!q) return null;
        u = new URL(q);
      }
      if (!u.href.startsWith(`${b}/c/`)) return null;
      const id = u.pathname.match(/\/c\/([A-Za-z0-9_-]+)$/)?.[1];
      const url = u.searchParams.get('u');
      return id && url ? { id, url } : null;
    } catch {
      return null;
    }
  }

  // Gmail serves images through its proxy as https://ciN.googleusercontent.com/...#<original url>
  function pixelIdFromSrc(src) {
    const b = base();
    if (!b || !src) return null;
    let s = src;
    try {
      s = decodeURIComponent(src);
    } catch {}
    const i = s.indexOf(`${b}/p/`);
    if (i < 0) return null;
    return s.slice(i + b.length + 3).match(/^([A-Za-z0-9_-]{8,64})/)?.[1] || null;
  }

  // ---------- compose: inject on send ----------

  // The editable body that belongs to the same compose window as `el`.
  function bodyNear(el) {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (n.matches?.(BODY)) return n;
      const found = n.querySelectorAll(BODY);
      if (found.length === 1) return found[0];
      if (found.length > 1) return null;
    }
    return null;
  }

  function composeRoot(body) {
    let n = body;
    for (let depth = 0; n.parentElement && depth < 25; depth++) {
      n = n.parentElement;
      if (n.querySelectorAll(BODY).length > 1) return null;
      if (n.querySelector('input[name="subjectbox"]')) return n;
    }
    return null;
  }

  // Gmail snapshots the draft before Send handlers run, so tracking is added while
  // you write (on compose open, on typing, on blur) and kept in place until Send.
  function prepare(body) {
    if (!configured() || !settings.enabled || body.dataset.mtOff === '1') return;
    // Only the visible message editor; Gmail keeps hidden editables around too.
    if (body.offsetParent === null || body.closest('[aria-hidden="true"]')) return;
    // If Gmail keeps stripping the image out of this editor, stop fighting it.
    if (Number(body.dataset.mtReadds || 0) > 3) return;
    let changed = false;
    // Gmail sometimes rebuilds the editor element mid-compose, so the id also lives on
    // the compose window; otherwise one email would get a second id.
    const holder = composeHolder(body);
    let id = body.dataset.mtId || holder?.dataset.mtId;
    if (!id) {
      // A reopened draft already carries its pixel: keep that id.
      const own = [...body.querySelectorAll('img')].find((img) => !img.closest('.gmail_quote') && pixelIdFromSrc(img.getAttribute('src') || ''));
      id = (own && pixelIdFromSrc(own.getAttribute('src'))) || newId();
    }
    body.dataset.mtId = id;
    if (holder) holder.dataset.mtId = id;

    // Drop pixels carried over from quoted mail, keep ours.
    let hasPixel = false;
    for (const img of body.querySelectorAll('img')) {
      const pid = pixelIdFromSrc(img.getAttribute('src') || '');
      if (!pid) continue;
      if (pid === id && !hasPixel) hasPixel = true;
      else {
        img.remove();
        changed = true;
      }
    }

    for (const a of body.querySelectorAll('a[href]')) {
      if (a.closest('.gmail_quote')) continue;
      let href = (a.getAttribute('href') || '').trim();
      const prev = parseClickUrl(href);
      if (prev) {
        if (prev.id === id) continue;
        href = prev.url;
      }
      if (/^https?:\/\//i.test(href)) {
        a.setAttribute('href', clickUrl(id, href));
        changed = true;
      }
    }

    if (!hasPixel) {
      const img = document.createElement('img');
      img.setAttribute('src', `${base()}/p/${id}.gif`);
      img.setAttribute('width', '1');
      img.setAttribute('height', '1');
      img.setAttribute('alt', '');
      img.setAttribute('style', 'width:1px;height:1px;border:0');
      body.appendChild(img);
      body.dataset.mtReadds = String(Number(body.dataset.mtReadds || 0) + 1);
      changed = true;
      // The browser fetches the pixel as soon as it's inserted; don't count that.
      selfPing([id]);
    }
    if (changed) notifyGmail(body);
  }

  function composeHolder(body) {
    return body.closest('[role="dialog"]') || composeRoot(body);
  }

  function untrack(body) {
    let changed = false;
    for (const img of body.querySelectorAll('img')) {
      if (!img.closest('.gmail_quote') && pixelIdFromSrc(img.getAttribute('src') || '')) {
        img.remove();
        changed = true;
      }
    }
    for (const a of body.querySelectorAll('a[href]')) {
      const prev = !a.closest('.gmail_quote') && parseClickUrl(a.getAttribute('href'));
      if (prev) {
        a.setAttribute('href', prev.url);
        changed = true;
      }
    }
    delete body.dataset.mtId;
    const holder = composeHolder(body);
    if (holder) delete holder.dataset.mtId;
    if (changed) notifyGmail(body);
  }

  // Let Gmail's editor know the content changed so the draft it saves includes it.
  function notifyGmail(body) {
    body.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const committed = new Set();
  function commit(body) {
    const id = body.dataset.mtId;
    if (!id || body.dataset.mtOff === '1' || committed.has(id)) return;
    const inBody = [...body.querySelectorAll('img')].some((img) => pixelIdFromSrc(img.getAttribute('src') || '') === id);
    if (!inBody) return;
    committed.add(id);

    const root = composeRoot(body);
    const inline = !body.closest('[role="dialog"]');
    const heading = visibleEl('h2.hP');
    const subject =
      root?.querySelector('input[name="subjectbox"]')?.value.trim() ||
      (inline && heading?.textContent.trim()) ||
      '(no subject)';
    const to = root
      ? [...new Set([...root.querySelectorAll('[email], [data-hovercard-id]')]
          .map((el) => el.getAttribute('email') || el.getAttribute('data-hovercard-id'))
          .filter((v) => v && v.includes('@')))]
      : [];
    const threadId = inline ? visibleEl('h2[data-legacy-thread-id]')?.getAttribute('data-legacy-thread-id') || null : null;

    saveRecord({ id, subject, to, sentAt: Date.now(), threadId });
  }

  const inputTimers = new WeakMap();
  document.addEventListener('input', (e) => {
    if (!e.isTrusted) return;
    const body = e.target.closest?.(BODY);
    if (!body) return;
    clearTimeout(inputTimers.get(body));
    inputTimers.set(body, setTimeout(() => prepare(body), 700));
  }, true);
  document.addEventListener('focusout', (e) => {
    const body = e.target.closest?.(BODY);
    if (body) prepare(body);
  }, true);

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const btn = e.target.closest?.(SEND_BTN);
    const body = btn && bodyNear(btn);
    if (body) prepare(body);
  }, true);

  document.addEventListener('mouseup', (e) => {
    const btn = e.target.closest?.(SEND_BTN);
    const body = btn && bodyNear(btn);
    if (body) commit(body);
  }, true);

  document.addEventListener('keydown', (e) => {
    const shortcut = e.key === 'Enter' && (e.ctrlKey || e.metaKey);
    const btn = (e.key === 'Enter' || e.key === ' ') && e.target.closest?.(SEND_BTN);
    if (!shortcut && !btn) return;
    const body = btn ? bodyNear(btn) : e.target.closest?.(BODY) || bodyNear(e.target);
    if (!body) return;
    prepare(body);
    commit(body);
  }, true);

  // Clicking your own tracked links goes straight to the destination.
  function onLinkClick(e) {
    if (e.type === 'auxclick' && e.button !== 1) return;
    const a = e.target.closest?.('a[href]');
    if (!a || a.closest('[contenteditable="true"]')) return;
    const parsed = parseClickUrl(a.getAttribute('href')) || parseClickUrl(a.getAttribute('data-saferedirecturl'));
    if (!parsed) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    window.open(parsed.url, '_blank', 'noopener,noreferrer');
  }
  document.addEventListener('click', onLinkClick, true);
  document.addEventListener('auxclick', onLinkClick, true);

  // ---------- self views ----------

  const lastSelfPing = new Map();
  function selfPing(ids, force) {
    const now = Date.now();
    const due = ids.filter((id) => force || now - (lastSelfPing.get(id) || 0) > 5000);
    if (!due.length) return;
    for (const id of due) lastSelfPing.set(id, now);
    send({ type: 'self', ids: due });
  }

  // ---------- labels ----------

  function visibleEl(sel) {
    for (const el of document.querySelectorAll(sel)) if (el.offsetParent !== null) return el;
    return null;
  }

  function normSubject(s) {
    let t = (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    while (/^(re|fw|fwd|aw|sv|wg)\s*:\s*/.test(t)) t = t.replace(/^(re|fw|fwd|aw|sv|wg)\s*:\s*/, '');
    return t;
  }

  function scanThreads() {
    const heading = visibleEl('h2[data-legacy-thread-id]');
    const threadId = heading?.getAttribute('data-legacy-thread-id') || null;
    const seen = [];

    for (const img of document.querySelectorAll('.a3s img, .ii img')) {
      const id = pixelIdFromSrc(img.getAttribute('src') || '');
      if (!id || img.closest(BODY)) continue;
      if (!img.dataset.mtSeen) {
        img.dataset.mtSeen = '1';
        seen.push(id);
      }
      if (img.closest('.gmail_quote, blockquote')) continue; // our pixel quoted in someone's reply

      if (!tracked[id]) continue; // not an email you sent from this browser
      if (threadId && !tracked[id].threadId) {
        saveRecord({ id, threadId });
      }

      visibleIds.add(id);
      const header = img.closest('.adn, .gs')?.querySelector('.gH');
      if (header) renderBadge(header, id, (el) => header.prepend(el));
      else renderBadge(img.parentElement, id, (el) => img.before(el));
    }
    if (seen.length) selfPing(seen);
  }

  function scanList() {
    const rows = document.querySelectorAll('tr.zA');
    if (!rows.length) return;

    const byThread = new Map();
    const bySubject = new Map();
    for (const r of Object.values(tracked)) {
      if (r.threadId) {
        const cur = byThread.get(r.threadId);
        if (!cur || (r.sentAt || 0) > (cur.sentAt || 0)) byThread.set(r.threadId, r);
      }
      if (r.sentAt) {
        const k = normSubject(r.subject);
        if (!bySubject.has(k)) bySubject.set(k, []);
        bySubject.get(k).push(r);
      }
    }
    // Subject matching is only trusted in Sent, where every row is yours.
    const inSent = /^#sent\b/.test(location.hash);

    for (const row of rows) {
      const host = row.querySelector('.y6') || row.querySelector('.bog')?.parentElement;
      if (!host) continue;
      const tid = row.querySelector('[data-legacy-thread-id]')?.getAttribute('data-legacy-thread-id');
      let rec = (tid && byThread.get(tid)) || null;
      if (!rec && inSent) rec = matchBySubject(row, bySubject);

      if (rec) {
        visibleIds.add(rec.id);
        renderBadge(host, rec.id, (el) => host.prepend(el));
      } else {
        host.querySelector(':scope > .mt-badges')?.remove();
      }
    }
  }

  // Newest tracked mail with this subject sent no later than the row's timestamp.
  function matchBySubject(row, bySubject) {
    const cands = bySubject.get(normSubject(row.querySelector('.bog')?.textContent));
    if (!cands?.length) return null;
    const title = row.querySelector('td.xW [title], .xW [title]')?.getAttribute('title') || '';
    const t = Date.parse(title.replace(/[  ]/g, ' '));
    let best = null;
    for (const c of cands) {
      if (!Number.isNaN(t) && c.sentAt > t + 120_000) continue;
      if (!best || c.sentAt > best.sentAt) best = c;
    }
    return best;
  }

  // ---------- label & hover card UI (DOM APIs only: Gmail enforces Trusted Types) ----------

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    eye: 'M12 5C6.6 5 2.9 9.1 1.5 12c1.4 2.9 5.1 7 10.5 7s9.1-4.1 10.5-7C21.1 9.1 17.4 5 12 5zm0 11.5a4.5 4.5 0 110-9 4.5 4.5 0 010 9zm0-2.5a2 2 0 100-4 2 2 0 000 4z',
    click: 'M9 3.5l11 8.6-4.9.9 3 6.3-2.4 1.2-3-6.4L9 17.5v-14zM4.2 4.8l1.7-1 1.4 2.4-1.7 1-1.4-2.4zM2.5 10h2.8v2H2.5v-2zm1.1 6.6l2.4-1.4 1 1.7-2.4 1.4-1-1.7z',
    clock: 'M12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16zm1-13h-2v6.2l5 3 1-1.6-4-2.4V7z',
    send: 'M3 20.5v-6.2l9-2.3-9-2.3V3.5l19 8.5-19 8.5z',
    off: 'M2.8 4.2l1.4-1.4 17 17-1.4 1.4-3.2-3.2A11 11 0 0112 19C6.6 19 2.9 14.9 1.5 12a13 13 0 014-4.8L2.8 4.2zM12 5c5.4 0 9.1 4.1 10.5 7a13.4 13.4 0 01-2.8 3.8L16.4 12.5A4.5 4.5 0 0011.5 7.6L9.3 5.4C10.2 5.1 11.1 5 12 5z',
  };

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'mt-ico');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }

  function h(tag, cls, ...kids) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    for (const k of kids) if (k != null) el.append(k);
    return el;
  }

  function chip(cls, label, iconName, count) {
    const el = h('span', `mt-chip ${cls}`);
    if (iconName) el.append(icon(iconName));
    el.append(label);
    if (count > 1) el.append(h('b', 'mt-count', String(count)));
    return el;
  }

  function renderBadge(host, id, place) {
    let el = host.querySelector(':scope > .mt-badges');
    if (!el) {
      el = document.createElement('span');
      el.className = 'mt-badges';
      place(el);
    }
    el.dataset.id = id;
    const s = stats[id];
    const sig = s ? `${id}|${s.opens}|${s.clicks}|${s.lastOpen}|${s.lastClick}` : `${id}|-`;
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;

    const chips = [];
    if (!s) chips.push(h('span', 'mt-chip mt-pending', h('i', 'mt-shimmer')));
    else {
      if (!s.opens && !s.clicks) chips.push(chip('mt-unopened', 'Unopened', 'clock'));
      if (s.opens) chips.push(chip('mt-opened', 'Opened', 'eye', s.opens));
      if (s.clicks) chips.push(chip('mt-clicks', 'Clicked', 'click', s.clicks));
    }
    el.replaceChildren(...chips);
    if (popFor === id && pop?.classList.contains('mt-show')) fillPopover(id);
  }

  const fmt = (ts) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  function ago(ts) {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
    return `${Math.round(m / 1440)}d ago`;
  }

  function shortUrl(u) {
    try {
      const x = new URL(u);
      return (x.hostname.replace(/^www\./, '') + x.pathname).replace(/\/$/, '').slice(0, 48);
    } catch {
      return u || '';
    }
  }

  // Hover card
  let pop = null;
  let popFor = null;
  let hideTimer = null;

  function fillPopover(id) {
    const rec = tracked[id] || {};
    const s = stats[id];
    const state = !s ? 'pending' : s.clicks ? 'clicks' : s.opens ? 'opened' : 'unopened';
    const stateText = { pending: 'Loading…', clicks: 'Clicked', opened: 'Opened', unopened: 'Not opened yet' }[state];

    const head = h('div', 'mt-pop-head',
      h('div', `mt-pop-state mt-st-${state}`, icon(state === 'clicks' ? 'click' : state === 'opened' ? 'eye' : 'clock'), stateText),
      h('div', 'mt-pop-subj', rec.subject || '(no subject)'),
      h('div', 'mt-pop-meta', [rec.to?.length ? `To ${rec.to.join(', ')}` : null, rec.sentAt ? `Sent ${fmt(rec.sentAt)}` : null].filter(Boolean).join('  ·  ')));

    const stat = (label, value, cls) => h('div', `mt-stat ${cls || ''}`, h('div', 'mt-stat-v', value), h('div', 'mt-stat-l', label));
    const grid = h('div', 'mt-pop-stats',
      stat('Opens', String(s?.opens ?? '–'), 'mt-v-open'),
      stat('Clicks', String(s?.clicks ?? '–'), 'mt-v-click'),
      stat('Last opened', s?.lastOpen ? ago(s.lastOpen) : '—'));

    const tl = h('div', 'mt-pop-tl');
    for (const e of s?.recent || []) {
      const where = [e.client !== 'unknown' && e.client, e.country].filter(Boolean).join(' · ');
      tl.append(h('div', `mt-tl-item mt-tl-${e.type}`,
        h('span', 'mt-tl-dot', icon(e.type === 'open' ? 'eye' : 'click')),
        h('div', 'mt-tl-body',
          h('div', 'mt-tl-title', e.type === 'open' ? 'Opened' : `Clicked ${shortUrl(e.url)}`),
          where ? h('div', 'mt-tl-sub', where) : null),
        h('span', 'mt-tl-time', ago(e.ts))));
    }
    if (rec.sentAt) {
      tl.append(h('div', 'mt-tl-item mt-tl-sent', h('span', 'mt-tl-dot', icon('send')),
        h('div', 'mt-tl-body', h('div', 'mt-tl-title', 'Sent')), h('span', 'mt-tl-time', ago(rec.sentAt))));
    }
    const kids = [head, grid];
    if (tl.childElementCount) kids.push(h('div', 'mt-pop-section', 'Activity'), tl);
    if (s && !s.opens && !s.clicks) kids.push(h('div', 'mt-pop-empty', 'No activity yet. This updates on its own every 30 seconds.'));
    pop.replaceChildren(...kids);
  }

  function showPopover(anchor) {
    const id = anchor.dataset.id;
    if (!id) return;
    if (!pop) {
      pop = h('div', 'mt-pop');
      document.body.append(pop);
    }
    popFor = id;
    fillPopover(id);
    const r = anchor.getBoundingClientRect();
    if (!r.width) return;
    pop.style.visibility = 'hidden';
    pop.classList.add('mt-show');
    const w = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
    const below = r.bottom + 8 + ph < innerHeight;
    pop.style.left = `${left}px`;
    pop.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top - ph - 8)}px`;
    pop.style.visibility = '';
  }

  document.addEventListener('mouseover', (e) => {
    const badge = e.target.closest?.('.mt-badges');
    const inPop = e.target.closest?.('.mt-pop');
    if (badge || inPop) clearTimeout(hideTimer);
    if (badge && (badge.dataset.id !== popFor || !pop?.classList.contains('mt-show'))) showPopover(badge);
    else if (!badge && !inPop && pop?.classList.contains('mt-show')) {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        pop.classList.remove('mt-show');
        popFor = null;
      }, 160);
    }
  }, true);

  // ---------- compose toggle ----------

  function paintToggle(el, body) {
    const off = body.dataset.mtOff === '1';
    el.replaceChildren(icon(off ? 'off' : 'eye'), off ? 'Not tracking' : 'Tracking');
    el.classList.toggle('mt-off', off);
    el.title = off ? 'This email will be sent without tracking. Click to track it.' : 'Opens and clicks will be tracked. Click to turn off for this email.';
  }

  function scanCompose() {
    for (const btn of document.querySelectorAll(SEND_BTN)) {
      const anchor = btn.closest('.dC') || btn;
      const body = bodyNear(btn);
      if (!body) continue;
      prepare(body);
      const existing = anchor.nextElementSibling;
      if (existing?.classList.contains('mt-toggle')) {
        existing.hidden = !settings.enabled;
        continue;
      }
      const el = document.createElement('div');
      el.className = 'mt-toggle';
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      const flip = (e) => {
        e.preventDefault();
        e.stopPropagation();
        body.dataset.mtOff = body.dataset.mtOff === '1' ? '0' : '1';
        if (body.dataset.mtOff === '1') untrack(body);
        else prepare(body);
        paintToggle(el, body);
      };
      el.addEventListener('click', flip);
      el.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && flip(e));
      el.hidden = !settings.enabled;
      paintToggle(el, body);
      anchor.after(el);
    }
  }

  // ---------- scan / poll loop ----------

  function scan() {
    if (!configured()) return;
    visibleIds = new Set();
    scanCompose();
    scanThreads();
    scanList();
    if ([...visibleIds].some((id) => !requested.has(id))) refreshSoon();
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 400);
  }

  let refreshTimer = null;
  let inFlight = false;
  function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 300);
  }

  async function refresh() {
    if (inFlight || !configured() || !visibleIds.size || document.hidden) return;
    inFlight = true;
    const ids = [...visibleIds];
    ids.forEach((id) => requested.add(id));
    try {
      const res = await send({ type: 'stats', ids });
      if (res?.stats) Object.assign(stats, res.stats);
      if (res?.error) console.warn('[mail-tracker]', res.error);
    } finally {
      inFlight = false;
    }
    scan();
  }

  new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('hashchange', scheduleScan);
  document.addEventListener('visibilitychange', () => !document.hidden && refresh());
  setInterval(refresh, POLL_MS);
})();
