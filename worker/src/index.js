// Mail Tracker backend (Cloudflare Worker + D1).
//
//   GET  /p/:id.gif        open pixel (public)
//   GET  /c/:id?u=&s=      click redirect, s = HMAC(secret, "id|url") (public)
//   GET  /api/health       auth check
//   POST /api/stats {ids}  open/click counts per email
//   POST /api/self  {ids}  "the sender is looking at these right now" — opens
//                          within SELF_WINDOW_MS of a self view are not counted

const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SIG_LEN = 16;
const SELF_WINDOW_MS = 15_000;
const OPEN_DEDUPE_MS = 120_000; // a re-render or quick re-open within 2 min is the same view
const MAX_IDS = 100;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};
const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0, private',
  Pragma: 'no-cache',
  Expires: '0',
};

export default {
  async fetch(req, env, ctx) {
    if (!env.TRACKER_SECRET) return text('TRACKER_SECRET is not set', 500);

    const url = new URL(req.url);
    const path = url.pathname;
    let m;

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if ((m = path.match(/^\/p\/([^/.]+)(?:\.gif)?$/))) {
      if (ID_RE.test(m[1])) ctx.waitUntil(record(env, req, m[1], 'open', null));
      return new Response(GIF, { headers: { 'Content-Type': 'image/gif', ...NO_CACHE } });
    }

    if ((m = path.match(/^\/c\/([^/]+)$/))) {
      const id = m[1];
      const target = url.searchParams.get('u') || '';
      if (!ID_RE.test(id) || !isHttpUrl(target)) return text('Invalid link', 400);
      const expected = (await hmacHex(env.TRACKER_SECRET, `${id}|${target}`)).slice(0, SIG_LEN);
      if (!safeEqual(expected, url.searchParams.get('s') || '')) return interstitial(target);
      ctx.waitUntil(record(env, req, id, 'click', target));
      return new Response(null, { status: 302, headers: { Location: new URL(target).href, ...NO_CACHE } });
    }

    if (path.startsWith('/api/')) {
      const auth = req.headers.get('Authorization') || '';
      if (!safeEqual(auth, `Bearer ${env.TRACKER_SECRET}`)) return json({ error: 'unauthorized' }, 401);

      if (path === '/api/health') return json({ ok: true, time: Date.now() });

      if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      const body = await req.json().catch(() => ({}));
      const ids = [...new Set(Array.isArray(body.ids) ? body.ids : [])]
        .filter((id) => typeof id === 'string' && ID_RE.test(id))
        .slice(0, MAX_IDS);

      if (path === '/api/self') {
        const now = Date.now();
        if (ids.length) {
          await env.DB.batch(ids.map((id) => env.DB.prepare('INSERT INTO self_views (email_id, ts) VALUES (?, ?)').bind(id, now)));
        }
        return json({ ok: true });
      }

      if (path === '/api/stats') return json({ stats: await stats(env, ids) });
    }

    if (path === '/') return text('mail-tracker is running');
    return text('Not found', 404);
  },
};

async function record(env, req, id, type, target) {
  await env.DB.prepare('INSERT INTO events (email_id, type, url, ts, ua, country) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, type, target, Date.now(), (req.headers.get('User-Agent') || '').slice(0, 300), req.cf?.country ?? null)
    .run();
}

async function stats(env, ids) {
  const out = {};
  if (!ids.length) return out;
  for (const id of ids) {
    out[id] = { opens: 0, clicks: 0, firstOpen: null, lastOpen: null, lastClick: null, recent: [] };
  }

  const ph = ids.map(() => '?').join(',');
  const [events, selfViews] = await env.DB.batch([
    env.DB.prepare(`SELECT email_id, type, url, ts, ua, country FROM events WHERE email_id IN (${ph}) ORDER BY ts`).bind(...ids),
    env.DB.prepare(`SELECT email_id, ts FROM self_views WHERE email_id IN (${ph})`).bind(...ids),
  ]);

  const selfById = {};
  for (const { email_id, ts } of selfViews.results) (selfById[email_id] ||= []).push(ts);

  for (const e of events.results) {
    const s = out[e.email_id];
    if (e.type === 'open') {
      if ((selfById[e.email_id] || []).some((t) => Math.abs(t - e.ts) <= SELF_WINDOW_MS)) continue;
      if (s.lastOpen && e.ts - s.lastOpen < OPEN_DEDUPE_MS) continue;
      s.opens++;
      s.firstOpen ??= e.ts;
      s.lastOpen = e.ts;
    } else {
      s.clicks++;
      s.lastClick = e.ts;
    }
    s.recent.push({ type: e.type, ts: e.ts, url: e.url, client: client(e.ua), country: e.country });
  }
  for (const s of Object.values(out)) s.recent = s.recent.slice(-10).reverse();
  return out;
}

function client(ua) {
  if (!ua) return 'unknown';
  if (/GoogleImageProxy/i.test(ua)) return 'Gmail';
  if (/YahooMailProxy/i.test(ua)) return 'Yahoo Mail';
  if (/Outlook|Microsoft Office|ms-office/i.test(ua)) return 'Outlook';
  if (/Thunderbird/i.test(ua)) return 'Thunderbird';
  if (/iPhone|iPad/i.test(ua)) return 'iOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  return 'other';
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return Array.from(mac, (x) => x.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

// A link whose signature doesn't verify is not redirected silently (that would be an
// open redirect); the visitor gets a page asking them to continue by hand.
function interstitial(target) {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Leaving link</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px">
<p>This link points to:</p><p style="word-break:break-all"><strong>${esc(target)}</strong></p>
<p><a href="${esc(new URL(target).href)}" rel="noreferrer">Continue</a></p></body>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_CACHE } });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

function text(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
