// Talks to the tracker server on behalf of the Gmail content script and the popup.

const STATS_TTL_MS = 15_000;
const statsCache = new Map(); // id -> { at, data }

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
  return true;
});

async function handle(msg) {
  switch (msg?.type) {
    case 'stats':
      return { stats: await getStats(msg.ids || [], msg.force) };
    case 'self':
      await api('/api/self', { ids: msg.ids || [] });
      return { ok: true };
    case 'health':
      return api('/api/health', null, msg.settings);
    default:
      return { error: 'unknown message' };
  }
}

async function getStats(ids, force) {
  const now = Date.now();
  const out = {};
  const missing = [];
  for (const id of ids) {
    const hit = statsCache.get(id);
    if (!force && hit && now - hit.at < STATS_TTL_MS) out[id] = hit.data;
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 100) {
    const { stats } = await api('/api/stats', { ids: missing.slice(i, i + 100) });
    for (const [id, data] of Object.entries(stats || {})) {
      statsCache.set(id, { at: now, data });
      out[id] = data;
    }
  }
  return out;
}

async function api(path, body, override) {
  const { baseUrl, secret } = override || (await chrome.storage.sync.get(['baseUrl', 'secret']));
  if (!baseUrl || !secret) throw new Error('Tracker URL and secret are not set (open the extension options).');
  const res = await fetch(baseUrl.replace(/\/+$/, '') + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(res.status === 401 ? 'Wrong secret' : `Server returned ${res.status}`);
  return res.json();
}
