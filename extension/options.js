const $ = (id) => document.getElementById(id);

chrome.storage.sync.get(['baseUrl', 'secret', 'enabled']).then((s) => {
  $('baseUrl').value = s.baseUrl || '';
  $('secret').value = s.secret || '';
  $('enabled').checked = s.enabled !== false;
});

const read = () => ({
  baseUrl: $('baseUrl').value.trim().replace(/\/+$/, ''),
  secret: $('secret').value.trim(),
  enabled: $('enabled').checked,
});

function show(text, ok) {
  $('status').textContent = text;
  $('status').className = ok ? 'ok' : 'err';
}

$('save').addEventListener('click', async () => {
  const s = read();
  if (s.baseUrl && !/^https:\/\//.test(s.baseUrl)) return show('The tracker URL must start with https://', false);
  await chrome.storage.sync.set(s);
  show('Saved. Reload Gmail to apply.', true);
});

$('test').addEventListener('click', async () => {
  show('Testing…', true);
  const res = await chrome.runtime.sendMessage({ type: 'health', settings: read() });
  if (res?.ok) show('Connected.', true);
  else show(res?.error || 'No response', false);
});

$('clear').addEventListener('click', async () => {
  if (!confirm('Remove all tracked emails from this browser? Gmail labels for them will disappear.')) return;
  await chrome.storage.local.remove('tracked');
  show('Tracked-email list cleared.', true);
});
