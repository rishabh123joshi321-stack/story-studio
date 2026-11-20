// Story Studio control app. Plain JavaScript, no build step.
// Talks to the user's own GitHub project; each video request is a small file in jobs/.
'use strict';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('ss_' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ss_' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('ss_' + k); } catch {} },
};

const LENGTHS = {
  short: [['30', '30 seconds'], ['45', '45 seconds'], ['58', '58 seconds (max)']],
  long: [['8', '8 minutes'], ['10', '10 minutes'], ['12', '12 minutes'], ['15', '15 minutes'], ['20', '20 minutes']],
};
const STATUS_TEXT = {
  requested: 'Waiting to start', scripting: 'Writing script', script_ready: 'Script ready', rendering: 'Making video', video_ready: 'Video ready',
  ready: 'Ready to review', approved: 'Approved', scheduled: 'Scheduled', uploaded: 'Uploaded',
  rejected: 'Rejected', failed: 'Needs attention',
};

let format = 'short';

// ---------- helpers ----------
function toast(text) {
  const t = $('toast'); t.textContent = text; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 3000);
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function unb64(b) { const bin = atob(String(b).replace(/\s/g, '')); return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))); }
function b64(str) { const bytes = new TextEncoder().encode(str); let bin = ''; bytes.forEach((b) => { bin += String.fromCharCode(b); }); return btoa(bin); }
function newId() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`; }
function isToday(iso) { return new Date(iso).toDateString() === new Date().toDateString(); }

// ---------- GitHub ----------
const gh = {
  conf() { return { user: store.get('user', ''), repo: store.get('repo', 'story-studio'), token: store.get('token', '') }; },
  ready() { const c = this.conf(); return !!(c.user && c.repo && c.token); },
  async call(path, opts = {}) {
    const c = this.conf();
    const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(c.user)}/${encodeURIComponent(c.repo)}${path}`, {
      ...opts, cache: 'no-store',
      headers: { Authorization: `Bearer ${c.token}`, Accept: opts.accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    if (!res.ok) { const err = new Error(`GitHub said ${res.status}`); err.status = res.status; throw err; }
    return res.status === 204 ? null : (opts.accept && opts.accept.includes('raw') ? res.text() : res.json());
  },
  async test() { return this.call(''); },
  async saveJob(job) {
    return this.call(`/contents/jobs/${job.id}.json`, { method: 'PUT', body: JSON.stringify({ message: `New video request: ${job.topic.slice(0, 60)}`, content: b64(JSON.stringify(job, null, 2) + '\n') }) });
  },
  async getFile(path) {
    try { const f = await this.call(`/contents/${path}`); return { sha: f.sha, data: JSON.parse(unb64(f.content)) }; }
    catch (e) { if (e.status === 404) return null; throw e; }
  },
  async putFile(path, data, message, sha) {
    return this.call(`/contents/${path}`, { method: 'PUT', body: JSON.stringify({ message, content: b64(JSON.stringify(data, null, 2) + '\n'), ...(sha ? { sha } : {}) }) });
  },
  async listJobs() {
    let files;
    try { files = await this.call('/contents/jobs'); } catch (e) { if (e.status === 404) return []; throw e; }
    const wanted = files.filter((f) => f.name.endsWith('.json')).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 40);
    const jobs = await Promise.all(wanted.map((f) => this.call(`/contents/jobs/${encodeURIComponent(f.name)}`, { accept: 'application/vnd.github.raw+json' }).then((t) => JSON.parse(t)).catch(() => null)));
    return jobs.filter(Boolean);
  },
};

const demo = {
  on() { return store.get('demo', false); },
  list() { return store.get('demoJobs', []); },
  save(job) { const all = this.list(); all.unshift(job); store.set('demoJobs', all.slice(0, 60)); },
};

function mode() { return gh.ready() ? 'github' : demo.on() ? 'demo' : 'none'; }

function paintConn() {
  const m = mode(); const p = $('conn');
  p.className = 'pill ' + (m === 'github' ? 'ok' : m === 'demo' ? 'demo' : 'off');
  p.textContent = m === 'github' ? 'Connected' : m === 'demo' ? 'Demo mode' : 'Not connected';
}

// ---------- tabs ----------
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name || (name === 'script' && b.dataset.tab === 'queue')));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('on', s.id === 'tab-' + name));
  if (name !== 'script') store.set('tab', name);
  if (name === 'queue') loadQueue();
  if (name === 'ideas') loadIdeas();
}
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); });

// ---------- new video form ----------
function fillLengths() {
  $('length').innerHTML = LENGTHS[format].map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  $('length').value = format === 'short' ? '45' : '10';
}
$('formatSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  format = b.dataset.v;
  document.querySelectorAll('#formatSeg button').forEach((x) => x.classList.toggle('on', x === b));
  fillLengths();
});

$('jobForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('formMsg'); msg.className = 'msg'; msg.textContent = '';
  if (mode() === 'none') { msg.className = 'msg bad'; msg.textContent = 'Connect your GitHub project in Settings first (or turn on demo mode there).'; return; }
  const job = {
    id: newId(), created: new Date().toISOString(), status: 'requested',
    format, length: Number($('length').value), lengthUnit: format === 'short' ? 'seconds' : 'minutes',
    topic: $('topic').value.trim(), theme: $('theme').value.trim(), tone: $('tone').value,
    audience: $('audience').value, voice: $('voice').value, notes: $('notes').value.trim(),
  };
  if (!job.topic) { msg.className = 'msg bad'; msg.textContent = 'Please type a topic.'; return; }
  store.set('lastVoice', job.voice); store.set('lastTone', job.tone); store.set('lastAudience', job.audience);
  const btn = $('submitBtn'); btn.disabled = true; btn.textContent = 'Sending...';
  try {
    if (mode() === 'github') await gh.saveJob(job); else demo.save(job);
    $('topic').value = ''; $('theme').value = ''; $('notes').value = '';
    msg.className = 'msg ok'; msg.textContent = 'Sent! You can follow it in the Queue tab.';
    toast('Video request sent');
  } catch (err) {
    msg.className = 'msg bad';
    msg.textContent = err.status === 401 || err.status === 403 ? 'Your access key was refused. Check it in Settings.' : 'Could not send. Check your internet and try again. (' + err.message + ')';
  } finally { btn.disabled = false; btn.textContent = 'Start making it'; }
});

// ---------- queue ----------
async function loadQueue() {
  const list = $('queueList');
  if (mode() === 'none') { list.innerHTML = '<div class="card empty">Connect in Settings to see your queue.</div>'; $('dailyBar').innerHTML = ''; return; }
  list.innerHTML = '<div class="card empty">Loading...</div>';
  let jobs;
  try { jobs = mode() === 'github' ? await gh.listJobs() : demo.list(); }
  catch (err) { list.innerHTML = `<div class="card empty">Could not load your queue (${esc(err.message)}).</div>`; return; }
  const today = jobs.filter((j) => isToday(j.created));
  const tL = store.get('tLong', 2), tS = store.get('tShort', 4);
  $('dailyBar').innerHTML = `<div><b>${today.filter((j) => j.format === 'long').length} / ${tL}</b>long videos planned today</div><div><b>${today.filter((j) => j.format === 'short').length} / ${tS}</b>Shorts planned today</div>`;
  if (!jobs.length) { list.innerHTML = '<div class="card empty">Nothing yet. Plan your first video in the New video tab.</div>'; return; }
  queueJobs = jobs;
  list.innerHTML = jobs.map((j) => {
    const cls = ['ready', 'video_ready'].includes(j.status) ? 'ready' : j.status === 'failed' ? 'failed' : j.status === 'script_ready' ? 'scripted' : ['scripting', 'rendering'].includes(j.status) ? 'working' : '';
    const when = new Date(j.created).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    const tap = mode() === 'github' && !['requested', 'failed'].includes(j.status);
    let extra = '';
    if (j.status === 'video_ready') extra = `<div class="meta okline">Video made${j.video_seconds ? ` (${Math.floor(j.video_seconds / 60)}:${String(Math.round(j.video_seconds % 60)).padStart(2, '0')})` : ''}. Tap to watch.</div>`;
    else if (j.status === 'rendering') extra = '<div class="meta">Pictures, voice and music are being made. Short videos take about 10 minutes, long ones up to an hour.</div>';
    else if (j.status === 'script_ready' && j.error) extra = `<div class="meta">Video retrying soon: ${esc(j.error)}</div>`;
    else if (j.status === 'script_ready') extra = j.flags ? `<div class="meta flagnote">${j.flags} fact${j.flags > 1 ? 's' : ''} to check. Tap to read.</div>` : '<div class="meta okline">All facts checked. Tap to read.</div>';
    else if (j.status === 'requested' && j.error) extra = `<div class="meta">Retrying soon: ${esc(j.error)}</div>`;
    else if (j.error) extra = `<div class="meta" style="color:var(--bad)">${esc(j.error)}</div>`;
    if (j.status === 'failed' && mode() === 'github') extra += `<button class="retry" data-id="${esc(j.id)}">Try again</button>`;
    return `<div class="card job${tap ? ' tap' : ''}" data-id="${esc(j.id)}"><div><h3>${esc(j.topic)}</h3><div class="meta">${j.format === 'short' ? 'Short' : 'Long video'} · ${j.length} ${esc(j.lengthUnit)} · ${esc(j.tone)} · ${when}</div>${extra}</div><span class="status ${cls}">${esc(STATUS_TEXT[j.status] || j.status)}</span></div>`;
  }).join('');
}
let queueJobs = [];
$('queueList').addEventListener('click', async (e) => {
  const retry = e.target.closest('button.retry');
  if (retry) {
    e.stopPropagation(); retry.disabled = true; retry.textContent = 'Sending...';
    try {
      const f = await gh.getFile(`jobs/${retry.dataset.id}.json`);
      if (!f) throw new Error('not found');
      const job = { ...f.data, status: f.data.failed_step === 'video' ? 'script_ready' : 'requested' };
      ['error', 'attempts', 'render_attempts', 'failed_step'].forEach((k) => delete job[k]);
      await gh.putFile(`jobs/${job.id}.json`, job, `Try again: ${job.topic.slice(0, 60)}`, f.sha);
      toast('Sent again. Check back in a few minutes.'); loadQueue();
    } catch (err) { toast('Could not send: ' + err.message); retry.disabled = false; retry.textContent = 'Try again'; }
    return;
  }
  const card = e.target.closest('.job.tap'); if (!card) return;
  const job = queueJobs.find((j) => j.id === card.dataset.id);
  if (job && job.status !== 'failed') openScript(job);
});

// ---------- script view ----------
async function openScript(job) {
  showTab('script');
  const v = $('scriptView');
  v.innerHTML = '<div class="card empty">Loading script...</div>';
  let f;
  try { f = await gh.getFile(`scripts/${job.id}.json`); } catch (err) { v.innerHTML = `<div class="card empty">Could not load (${esc(err.message)}).</div>`; return; }
  if (!f) { v.innerHTML = '<div class="card empty">The script is not saved yet. Try again in a few minutes.</div>'; return; }
  const s = f.data;
  const claims = (s.fact_check && s.fact_check.claims) || [];
  const flagged = claims.filter((c) => c.verdict !== 'supported');
  const mins = Math.floor((s.estimated_seconds || 0) / 60), secs = (s.estimated_seconds || 0) % 60;
  v.innerHTML = `
    <h1>${esc(s.working_title || job.topic)}</h1>
    <p class="hint">${job.format === 'short' ? 'Short' : 'Long video'} · ${s.word_count || '?'} words · about ${mins ? mins + ' min ' : ''}${secs} sec · ${(s.scenes || []).length} scenes</p>
    ${job.video ? `<div class="card"><h2>Your video</h2><video class="player ${job.format === 'short' ? 'tall' : ''}" src="${esc(job.video)}" controls playsinline preload="metadata"></video><p class="hint" style="margin-top:8px">Won't play? <a href="${esc(job.video)}" target="_blank" rel="noopener">Open the video file</a>.</p></div>` : ''}
    <div class="card"><h2>Opening hook</h2><p class="hookline">${esc(s.hook)}</p>${s.why_it_matters ? `<p class="hint" style="margin-top:10px">Why it matters: ${esc(s.why_it_matters)}</p>` : ''}</div>
    <div class="card"><h2>Fact check</h2>
      ${flagged.length ? `<p class="flagnote">${flagged.length} thing${flagged.length > 1 ? 's' : ''} for you to check before this becomes a video:</p>` : `<p class="okline">All ${claims.length} facts were backed by the sources.</p>`}
      ${flagged.map((c) => `<div class="fact ${c.verdict === 'wrong' ? 'wrong' : ''}"><b>Scene ${esc(c.scene)}: ${c.verdict === 'wrong' ? 'Probably wrong' : 'Not certain'}</b>${esc(c.claim)}${c.note ? `<div class="meta">${esc(c.note)}</div>` : ''}</div>`).join('')}
      ${s.fact_check && s.fact_check.summary ? `<p class="hint" style="margin-top:10px">${esc(s.fact_check.summary)}</p>` : ''}
    </div>
    <div class="card"><h2>Script</h2>
      ${(s.scenes || []).map((sc, i) => `<div class="scene"><p><span class="n">${i + 1}</span>${esc(sc.narration)}</p><div class="meta">Picture: ${esc(sc.visual)}${sc.motion ? ` (${esc(sc.motion)})` : ''}</div></div>`).join('')}
    </div>
    ${(s.sources || []).length ? `<div class="card"><h2>Sources</h2>${s.sources.map((x) => `<p><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a></p>`).join('')}</div>` : ''}
    <p class="hint">Titles, thumbnails and the Approve button come in the next stages. Nothing is uploaded to YouTube until you approve it.</p>`;
}
$('backToQueue').addEventListener('click', () => showTab('queue'));

// ---------- ideas ----------
let ideaCache = [];
async function loadIdeas() {
  const list = $('ideasList');
  if (mode() !== 'github') { list.innerHTML = '<div class="card empty">Connect your GitHub project in Settings to get ideas.</div>'; return; }
  list.innerHTML = '<div class="card empty">Loading ideas...</div>';
  let f;
  try { f = await gh.getFile('ideas/latest.json'); } catch (err) { list.innerHTML = `<div class="card empty">Could not load ideas (${esc(err.message)}).</div>`; return; }
  if (!f) { list.innerHTML = '<div class="card empty">No ideas yet. Tap <b>Get fresh ideas</b> and check back in about 5 minutes.</div>'; return; }
  ideaCache = f.data.ideas || [];
  const when = new Date(f.data.created).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  list.innerHTML = `<p class="hint">Made ${when}${f.data.focus ? ` · about "${esc(f.data.focus)}"` : ''}</p>` + ideaCache.map((i, n) => `
    <div class="card idea"><span class="score">${i.score}</span>
      <span class="kind">${esc(i.kind)}</span><span class="kind">${i.format === 'long' ? 'Long' : 'Short'}</span>
      <h3>${esc(i.title || i.topic)}</h3>
      <p>${esc(i.angle)}</p>
      <div class="meta">${esc(i.signal)}${i.publish_by ? ` · publish by ${esc(i.publish_by)}` : ''}</div>
      <button class="use" data-n="${n}">Use this</button>
    </div>`).join('');
}
$('ideasList').addEventListener('click', (e) => {
  const b = e.target.closest('button.use'); if (!b) return;
  const i = ideaCache[Number(b.dataset.n)]; if (!i) return;
  const fmt = i.format === 'long' ? 'long' : 'short';
  document.querySelector(`#formatSeg button[data-v="${fmt}"]`).click();
  $('topic').value = i.topic || i.title || ''; $('theme').value = i.angle || '';
  showTab('create'); window.scrollTo(0, 0); toast('Idea added. Check the details, then tap Start making it.');
});
$('refreshIdeas').addEventListener('click', loadIdeas);
$('askIdeas').addEventListener('click', async () => {
  const msg = $('ideasMsg'); msg.className = 'msg';
  if (mode() !== 'github') { msg.className = 'msg bad'; msg.textContent = 'Connect your GitHub project in Settings first.'; return; }
  const btn = $('askIdeas'); btn.disabled = true; btn.textContent = 'Asking...';
  try {
    const old = await gh.getFile('requests/ideas.json');
    await gh.putFile('requests/ideas.json', { requested: new Date().toISOString(), focus: $('ideaFocus').value.trim() }, 'Ask for fresh topic ideas', old && old.sha);
    msg.className = 'msg ok'; msg.textContent = 'Asked! New ideas usually arrive in about 5 minutes. Tap Refresh then.';
  } catch (err) { msg.className = 'msg bad'; msg.textContent = 'Could not ask: ' + err.message; }
  finally { btn.disabled = false; btn.textContent = 'Get fresh ideas'; }
});
$('refreshQueue').addEventListener('click', loadQueue);

// ---------- settings ----------
$('saveConn').addEventListener('click', async () => {
  const msg = $('connMsg'); msg.className = 'msg'; msg.textContent = 'Testing...';
  store.set('user', $('ghUser').value.trim()); store.set('repo', $('ghRepo').value.trim() || 'story-studio');
  const tok = $('ghToken').value.trim(); if (tok) store.set('token', tok);
  if (!gh.ready()) { msg.className = 'msg bad'; msg.textContent = 'Please fill in all three boxes.'; paintConn(); return; }
  try {
    const r = await gh.test();
    if (r.permissions && r.permissions.push === false) throw Object.assign(new Error('read only'), { status: 403 });
    msg.className = 'msg ok'; msg.textContent = 'Connected to ' + r.full_name + '. You are all set.';
    $('ghToken').value = ''; $('ghToken').placeholder = 'Saved on this tablet';
  } catch (err) {
    msg.className = 'msg bad';
    msg.textContent = err.status === 404 ? 'Project not found. Check the username and project name, and that the key was made for this project.'
      : err.status === 401 ? 'The access key is wrong or expired.' : err.status === 403 ? 'The key needs "Contents: Read and write" permission.' : 'Could not reach GitHub: ' + err.message;
  }
  paintConn();
});
$('saveTargets').addEventListener('click', () => { store.set('tLong', Number($('tLong').value) || 0); store.set('tShort', Number($('tShort').value) || 0); toast('Targets saved'); });
$('demoBtn').addEventListener('click', () => { const on = !demo.on(); store.set('demo', on); $('demoBtn').textContent = on ? 'Turn off demo mode' : 'Turn on demo mode'; paintConn(); toast(on ? 'Demo mode on' : 'Demo mode off'); });
$('forgetBtn').addEventListener('click', () => { store.del('token'); $('ghToken').placeholder = 'github_pat_...'; paintConn(); toast('Access key removed from this tablet'); });

// ---------- start ----------
(function init() {
  const c = gh.conf();
  $('ghUser').value = c.user; $('ghRepo').value = c.repo;
  if (c.token) $('ghToken').placeholder = 'Saved on this tablet';
  $('tLong').value = store.get('tLong', 2); $('tShort').value = store.get('tShort', 4);
  $('demoBtn').textContent = demo.on() ? 'Turn off demo mode' : 'Turn on demo mode';
  ['voice', 'tone', 'audience'].forEach((k) => { const v = store.get('last' + k[0].toUpperCase() + k.slice(1)); if (v) $(k).value = v; });
  fillLengths(); paintConn();
  showTab(mode() === 'none' ? 'settings' : store.get('tab', 'create'));
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
