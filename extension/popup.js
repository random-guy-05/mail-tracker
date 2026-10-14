const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  eye: 'M12 5C6.6 5 2.9 9.1 1.5 12c1.4 2.9 5.1 7 10.5 7s9.1-4.1 10.5-7C21.1 9.1 17.4 5 12 5zm0 11.5a4.5 4.5 0 110-9 4.5 4.5 0 010 9zm0-2.5a2 2 0 100-4 2 2 0 000 4z',
  click: 'M9 3.5l11 8.6-4.9.9 3 6.3-2.4 1.2-3-6.4L9 17.5v-14zM4.2 4.8l1.7-1 1.4 2.4-1.7 1-1.4-2.4zM2.5 10h2.8v2H2.5v-2zm1.1 6.6l2.4-1.4 1 1.7-2.4 1.4-1-1.7z',
  clock: 'M12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16zm1-13h-2v6.2l5 3 1-1.6-4-2.4V7z',
  gear: 'M19.4 13a7.5 7.5 0 000-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 00-1.7-1L15 3h-4l-.4 2.7a7.4 7.4 0 00-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 000 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1L11 21h4l.4-2.7c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5-2.2-1.8zM13 15.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7z',
};
const AVATAR_COLORS = ['#6d4aff', '#0f8a4b', '#e8710a', '#1a73e8', '#d93025', '#9334e6', '#12b5cb', '#c5221f'];

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', ICONS[name]);
  svg.append(p);
  return svg;
}

function h(tag, cls, ...kids) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  for (const k of kids) if (k != null) el.append(k);
  return el;
}

function ago(ts) {
  if (!ts) return '';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

$('logo').append(icon('eye'));
$('settings').append(icon('gear'));
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

let rows = [];
let filter = 'all';

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  filter = b.dataset.f;
  for (const x of $('tabs').children) x.classList.toggle('on', x === b);
  render();
});

function render() {
  const list = $('list');
  const shown = rows.filter(({ s }) => {
    if (filter === 'all') return true;
    if (!s) return false;
    if (filter === 'opened') return s.opens > 0;
    if (filter === 'clicks') return s.clicks > 0;
    return !s.opens && !s.clicks;
  });

  if (!shown.length) {
    const msg = rows.length ? ['Nothing here', 'No emails match this filter.'] : ['No tracked emails yet', 'Send an email from Gmail and it will show up here.'];
    list.replaceChildren(h('div', 'empty', h('div', 'big', icon('eye')), h('strong', null, msg[0]), msg[1]));
    return;
  }

  list.replaceChildren(...shown.map(({ r, s }) => {
    const who = r.to?.[0] || r.subject || '?';
    const color = AVATAR_COLORS[[...who].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
    const avatar = h('div', 'avatar', who[0].toUpperCase());
    avatar.style.background = color;

    const chips = h('div', 'chips');
    if (s) {
      const row = h('div', null);
      row.style.cssText = 'display:flex;gap:4px';
      if (!s.opens && !s.clicks) row.append(h('span', 'chip unopened', icon('clock'), 'Unopened'));
      if (s.opens) row.append(h('span', 'chip opened', icon('eye'), s.opens > 1 ? `${s.opens}×` : 'Opened'));
      if (s.clicks) row.append(h('span', 'chip clicks', icon('click'), s.clicks > 1 ? `${s.clicks}×` : 'Clicked'));
      chips.append(row);
      const last = Math.max(s.lastOpen || 0, s.lastClick || 0);
      if (last) chips.append(h('span', 'when', ago(last)));
    }

    const li = h('li', null, avatar,
      h('div', 'main',
        h('div', 'subj', r.subject || '(no subject)'),
        h('div', 'meta', [r.to?.join(', '), r.sentAt && `sent ${ago(r.sentAt)}`].filter(Boolean).join(' · '))),
      chips);
    li.title = 'Find in Gmail';
    li.addEventListener('click', () => {
      const q = r.subject && r.subject !== '(no subject)' ? `in:sent subject:"${r.subject}"` : 'in:sent';
      chrome.tabs.create({ url: `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(q)}` });
    });
    return li;
  }));
}

(async () => {
  const { tracked = {} } = await chrome.storage.local.get('tracked');
  const recs = Object.values(tracked).filter((r) => r.sentAt).sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0)).slice(0, 100);
  let stats = {};
  if (recs.length) {
    const res = await chrome.runtime.sendMessage({ type: 'stats', ids: recs.map((r) => r.id) });
    if (res?.error) {
      $('error').textContent = res.error;
      $('error').hidden = false;
    }
    stats = res?.stats || {};
  }
  rows = recs.map((r) => ({ r, s: stats[r.id] }));

  const known = rows.filter((x) => x.s);
  const opened = known.filter((x) => x.s.opens).length;
  const clicked = known.filter((x) => x.s.clicks).length;
  $('s-sent').textContent = rows.length;
  $('s-open').textContent = known.length ? `${pct(opened, known.length)}%` : '–';
  $('s-click').textContent = known.length ? `${pct(clicked, known.length)}%` : '–';
  requestAnimationFrame(() => {
    $('b-open').style.width = `${pct(opened, known.length)}%`;
    $('b-click').style.width = `${pct(clicked, known.length)}%`;
  });
  render();
})();
