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
  long: [['10', '10 minutes'], ['20', '20 minutes'], ['30', '30 minutes'], ['40', '40 minutes'], ['45', '45 minutes']],
};
const STATUS_TEXT = {
  requested: 'Waiting to start', scripting: 'Writing script', script_ready: 'Script ready', rendering: 'Making video', video_ready: 'Video ready',
  ready: 'Ready to review', approved: 'Approved', uploading: 'Uploading', scheduled: 'Scheduled', uploaded: 'On YouTube (private)', post_yourself: 'Ready to post', posted: 'Posted',
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
    const all = files.filter((f) => f.name.endsWith('.json')).sort((a, b) => b.name.localeCompare(a.name));
    this.names = all.map((f) => f.name);
    const cache = this._jc || (this._jc = {});  // only files that changed are downloaded again
    const jobs = await Promise.all(all.slice(0, 40).map((f) => (cache[f.name] && cache[f.name].sha === f.sha ? Promise.resolve(cache[f.name].job)
      : this.call(`/contents/jobs/${encodeURIComponent(f.name)}`, { accept: 'application/vnd.github.raw+json' }).then((t) => { const job = JSON.parse(t); cache[f.name] = { sha: f.sha, job }; return job; }).catch(() => null))));
    return jobs.filter(Boolean).map((j) => ({ ...j }));
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
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name || (name === 'script' && b.dataset.tab === 'queue') || (name === 'reviewone' && b.dataset.tab === 'review')));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('on', s.id === 'tab-' + name));
  if (!['script', 'reviewone'].includes(name)) store.set('tab', name);
  if (name === 'home') loadHome();
  if (name === 'queue') loadQueue();
  if (name === 'ideas') loadIdeas();
  if (name === 'review') loadReview();
  if (name === 'stats') loadStats();
  if (name === 'create') { loadSeries(); updatePreview(); }
  if (name === 'money') { loadMoney(); loadGoals(); }
  if (name === 'settings') loadPron();
}
function chapterAt(s, i) {
  const c = (s.chapters || []).find((x) => x.scene === i + 1);
  return c ? `<h3 class="chapter">${esc(c.title)}</h3>` : '';
}
function shotText(s, shots) {
  const places = Object.fromEntries((s.places || []).map((p) => [p.id, p.id.replace(/_/g, ' ')]));
  return shots.map((sh) => {
    if (sh.kind === 'title') return `Title card: ${esc(sh.title)}`;
    if (sh.kind === 'guide') return `Guide${sh.note ? `: “${esc(sh.note)}”` : ''}`;
    const who = (sh.characters || []).map((c) => `${c.id.replace(/_/g, ' ')} ${c.action.replace(/_/g, ' ')}`).join(', ');
    const extra = [sh.effect && sh.effect !== 'none' ? sh.effect : '', sh.time_label, sh.fact ? 'fact card' : ''].filter(Boolean).join(' · ');
    return `${esc(places[sh.place] || sh.place)}${who ? ` — ${esc(who)}` : ''}${extra ? ` (${esc(extra)})` : ''}`;
  }).join('<br>');
}
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); });

// ---------- new video form ----------
// Each dropdown is shown as tap-to-choose chips (the hidden dropdown still holds the value).
function chipify(id) {
  const sel = $(id);
  let box = $(id + 'Chips');
  if (!box) { box = document.createElement('div'); box.id = id + 'Chips'; box.className = 'chips'; sel.after(box); sel.hidden = true;
    box.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; sel.value = b.dataset.v; paintChips(id); }); }
  paintChips(id);
}
function paintChips(id) {
  const sel = $(id);
  $(id + 'Chips').innerHTML = [...sel.options].map((o) => `<button type="button" class="cchip${o.value === sel.value ? ' on' : ''}" data-v="${esc(o.value)}">${esc(o.textContent)}</button>`).join('');
}
function fillLengths() {
  $('length').innerHTML = LENGTHS[format].map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  $('length').value = format === 'short' ? '45' : '40';
  chipify('length');
}
$('formatSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  format = b.dataset.v;
  document.querySelectorAll('#formatSeg button').forEach((x) => x.classList.toggle('on', x === b));
  fillLengths();
  $('kindBox').hidden = format !== 'short';
});
let kind = 'story';
$('kindSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  kind = b.dataset.v;
  document.querySelectorAll('#kindSeg button').forEach((x) => x.classList.toggle('on', x === b));
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
    captionFont: store.get('captionFont', 'Anton'), subtitle_langs: store.get('subLangs', ['hi', 'es']), intro: store.get('intro', true), quote_voice: store.get('quoteVoice', true), pic_pace: store.get('picPace', 'often'),
  };
  if (!job.topic) { msg.className = 'msg bad'; msg.textContent = 'Please type a topic.'; return; }
  if (format === 'short' && kind === 'quiz') job.kind = 'quiz';
  const series = $('series').value.trim();
  if (series) { job.series = series; job.part = (seriesParts[series] || 0) + 1; }
  store.set('lastVoice', job.voice); store.set('lastTone', job.tone); store.set('lastAudience', job.audience);
  const btn = $('submitBtn'); btn.disabled = true; btn.textContent = 'Sending...';
  try {
    if (mode() === 'github') await gh.saveJob(job); else demo.save(job);
    $('topic').value = ''; $('theme').value = ''; $('notes').value = '';
    if (job.series) { seriesParts[job.series] = job.part; paintSeriesHint(); }
    msg.className = 'msg ok'; msg.textContent = 'Sent! You can follow it in the Queue tab.';
    toast('Video request sent');
  } catch (err) {
    msg.className = 'msg bad';
    msg.textContent = err.status === 401 || err.status === 403 ? 'Your access key was refused. Check it in Settings.' : 'Could not send. Check your internet and try again. (' + err.message + ')';
  } finally { btn.disabled = false; btn.textContent = 'Start making it'; }
});

// ---------- series ----------
let seriesParts = {};
async function loadSeries() {
  if (mode() !== 'github') return;
  try {
    const jobs = await gh.listJobs(); seriesParts = {};
    jobs.forEach((j) => { if (j.series) seriesParts[j.series] = Math.max(seriesParts[j.series] || 0, j.part || 1); });
    $('seriesList').innerHTML = Object.keys(seriesParts).map((n) => `<option value="${esc(n)}">`).join(''); paintSeriesHint();
  } catch { /* offline */ }
}
function paintSeriesHint() {
  const n = $('series').value.trim();
  $('seriesHint').textContent = n ? `This will be part ${(seriesParts[n] || 0) + 1} of "${n}". It gets its own playlist on YouTube.` : '';
}
$('series').addEventListener('input', paintSeriesHint);

// ---------- presets (tone presets) ----------
const DEFAULT_PRESETS = [
  { name: 'Epic battle', tone: 'Epic and inspiring', theme: 'turning point', audience: 'General global audience' },
  { name: 'Mystery', tone: 'Dramatic and suspenseful', theme: 'unsolved mystery', audience: 'General global audience' },
  { name: 'Forgotten hero', tone: 'Curious and warm', theme: 'forgotten hero', audience: 'Curious adults new to history' },
  { name: 'Funny fails', tone: 'Light and funny', theme: 'history’s biggest blunders', audience: 'General global audience' },
];
function presets() { return store.get('presets', DEFAULT_PRESETS); }
function paintPresets() {
  $('presetChips').innerHTML = presets().map((p, i) => `<button type="button" class="cchip" data-i="${i}">${esc(p.name)}</button>`).join('');
}
$('presetChips').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]'); if (!b) return;
  const p = presets()[Number(b.dataset.i)]; if (!p) return;
  ['tone', 'audience', 'voice'].forEach((k) => { if (p[k]) { $(k).value = p[k]; paintChips(k); } });
  if (p.theme !== undefined) $('theme').value = p.theme;
  if (p.notes !== undefined) $('notes').value = p.notes;
  document.querySelectorAll('#presetChips .cchip').forEach((x) => x.classList.toggle('on', x === b));
  toast(`Preset "${p.name}" applied`);
});
$('presetChips').addEventListener('contextmenu', (e) => {
  const b = e.target.closest('button[data-i]'); if (!b) return; e.preventDefault();
  const list = presets(); const p = list[Number(b.dataset.i)];
  if (p && window.confirm(`Delete the preset "${p.name}"?`)) { list.splice(Number(b.dataset.i), 1); store.set('presets', list); paintPresets(); }
});
$('savePreset').addEventListener('click', () => {
  const name = (window.prompt('Name for this preset (for example "Epic battle"):') || '').trim().slice(0, 30); if (!name) return;
  const list = presets().filter((p) => p.name !== name);
  list.push({ name, tone: $('tone').value, audience: $('audience').value, voice: $('voice').value, theme: $('theme').value.trim(), notes: $('notes').value.trim() });
  store.set('presets', list); paintPresets(); toast('Preset saved. Long-press a preset to delete it.');
});

// ---------- week planner ----------
$('modeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  document.querySelectorAll('#modeSeg button').forEach((x) => x.classList.toggle('on', x === b));
  const week = b.dataset.v === 'week';
  $('weekPlan').hidden = !week; $('onePlan').hidden = week;
  if (week) loadWeek();
});
let wkIdeas = [], wkLen = '40';
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
async function loadWeek() {
  $('wkLen').innerHTML = LENGTHS.long.map(([v, t]) => `<button type="button" class="cchip${v === wkLen ? ' on' : ''}" data-v="${v}">${t}</button>`).join('');
  const tL = store.get('tLong', 3), tS = store.get('tShort', 3);
  let planned = [];
  try {
    if (mode() === 'github') {
      const f = await gh.getFile('ideas/latest.json'); wkIdeas = (f && f.data.ideas) || [];
      planned = (await gh.listJobs()).filter((j) => j.plan_date);
    }
  } catch { /* planner works without ideas */ }
  $('ideaTopics').innerHTML = wkIdeas.map((i) => `<option value="${esc(i.topic || i.title)}">`).join('');
  const days = [];
  for (let k = 1; k <= 7; k++) { const d = new Date(); d.setDate(d.getDate() + k); days.push(d); }
  $('wkDays').innerHTML = days.map((d) => {
    const day = isoDay(d), have = planned.filter((j) => j.plan_date === day);
    const hl = have.filter((j) => j.format === 'long'), hs = have.filter((j) => j.format === 'short');
    const slot = (fmt, n) => `<div class="slot"><span class="kind">${fmt === 'long' ? 'Long' : 'Short'}</span><input list="ideaTopics" data-day="${day}" data-fmt="${fmt}" placeholder="Topic ${n}"></div>`;
    return `<div class="card wkday"><h2>${esc(d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' }))}</h2>
      ${have.map((j) => `<div class="slot done"><span class="kind">${j.format === 'long' ? 'Long' : 'Short'}</span><span>${esc(j.topic)}</span></div>`).join('')}
      ${Array.from({ length: Math.max(0, tL - hl.length) }, (_, i) => slot('long', i + 1)).join('')}
      ${Array.from({ length: Math.max(0, tS - hs.length) }, (_, i) => slot('short', i + 1)).join('')}</div>`;
  }).join('');
}
$('wkLen').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; wkLen = b.dataset.v; document.querySelectorAll('#wkLen .cchip').forEach((x) => x.classList.toggle('on', x === b)); });
$('wkFill').addEventListener('click', () => {
  const used = new Set([...document.querySelectorAll('#wkDays input')].map((i) => i.value.trim()).filter(Boolean));
  const pool = { long: wkIdeas.filter((i) => i.format === 'long'), short: wkIdeas.filter((i) => i.format !== 'long') };
  let filled = 0;
  document.querySelectorAll('#wkDays input').forEach((inp) => {  // anniversaries go on their exact day first
    if (inp.value.trim()) return;
    const ann = wkIdeas.find((i) => i.kind === 'anniversary' && i.publish_by === inp.dataset.day && !used.has(i.topic || i.title) && (i.format === 'long') === (inp.dataset.fmt === 'long'))
      || wkIdeas.find((i) => i.kind === 'anniversary' && i.publish_by === inp.dataset.day && !used.has(i.topic || i.title));
    if (!ann) return;
    inp.value = ann.topic || ann.title; inp.dataset.angle = ann.angle || ''; used.add(inp.value); filled++;
  });
  document.querySelectorAll('#wkDays input').forEach((inp) => {
    if (inp.value.trim()) return;
    const list = pool[inp.dataset.fmt].length ? pool[inp.dataset.fmt] : wkIdeas;
    const pick = list.find((i) => !used.has(i.topic || i.title)); if (!pick) return;
    inp.value = pick.topic || pick.title; inp.dataset.angle = pick.angle || ''; used.add(inp.value); filled++;
  });
  toast(filled ? `Filled ${filled} box${filled > 1 ? 'es' : ''}. Change any you don't like.` : 'No more ideas. Ask for fresh ones in the Ideas tab.');
});
$('wkSave').addEventListener('click', async () => {
  const msg = $('wkMsg'); msg.className = 'msg';
  if (mode() === 'none') { msg.className = 'msg bad'; msg.textContent = 'Connect your GitHub project in Settings first.'; return; }
  const items = [...document.querySelectorAll('#wkDays input')].filter((i) => i.value.trim());
  if (!items.length) { msg.className = 'msg bad'; msg.textContent = 'Type at least one topic.'; return; }
  const btn = $('wkSave'); btn.disabled = true;
  let n = 0;
  try {
    for (const inp of items) {
      btn.textContent = `Saving ${n + 1} of ${items.length}...`;
      const fmt = inp.dataset.fmt;
      const job = { id: newId(), created: new Date().toISOString(), status: 'requested', plan_date: inp.dataset.day,
        format: fmt, length: fmt === 'long' ? Number(wkLen) : 58, lengthUnit: fmt === 'short' ? 'seconds' : 'minutes',
        topic: inp.value.trim(), theme: inp.dataset.angle || '', tone: $('tone').value, audience: $('audience').value, voice: $('voice').value,
        notes: '', captionFont: store.get('captionFont', 'Anton'), subtitle_langs: store.get('subLangs', ['hi', 'es']), intro: store.get('intro', true), quote_voice: store.get('quoteVoice', true), pic_pace: store.get('picPace', 'often') };
      if (mode() === 'github') await gh.saveJob(job); else demo.save(job);
      n++; await new Promise((r) => setTimeout(r, 1100));
    }
    msg.className = 'msg ok'; msg.textContent = `Planned ${n} video${n > 1 ? 's' : ''}. They appear in the Queue with their dates.`;
    toast('Week planned'); loadWeek();
  } catch (err) { msg.className = 'msg bad'; msg.textContent = `Saved ${n}, then stopped: ${err.message}. Tap Save again for the rest.`; loadWeek(); }
  finally { btn.disabled = false; btn.textContent = "Save the week's plan"; }
});

// ---------- queue ----------
async function loadQueue(quiet) {
  const list = $('queueList');
  if (mode() === 'none') { list.innerHTML = '<div class="card empty">Connect in Settings to see your queue.</div>'; $('dailyBar').innerHTML = ''; return; }
  if (quiet !== true) list.innerHTML = '<div class="card empty">Loading...</div>';
  let jobs;
  try { jobs = mode() === 'github' ? await gh.listJobs() : demo.list(); }
  catch (err) { list.innerHTML = `<div class="card empty">Could not load your queue (${esc(err.message)}).</div>`; return; }
  const today = jobs.filter((j) => dayOf(j) === isoDay(new Date()) && !j.parent_id && j.status !== 'rejected');
  const tL = store.get('tLong', 3), tS = store.get('tShort', 3);
  $('dailyBar').innerHTML = `<div><b>${today.filter((j) => j.format === 'long').length} / ${tL}</b>long videos planned today</div><div><b>${today.filter((j) => j.format === 'short').length} / ${tS}</b>Shorts planned today</div>`;
  if (!jobs.length) { list.innerHTML = '<div class="card empty">Nothing yet. Plan your first video in the New video tab.</div>'; return; }
  queueJobs = jobs;
  paintReviewCount(jobs);
  celebrate(jobs);
  $('qLive').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const f = store.get('qFilter', 'all');
  const groups = { work: ['requested', 'scripting', 'script_ready', 'rendering', 'video_ready', 'approved', 'uploading'], ready: ['ready', 'post_yourself'], done: ['uploaded', 'posted', 'rejected'], failed: ['failed'] };
  const shown = f === 'all' ? jobs : jobs.filter((j) => (groups[f] || []).includes(j.status));
  $('qFilters').innerHTML = [['all', 'All'], ['work', 'In progress'], ['ready', 'Needs you'], ['done', 'Done'], ['failed', 'Problems']]
    .map(([k, t]) => { const n = k === 'all' ? jobs.length : jobs.filter((j) => groups[k].includes(j.status)).length; return `<button type="button" class="cchip${k === f ? ' on' : ''}" data-f="${k}">${t} <span class="cnt">${n}</span></button>`; }).join('');
  if (store.get('qView', 'list') === 'board') { $('qFilters').style.display = 'none'; list.innerHTML = boardHTML(jobs); return; }
  $('qFilters').style.display = '';
  if (!shown.length) { list.innerHTML = '<div class="card empty">Nothing here.</div>'; return; }
  setTimeout(() => list.querySelectorAll('.thlink').forEach(async (a) => {  // show the picked thumbnail as a download link
    try { if (!pkgCache[a.dataset.id]) { const f = await gh.getFile(`packages/${a.dataset.id}.json`); pkgCache[a.dataset.id] = f && f.data; }
      const t = pkgCache[a.dataset.id] && pkgCache[a.dataset.id].thumbnail; if (t) { a.href = t; a.hidden = false; } } catch { /* no thumbnail */ }
  }) || list.querySelectorAll('.sublinks').forEach(async (sp) => {  // subtitle files, one link per language
    try { if (!pkgCache[sp.dataset.id]) { const f = await gh.getFile(`packages/${sp.dataset.id}.json`); pkgCache[sp.dataset.id] = f && f.data; }
      const subs = (pkgCache[sp.dataset.id] && pkgCache[sp.dataset.id].subtitles) || {};
      sp.innerHTML = Object.entries(subs).map(([l, u]) => `<a class="btnlink" href="${esc(u)}" download>Subtitles ${esc(SUB_LANGS[l] || l)}</a>`).join('');
    } catch { /* none yet */ }
  }), 0);
  list.innerHTML = shown.map((j) => {
    const cls = ['ready', 'video_ready', 'uploaded', 'post_yourself', 'posted'].includes(j.status) ? 'ready' : j.status === 'failed' ? 'failed' : j.status === 'script_ready' ? 'scripted' : ['scripting', 'rendering', 'uploading', 'approved'].includes(j.status) ? 'working' : '';
    const when = new Date(j.created).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    const tap = mode() === 'github' && !['requested', 'failed', 'uploaded', 'post_yourself', 'posted'].includes(j.status);
    let extra = '';
    if (j.status === 'ready') extra = `<div class="meta okline">${j.title ? esc(j.title) + '. ' : ''}Video, title and description are ready. Tap to see.</div>`;
    else if (j.status === 'video_ready') extra = `<div class="meta okline">Video made${j.video_seconds ? ` (${Math.floor(j.video_seconds / 60)}:${String(Math.round(j.video_seconds % 60)).padStart(2, '0')})` : ''}. Tap to watch.</div>`;
    else if (j.status === 'uploaded') extra = `<div class="meta okline">On YouTube as Private. <a href="${esc(j.youtube_studio || j.youtube_url)}" target="_blank" rel="noopener">Open in YouTube Studio</a> to make it Public or schedule it.</div>${j.note ? `<div class="meta">${esc(j.note)}</div>` : ''}`;
    else if (j.status === 'post_yourself') extra = '<div class="meta okline">Approved. Post it from the YouTube app:</div>';
    else if (j.status === 'posted') extra = '<div class="meta okline">Posted on YouTube.</div>';
    else if (j.status === 'approved' && j.error) extra = `<div class="meta flagnote">Upload waiting: ${esc(j.error)}</div>`;
    else if (j.status === 'approved') extra = '<div class="meta">Approved. It will be uploaded to YouTube (as Private) within a few minutes.</div>';
    else if (j.status === 'uploading') extra = '<div class="meta">Sending to YouTube now. Long videos can take 10 to 20 minutes.</div>';
    else if (j.status === 'rendering') extra = '<div class="meta">Pictures, voice and music are being made. Short videos take about 10 minutes, long ones up to an hour.</div>';
    else if (j.status === 'script_ready' && j.error) extra = `<div class="meta">Video retrying soon: ${esc(j.error)}</div>`;
    else if (j.status === 'script_ready') extra = j.flags ? `<div class="meta flagnote">${j.flags} fact${j.flags > 1 ? 's' : ''} to check. Tap to read.</div>` : '<div class="meta okline">All facts checked. Tap to read.</div>';
    else if (j.status === 'requested' && j.plan_date && j.plan_date > isoDay(new Date())) extra = `<div class="meta">Planned for ${esc(new Date(j.plan_date + 'T12:00').toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' }))}. It starts the day before.</div>`;
    else if (j.status === 'requested' && j.error) extra = `<div class="meta">Retrying soon: ${esc(j.error)}</div>`;
    else if (j.error) extra = `<div class="meta" style="color:var(--bad)">${esc(j.error)}</div>`;
    if (['post_yourself', 'uploaded'].includes(j.status) && mode() === 'github') extra += postHelper(j);
    if (j.status === 'failed' && mode() === 'github') extra += `<button class="retry" data-id="${esc(j.id)}">Try again</button>`;
    if (mode() === 'github') extra += `<button class="vdel danger" data-id="${esc(j.id)}">Delete video</button>`;
    return `<div class="card job${tap ? ' tap' : ''}" data-id="${esc(j.id)}"><div class="jmain">${stepper(j.status)}<h3>${esc(j.topic)}</h3><div class="meta">${j.series ? `<span class="kind">${esc(j.series)} · Part ${esc(j.part || 1)}</span>` : ''}${j.format === 'short' ? 'Short' : 'Long video'} · ${j.length} ${esc(j.lengthUnit)} · ${esc(j.tone)} · ${when}</div>${extra}</div><span class="status ${cls}">${esc(STATUS_TEXT[j.status] || j.status)}</span></div>`;
  }).join('');
}
let queueJobs = [];
const STEPS = ['Script', 'Video', 'Review', 'YouTube'];
function stepAt(st) {
  return { requested: 0, scripting: 0, script_ready: 1, rendering: 1, video_ready: 1, ready: 2, approved: 3, uploading: 3, post_yourself: 3, uploaded: 4, posted: 4 }[st];
}
function stepper(st) {
  const at = stepAt(st); if (at === undefined) return '';
  return `<div class="steps">${STEPS.map((n, i) => `<span class="${i < at ? 'done' : i === at ? 'now' : ''}">${n}</span>`).join('')}</div>`;
}
// The "Today" card: what needs you now, and yesterday's numbers.
async function paintToday(jobs) {
  const el = $('todayCard'); if (!el) return;
  const review = jobs.filter((j) => j.status === 'ready').length, post = jobs.filter((j) => j.status === 'post_yourself').length;
  const making = jobs.filter((j) => ['requested', 'scripting', 'script_ready', 'rendering', 'video_ready'].includes(j.status)).length;
  const problems = jobs.filter((j) => j.status === 'failed').length;
  const hr = new Date().getHours(), hello = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  const todo = [review && `<b>${review}</b> to review`, post && `<b>${post}</b> to post`, problems && `<b>${problems}</b> need${problems > 1 ? '' : 's'} attention`].filter(Boolean);
  let numbers = '';
  try {
    const h = mode() === 'github' ? await gh.getFile('stats/history.json') : null; const rows = (h && h.data) || [];
    if (rows.length >= 2) { const a = rows[rows.length - 2], b = rows[rows.length - 1]; numbers = `<div class="tnum"><span>+${fmtN(Math.max(0, b.views - a.views))} views</span><span>${b.subscribers - a.subscribers >= 0 ? '+' : ''}${fmtN(b.subscribers - a.subscribers)} subscribers</span><span class="tmut">since yesterday</span></div>`; }
  } catch { /* stats not ready yet */ }
  el.innerHTML = `<div class="k">${hello}</div><div class="tline">${todo.length ? todo.join(' · ') : 'Nothing waiting for you right now.'}</div>
    <div class="tmut">${making ? `${making} video${making > 1 ? 's' : ''} being made` : 'Nothing being made'}</div>${numbers}`;
}
// "Post it yourself": until Google's audit passes, videos sent by the app are locked Private,
// so the owner posts them from the YouTube app with these buttons.
function postHelper(j) {
  return `<div class="posthelp">
    ${j.status === 'post_yourself' ? '<p class="meta">1. Download the video. 2. In the YouTube app tap + then Upload a video and pick it. 3. Paste the title and description, and add the tags under Add tags (or Show more). 4. Tap I posted it.</p>' : '<p class="meta">This copy is locked Private by Google. To publish now, download it and post it from the YouTube app, then delete the locked copy in Studio.</p>'}
    ${j.video ? `<a class="btnlink" href="${esc(j.video)}" download>Download video</a>` : ''}
    <button class="pcopy" data-id="${esc(j.id)}" data-what="title">Copy title</button>
    <button class="pcopy" data-id="${esc(j.id)}" data-what="description">Copy description</button>
    <button class="pcopy" data-id="${esc(j.id)}" data-what="tags">Copy tags</button>
    <button class="pcopy" data-id="${esc(j.id)}" data-what="pinned_comment">Copy pinned comment</button>
    <span class="sublinks" data-id="${esc(j.id)}"></span>
    ${j.format === 'long' ? `<a class="btnlink thlink" data-id="${esc(j.id)}" href="#" target="_blank" rel="noopener" hidden>Thumbnail</a>` : ''}
    ${j.status === 'post_yourself' ? `<button class="pdone primary" data-id="${esc(j.id)}">I posted it</button>` : ''}
  </div>`;
}
const pkgCache = {};
async function copyPkg(id, what) {
  if (!pkgCache[id]) { const f = await gh.getFile(`packages/${id}.json`); if (!f) throw new Error('details not found'); pkgCache[id] = f.data; }
  const p = pkgCache[id];
  const text = what === 'tags' ? (p.tags || []).join(', ') : String(p[what] || '');
  await navigator.clipboard.writeText(text);
}
$('qFilters').addEventListener('click', (e) => { const b = e.target.closest('button[data-f]'); if (b) { store.set('qFilter', b.dataset.f); loadQueue(); } });
$('queueList').addEventListener('click', async (e) => {
  const pc = e.target.closest('button.pcopy');
  if (pc) {
    e.stopPropagation();
    try { await copyPkg(pc.dataset.id, pc.dataset.what); pc.textContent = 'Copied'; toast('Copied. Paste it in the YouTube app.'); }
    catch (err) { toast('Could not copy: ' + err.message); }
    return;
  }
  const pd = e.target.closest('button.pdone');
  if (pd) {
    e.stopPropagation(); pd.disabled = true;
    try {
      const f = await gh.getFile(`jobs/${pd.dataset.id}.json`);
      await gh.putFile(`jobs/${pd.dataset.id}.json`, { ...f.data, status: 'posted', posted: new Date().toISOString() }, `Posted: ${f.data.topic.slice(0, 60)}`, f.sha);
      toast('Marked as posted.'); loadQueue();
    } catch (err) { toast('Could not save: ' + err.message); pd.disabled = false; }
    return;
  }
  const del = e.target.closest('button.vdel');
  if (del) {
    e.stopPropagation();
    if (!del.dataset.sure) { del.dataset.sure = '1'; del.textContent = 'Tap again to delete for good'; del.classList.add('danger-bg'); setTimeout(() => { if (del.isConnected) { delete del.dataset.sure; del.textContent = 'Delete video'; del.classList.remove('danger-bg'); } }, 5000); return; }
    del.disabled = true; del.textContent = 'Deleting...';
    try { await deleteVideo(del.dataset.id); toast('Deleted from the app. A copy already on YouTube stays there.'); loadQueue(); }
    catch (err) { toast('Could not delete: ' + err.message); del.disabled = false; del.textContent = 'Delete video'; }
    return;
  }
  const retry = e.target.closest('button.retry');
  if (retry) {
    e.stopPropagation(); retry.disabled = true; retry.textContent = 'Sending...';
    try {
      const f = await gh.getFile(`jobs/${retry.dataset.id}.json`);
      if (!f) throw new Error('not found');
      const job = { ...f.data, status: { video: 'script_ready', package: 'video_ready', upload: 'approved' }[f.data.failed_step] || 'requested' };
      ['error', 'attempts', 'render_attempts', 'package_attempts', 'upload_attempts', 'failed_step'].forEach((k) => delete job[k]);
      await gh.putFile(`jobs/${job.id}.json`, job, `Try again: ${job.topic.slice(0, 60)}`, f.sha);
      toast('Sent again. Check back in a few minutes.'); loadQueue();
    } catch (err) { toast('Could not send: ' + err.message); retry.disabled = false; retry.textContent = 'Try again'; }
    return;
  }
  const card = e.target.closest('.job.tap'); if (!card) return;
  const job = queueJobs.find((j) => j.id === card.dataset.id);
  if (job && job.status === 'ready') openReview(job.id);
  else if (job && job.status !== 'failed') openScript(job);
});

// Script score (from the fact-check pass): hook, pacing, clarity out of 10, plus a tip and a stronger opening.
function scoreCard(s, withUse) {
  const sc = s.fact_check && s.fact_check.score; if (!sc) return '';
  const avg = Math.round(((sc.hook + sc.pacing + sc.clarity) / 3) * 10) / 10;
  const bar = (n, v) => `<div class="meter"><div class="mrow"><span>${n}</span><b>${v} / 10</b></div><div class="mbar"><i style="width:${v * 10}%"></i></div></div>`;
  return `<div class="card"><h2>Script score <span class="scorebig">${avg}</span></h2>${bar('Hook', sc.hook)}${bar('Pacing', sc.pacing)}${bar('Clarity', sc.clarity)}
    ${sc.tip ? `<p class="hint" style="margin-top:10px">Tip: ${esc(sc.tip)}</p>` : ''}
    ${sc.better_hook ? `<p class="hint">Stronger opening idea:</p><p class="hookline">“${esc(sc.better_hook)}”</p>${withUse ? '<button type="button" id="useHook">Rewrite with this opening</button>' : ''}` : ''}</div>`;
}

// ---------- script view ----------
async function openScript(job) {
  showTab('script');
  const v = $('scriptView');
  v.innerHTML = '<div class="card empty">Loading script...</div>';
  let f;
  try { f = await gh.getFile(`scripts/${job.id}.json`); } catch (err) { v.innerHTML = `<div class="card empty">Could not load (${esc(err.message)}).</div>`; return; }
  if (!f) { v.innerHTML = '<div class="card empty">The script is not saved yet. Try again in a few minutes.</div>'; return; }
  const s = f.data;
  let pkg = null;
  try { const p = await gh.getFile(`packages/${job.id}.json`); pkg = p && p.data; } catch { /* packaging not ready yet */ }
  const claims = (s.fact_check && s.fact_check.claims) || [];
  const flagged = claims.filter((c) => c.verdict !== 'supported');
  const mins = Math.floor((s.estimated_seconds || 0) / 60), secs = (s.estimated_seconds || 0) % 60;
  v.innerHTML = `
    <h1>${esc(s.working_title || job.topic)}</h1>
    <p class="hint">${job.format === 'short' ? 'Short' : 'Long video'} · ${s.word_count || '?'} words · about ${mins ? mins + ' min ' : ''}${secs} sec · ${(s.scenes || []).length} scenes</p>
    ${job.video ? `<div class="card"><h2>Your video</h2><video class="player ${job.format === 'short' ? 'tall' : ''}" src="${esc(job.video)}" controls playsinline preload="metadata"></video><p class="hint" style="margin-top:8px">Won't play? <a href="${esc(job.video)}" target="_blank" rel="noopener">Open the video file</a>.</p></div>` : ''}
    ${pkg ? `<div class="card"><h2>YouTube details</h2>
      ${pkg.thumbnail ? `<img class="thumb" src="${esc(pkg.thumbnail)}" alt="Thumbnail">` : `<p class="hint">${esc(pkg.thumbnail_note || '')}</p>`}
      <label>Title</label><p class="ytitle">${esc(pkg.title)}</p>
      ${(pkg.title_options || []).filter((t) => t !== pkg.title).length ? `<p class="hint">Other options: ${pkg.title_options.filter((t) => t !== pkg.title).map(esc).join(' · ')}</p>` : ''}
      <label>Description</label><div class="desc">${esc(pkg.description)}</div>
      <label>Tags</label><div class="tags">${(pkg.tags || []).map((t) => `<span class="kind">${esc(t)}</span>`).join('')}</div>
    </div>` : ''}
    ${scoreCard(s, false)}
    <div class="card"><h2>Opening hook</h2><p class="hookline">${esc(s.hook)}</p>${s.why_it_matters ? `<p class="hint" style="margin-top:10px">Why it matters: ${esc(s.why_it_matters)}</p>` : ''}</div>
    <div class="card"><h2>Fact check</h2>
      ${flagged.length ? `<p class="flagnote">${flagged.length} thing${flagged.length > 1 ? 's' : ''} for you to check before this becomes a video:</p>` : `<p class="okline">All ${claims.length} facts were backed by the sources.</p>`}
      ${flagged.map((c) => `<div class="fact ${c.verdict === 'wrong' ? 'wrong' : ''}"><b>Scene ${esc(c.scene)}: ${c.verdict === 'wrong' ? 'Probably wrong' : 'Not certain'}</b>${esc(c.claim)}${c.note ? `<div class="meta">${esc(c.note)}</div>` : ''}</div>`).join('')}
      ${s.fact_check && s.fact_check.summary ? `<p class="hint" style="margin-top:10px">${esc(s.fact_check.summary)}</p>` : ''}
    </div>
    <div class="card"><h2>Script</h2>
      ${(s.scenes || []).map((sc, i) => `${chapterAt(s, i)}<div class="scene"><p><span class="n">${i + 1}</span>${esc(sc.narration)}</p><div class="meta">${sc.shots ? shotText(s, sc.shots) : `Picture: ${esc(sc.visual)}`}</div></div>`).join('')}
    </div>
    ${(s.sources || []).length ? `<div class="card"><h2>Sources</h2>${s.sources.map((x) => `<p><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a></p>`).join('')}</div>` : ''}
    <p class="hint">The Approve, Edit, Regenerate and Reject buttons come in the next stage. Nothing is uploaded to YouTube until you approve it.</p>`;
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
  const anns = ideaCache.filter((i) => i.kind === 'anniversary' && /^\d{4}-\d{2}-\d{2}$/.test(i.publish_by || '')).sort((a, b) => a.publish_by.localeCompare(b.publish_by));
  const strip = anns.length ? `<div class="card"><h2>On this day: coming up</h2><p class="hint">Stories with anniversaries soon. Videos posted on the exact day get extra searches.</p><div class="annstrip">${anns.map((i) => {
    const d = new Date(i.publish_by + 'T12:00');
    return `<button type="button" class="ann" data-n="${ideaCache.indexOf(i)}"><span class="ad">${d.toLocaleDateString([], { day: 'numeric' })}</span><span class="am">${d.toLocaleDateString([], { month: 'short', weekday: 'short' })}</span><span class="at">${esc(i.topic || i.title)}</span>${Number(i.years_ago) > 0 ? `<span class="ay">${esc(i.years_ago)} years</span>` : ''}</button>`;
  }).join('')}</div></div>` : '';
  list.innerHTML = `<p class="hint">Made ${when}${f.data.focus ? ` · about "${esc(f.data.focus)}"` : ''}</p>` + strip + '<div id="ideaCards">' + ideaCache.map((i, n) => `
    <div class="card idea"><span class="score">${i.score}</span>
      <span class="kind">${esc(i.kind)}</span><span class="kind">${i.format === 'long' ? 'Long' : 'Short'}</span>
      <h3>${esc(i.title || i.topic)}</h3>
      <p>${esc(i.angle)}</p>
      <div class="meta">${esc(i.signal)}${i.publish_by ? ` · publish by ${esc(i.publish_by)}` : ''}</div>
      <button class="use" data-n="${n}">Use this</button>
    </div>`).join('') + '</div>';
  paintIdeaMode();
}
$('ideasList').addEventListener('click', (e) => {
  const b = e.target.closest('button.use, button.ann'); if (!b) return;
  const i = ideaCache[Number(b.dataset.n)]; if (i) useIdea(i);
});
function useIdea(i) {
  $('modeSeg').querySelector('[data-v="one"]').click();
  const fmt = i.format === 'long' ? 'long' : 'short';
  document.querySelector(`#formatSeg button[data-v="${fmt}"]`).click();
  $('topic').value = i.topic || i.title || ''; $('theme').value = i.angle || '';
  showTab('create'); window.scrollTo(0, 0); toast('Idea added. Check the details, then tap Start making it.');
}
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

// ---------- review ----------
function paintReviewCount(jobs) {
  const n = jobs.filter((j) => j.status === 'ready').length;
  document.querySelector('.tabs button[data-tab="review"] span').textContent = n ? `Review (${n})` : 'Review';
}
function fmtLen(sec) { sec = Math.round(sec || 0); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }

async function loadReview() {
  const list = $('reviewList');
  if (mode() !== 'github') { list.innerHTML = '<div class="card empty">Connect your GitHub project in Settings first.</div>'; return; }
  list.innerHTML = '<div class="card empty">Loading...</div>';
  let jobs;
  try { jobs = await gh.listJobs(); } catch (err) { list.innerHTML = `<div class="card empty">Could not load (${esc(err.message)}).</div>`; return; }
  queueJobs = jobs; paintReviewCount(jobs);
  const ready = jobs.filter((j) => j.status === 'ready');
  const waiting = jobs.filter((j) => ['requested', 'scripting', 'script_ready', 'rendering', 'video_ready'].includes(j.status)).length;
  list.innerHTML = (ready.length ? ready.map((j) => `
    <div class="card job tap" data-id="${esc(j.id)}"><div><h3>${esc(j.title || j.topic)}</h3>
      <div class="meta">${j.format === 'short' ? 'Short' : 'Long video'} · ${fmtLen(j.video_seconds)} · ${esc(j.topic)}</div>
      ${j.flags ? `<div class="meta flagnote">${j.flags} fact${j.flags > 1 ? 's' : ''} to check</div>` : '<div class="meta okline">Facts checked</div>'}
    </div><span class="status ready">Review</span></div>`).join('')
    : '<div class="card empty">Nothing to review right now.</div>')
    + (waiting ? `<p class="hint">${waiting} more video${waiting > 1 ? 's are' : ' is'} being made. See the Queue tab.</p>` : '');
}
$('reviewList').addEventListener('click', (e) => {
  const card = e.target.closest('.job.tap'); if (!card) return;
  const job = queueJobs.find((j) => j.id === card.dataset.id); if (job) openReview(job.id);
});
$('refreshReview').addEventListener('click', loadReview);
$('backToReview').addEventListener('click', () => showTab('review'));

let rv = null; // the video being reviewed: { job, jobSha, pkg, pkgSha, script }
async function openReview(id) {
  showTab('reviewone');
  const v = $('reviewView');
  v.innerHTML = '<div class="card empty">Loading...</div>';
  try {
    const [jf, pf, sf] = await Promise.all([gh.getFile(`jobs/${id}.json`), gh.getFile(`packages/${id}.json`), gh.getFile(`scripts/${id}.json`)]);
    if (!jf || !pf) throw new Error('this video is not ready yet');
    rv = { job: jf.data, jobSha: jf.sha, pkg: pf.data, pkgSha: pf.sha, script: sf ? sf.data : {} };
  } catch (err) { v.innerHTML = `<div class="card empty">Could not load (${esc(err.message)}).</div>`; return; }
  const { job, pkg, script } = rv;
  const flagged = ((script.fact_check && script.fact_check.claims) || []).filter((c) => c.verdict !== 'supported');
  const others = (pkg.title_options || []).filter((t) => t !== pkg.title);
  v.innerHTML = `
    <h1>${esc(pkg.title)}</h1>
    <p class="hint">${job.format === 'short' ? 'Short' : 'Long video'} · ${fmtLen(job.video_seconds)} · ${esc(job.topic)}</p>
    <div class="card"><video class="player ${job.format === 'short' ? 'tall' : ''}" src="${esc(job.video)}" controls playsinline preload="metadata"></video>
      <p class="hint" style="margin-top:8px">Won't play? <a href="${esc(job.video)}" target="_blank" rel="noopener">Open the video file</a>.</p></div>
    ${pkg.thumbnail ? `<div class="card"><h2>Thumbnail</h2>${(pkg.thumbnail_options || []).length > 1
      ? `<p class="hint">Tap the one you like best.</p><div class="thumbs">${pkg.thumbnail_options.map((u) => `<button type="button" class="thpick${u === pkg.thumbnail ? ' on' : ''}" data-u="${esc(u)}"><img src="${esc(u)}" alt="Thumbnail choice" loading="lazy"></button>`).join('')}</div>`
      : `<img class="thumb" src="${esc(pkg.thumbnail)}" alt="Thumbnail">`}</div>` : ''}
    ${scoreCard(script, true)}
    ${flagged.length ? `<div class="card"><h2>Facts to check</h2>${flagged.map((c) => `<div class="fact ${c.verdict === 'wrong' ? 'wrong' : ''}"><b>Scene ${esc(c.scene)}: ${c.verdict === 'wrong' ? 'Probably wrong' : 'Not certain'}</b>${esc(c.claim)}${c.note ? `<div class="meta">${esc(c.note)}</div>` : ''}</div>`).join('')}
      <p class="hint">If something is wrong, tap <b>Regenerate</b> and choose "Rewrite the script", telling it what to fix.</p></div>` : ''}
    <div class="card"><h2>YouTube details</h2>
      <label for="rvTitle">Title <span class="req" id="rvTitleCount"></span></label>
      <input id="rvTitle" maxlength="100" value="${esc(pkg.title)}">
      ${others.length ? `<div class="tags" style="margin-top:8px">${others.map((t) => `<button type="button" class="chip" data-t="${esc(t)}">${esc(t)}</button>`).join('')}</div><p class="hint">Tap another title to use it.</p>` : ''}
      <label for="rvDesc">Description</label>
      <textarea id="rvDesc" rows="10">${esc(pkg.description)}</textarea>
      <label for="rvTags">Tags (separate with commas)</label>
      <textarea id="rvTags" rows="3">${esc((pkg.tags || []).join(', '))}</textarea>
      <label for="rvPin">Pinned comment <span class="req">post it yourself and tap Pin</span></label>
      <textarea id="rvPin" rows="2">${esc(pkg.pinned_comment || '')}</textarea>
      <button id="rvSave">Save changes</button>
    </div>
    <div class="card">
      ${flagged.length ? `<label class="check"><input type="checkbox" id="rvChecked"> I have checked the ${flagged.length} flagged fact${flagged.length > 1 ? 's' : ''}</label>` : ''}
      <button class="primary" id="rvApprove">Approve</button>
      <div class="row" style="margin-top:4px"><button id="rvRegen" style="flex:1">Regenerate</button><button id="rvReject" class="danger" style="flex:1">Reject</button></div>
      <div id="rvRegenBox" class="sub" hidden>
        <h2>What should be redone?</h2>
        <label class="check"><input type="radio" name="regen" value="pictures" checked> New pictures (same script and voice)</label>
        <label class="check"><input type="radio" name="regen" value="package"> New title, description and thumbnail</label>
        <label class="check"><input type="radio" name="regen" value="script"> Rewrite the script and make a new video</label>
        <label for="rvNotes">What should change? (optional, used for a rewrite)</label>
        <textarea id="rvNotes" rows="3" placeholder="e.g. fix the date in scene 4, add more about the aftermath, make the start more dramatic"></textarea>
        <button class="primary" id="rvRegenGo">Redo it</button>
      </div>
      <div id="rvRejectBox" class="sub" hidden>
        <label for="rvReason">Why? (optional, helps future ideas)</label>
        <input id="rvReason" placeholder="e.g. topic not interesting, too similar to another video">
        <button class="primary danger-bg" id="rvRejectGo">Reject this video</button>
      </div>
      <p id="rvMsg" class="msg"></p>
    </div>`;
  const count = () => { $('rvTitleCount').textContent = `${$('rvTitle').value.length}/100`; };
  $('rvTitle').addEventListener('input', count); count();
  v.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => { $('rvTitle').value = b.dataset.t; count(); }));
  $('rvSave').addEventListener('click', () => reviewAct('save'));
  $('rvApprove').addEventListener('click', () => reviewAct('approve'));
  if ($('useHook')) $('useHook').addEventListener('click', () => {
    $('rvRegenBox').hidden = false;
    const r = document.querySelector('input[name="regen"][value="script"]'); if (r) r.checked = true;
    $('rvNotes').value = `Start with this opening line: "${script.fact_check.score.better_hook}"`;
    $('rvNotes').scrollIntoView({ behavior: 'smooth', block: 'center' }); toast('Check the note, then tap the redo button below it.');
  });
  v.querySelectorAll('.thpick').forEach((b) => b.addEventListener('click', () => { v.querySelectorAll('.thpick').forEach((x) => x.classList.toggle('on', x === b)); }));
  $('rvRegen').addEventListener('click', () => { $('rvRegenBox').hidden = !$('rvRegenBox').hidden; $('rvRejectBox').hidden = true; });
  $('rvReject').addEventListener('click', () => { $('rvRejectBox').hidden = !$('rvRejectBox').hidden; $('rvRegenBox').hidden = true; });
  $('rvRegenGo').addEventListener('click', () => reviewAct('regen'));
  $('rvRejectGo').addEventListener('click', () => reviewAct('reject'));
  reviewExtras();
}

function editedPackage() {
  const title = $('rvTitle').value.trim();
  const tags = $('rvTags').value.split(',').map((t) => t.trim()).filter(Boolean);
  const pick = document.querySelector('.thpick.on');
  return { ...rv.pkg, title, description: $('rvDesc').value.trim(), tags, pinned_comment: $('rvPin') ? $('rvPin').value.trim() : rv.pkg.pinned_comment,
    thumbnail: pick ? pick.dataset.u : rv.pkg.thumbnail, edited: new Date().toISOString() };
}
function packageChanged(p) {
  return p.title !== rv.pkg.title || p.description !== rv.pkg.description || p.tags.join(',') !== (rv.pkg.tags || []).join(',')
    || (p.pinned_comment || '') !== (rv.pkg.pinned_comment || '') || p.thumbnail !== rv.pkg.thumbnail;
}

async function reviewAct(kind) {
  const msg = $('rvMsg'); msg.className = 'msg'; msg.textContent = '';
  const fail = (t) => { msg.className = 'msg bad'; msg.textContent = t; };
  const buttons = document.querySelectorAll('#reviewView button'); buttons.forEach((b) => { b.disabled = true; });
  try {
    const job = { ...rv.job };
    if (kind === 'save' || kind === 'approve') {
      const p = editedPackage();
      if (!p.title) return fail('Please give the video a title.');
      if (p.description.length > 5000) return fail('The description is too long for YouTube (5,000 characters max).');
      if (kind === 'approve' && $('rvChecked') && !$('rvChecked').checked) return fail('Please check the flagged facts first, then tick the box.');
      if (packageChanged(p)) {
        const r = await gh.putFile(`packages/${job.id}.json`, p, `Edit details: ${p.title.slice(0, 60)}`, rv.pkgSha);
        rv.pkg = p; rv.pkgSha = r.content.sha;
        job.title = p.title;
      }
      if (kind === 'save') {
        if (job.title !== rv.job.title) { const r = await gh.putFile(`jobs/${job.id}.json`, job, 'Update title', rv.jobSha); rv.job = job; rv.jobSha = r.content.sha; }
        msg.className = 'msg ok'; msg.textContent = 'Saved.'; return;
      }
      const auto = store.get('ytAuto', false);
      Object.assign(job, { status: auto ? 'approved' : 'post_yourself', approved: new Date().toISOString() });
      await gh.putFile(`jobs/${job.id}.json`, job, `Approved: ${job.title.slice(0, 60)}`, rv.jobSha);
      confetti();
      toast(auto ? 'Approved! It goes to YouTube as Private in a few minutes.' : 'Approved! Open the Queue to post it on YouTube.');
    } else if (kind === 'regen') {
      const what = document.querySelector('input[name="regen"]:checked').value;
      const notes = $('rvNotes').value.trim();
      job.status = { pictures: 'script_ready', package: 'video_ready', script: 'requested' }[what];
      job.revision = (job.revision || 0) + 1;
      if (what === 'script' && notes) job.revision_notes = notes;
      ['error', 'attempts', 'render_attempts', 'package_attempts', 'failed_step'].forEach((k) => delete job[k]);
      await gh.putFile(`jobs/${job.id}.json`, job, `Redo (${what}): ${(job.title || job.topic).slice(0, 60)}`, rv.jobSha);
      toast(what === 'package' ? 'New title and thumbnail coming in a few minutes.' : 'Redoing it. Check the Queue tab.');
    } else if (kind === 'reject') {
      Object.assign(job, { status: 'rejected', rejected: new Date().toISOString(), rejected_reason: $('rvReason').value.trim() });
      await gh.putFile(`jobs/${job.id}.json`, job, `Rejected: ${(job.title || job.topic).slice(0, 60)}`, rv.jobSha);
      toast('Rejected. It will not be uploaded.');
    }
    showTab('review');
  } catch (err) {
    fail(err.status === 409 ? 'This video changed in the cloud a moment ago. Go back and open it again.' : 'Could not save: ' + err.message);
  } finally { buttons.forEach((b) => { b.disabled = false; }); }
}

// ---------- dashboard ----------
const fmtN = (n) => Number(n || 0).toLocaleString('en-IN');
const fmtDur = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.round((s || 0) % 60)).padStart(2, '0')}`;
function meter(label, have, need, unit) {
  const pct = Math.min(100, need ? (have / need) * 100 : 0);
  return `<div class="meter"><div class="mrow"><span>${esc(label)}</span><b>${fmtN(have)} / ${fmtN(need)}${unit ? ' ' + unit : ''}</b></div>
    <div class="mbar" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct.toFixed(1)}%"></i></div></div>`;
}
function viewsChart(daily) {
  if (!daily || !daily.length) return '<p class="hint">No daily numbers yet. YouTube shares them 2 to 3 days late.</p>';
  const W = 600, H = 170, padB = 22, padT = 12, n = daily.length, gap = 2;
  const max = Math.max(1, ...daily.map((d) => d.views));
  const bw = (W - gap * (n - 1)) / n;
  const bars = daily.map((d, i) => {
    const h = Math.max(d.views ? 2 : 0, (d.views / max) * (H - padB - padT));
    const x = i * (bw + gap), y = H - padB - h;
    const r = Math.min(4, bw / 2, h);
    const path = h ? `M${x},${H - padB} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${H - padB} Z` : '';
    const label = new Date(d.day).toLocaleDateString([], { day: 'numeric', month: 'short' });
    return `<g class="cb" data-tip="${esc(label)}: ${fmtN(d.views)} views, ${fmtN(Math.round(d.minutes / 60))} h watched">
      <rect x="${x}" y="${padT}" width="${bw + gap}" height="${H - padT}" fill="transparent"/>${path ? `<path d="${path}"/>` : ''}</g>`;
  }).join('');
  const first = new Date(daily[0].day).toLocaleDateString([], { day: 'numeric', month: 'short' });
  const last = new Date(daily[n - 1].day).toLocaleDateString([], { day: 'numeric', month: 'short' });
  return `<div class="chartwrap"><div class="ctip" hidden></div>
    <svg class="vchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily views for the last ${n} days, highest ${fmtN(max)}">
      <line x1="0" x2="${W}" y1="${H - padB}" y2="${H - padB}" class="base"/>
      <text x="0" y="10" class="ax">${fmtN(max)}</text>
      ${bars}
      <text x="0" y="${H - 5}" class="ax">${esc(first)}</text><text x="${W}" y="${H - 5}" class="ax" text-anchor="end">${esc(last)}</text>
    </svg></div>
    <details class="hint"><summary>Show as a table</summary><table class="stable">${daily.map((d) => `<tr><td>${esc(d.day)}</td><td>${fmtN(d.views)} views</td><td>${fmtN(Math.round(d.minutes / 60))} h</td></tr>`).join('')}</table></details>`;
}
async function loadStats() {
  const v = $('statsView');
  if (mode() !== 'github') { v.innerHTML = '<div class="card empty">Connect your GitHub project in Settings first.</div>'; return; }
  let s;
  try { const f = await gh.getFile('stats/latest.json'); s = f && f.data; } catch (err) { v.innerHTML = `<div class="card empty">Could not load (${esc(err.message)}).</div>`; return; }
  if (!s) { v.innerHTML = '<div class="card empty">No stats yet. They are collected every morning at 7 AM once YouTube is connected.</div>'; return; }
  const c = s.channel || {}, l = s.last28, y = s.ypp || {};
  const recent = s.recent || [];
  const cutoff = Date.now() - 90 * 864e5;
  const uploads90 = recent.filter((x) => x.privacy === 'public' && new Date(x.published).getTime() > cutoff).length;
  const hours = y.long_watch_hours_365 || 0, sv = y.shorts_views_90 || 0;
  v.innerHTML = `
    <div class="dhero"><div class="k">Your channel</div><h2>${esc(c.title || 'Your channel')}</h2>
      <div class="big">${c.subscribers_hidden ? '—' : fmtN(c.subscribers)}</div><div class="lbl">subscribers · updated ${esc(new Date(s.updated).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}</div>
      ${(() => { const g = c.subscribers >= 1000 ? null : c.subscribers >= 500 ? 1000 : c.subscribers >= 100 ? 500 : 100; return g ? `<div class="next">Next goal: <b>${fmtN(g)} subscribers</b> · ${fmtN(Math.max(0, g - (c.subscribers || 0)))} to go<div class="mbar"><i style="width:${Math.min(100, ((c.subscribers || 0) / g) * 100).toFixed(1)}%"></i></div></div>` : ''; })()}
    </div>
    ${s.error ? `<div class="card"><p class="flagnote">${esc(s.error)}</p></div>` : ''}
    <div class="tiles">
      <div class="tile"><b>${fmtN(c.views)}</b><span>Total views</span></div>
      <div class="tile"><b>${fmtN(c.videos)}</b><span>Videos</span></div>
    </div>
    ${l ? `<div class="card"><h2>Last 28 days</h2><div class="tiles in">
      <div class="tile"><b>${fmtN(l.views)}</b><span>Views</span></div>
      <div class="tile"><b>${fmtN(l.hours)}</b><span>Hours watched</span></div>
      <div class="tile"><b>${fmtDur(l.avg_view_seconds)}</b><span>Average watch</span></div>
      <div class="tile"><b>${l.subs >= 0 ? '+' : ''}${fmtN(l.subs)}</b><span>New subscribers</span></div></div>
      <h3 class="chartttl">Daily views</h3>${viewsChart(s.daily)}</div>` : ''}
    ${s.analytics === false ? `<div class="card"><p class="flagnote">${esc(s.analytics_note || 'Watch time is not available yet.')}</p></div>` : ''}
    ${(() => { const r = s.report; if (!r || r.views === undefined) return '';
      const diff = r.views_prev !== undefined ? r.views - r.views_prev : null;
      return `<div class="card report"><div class="rhead"><div><div class="k">${r.is_sunday ? 'New this Sunday' : 'Last 7 days'}</div><h2>Weekly report card</h2></div>${r.grade ? `<div class="grade g${r.grade}">${r.grade}</div>` : ''}</div>
        <div class="tiles in"><div class="tile"><b>${fmtN(r.views)}</b><span>Views${diff !== null ? ` (${diff >= 0 ? '+' : ''}${fmtN(diff)} vs week before)` : ''}</span></div>
        <div class="tile"><b>${r.subs >= 0 ? '+' : ''}${fmtN(r.subs)}</b><span>Subscribers</span></div><div class="tile"><b>${fmtN(r.uploads)}</b><span>Videos posted</span></div>
        <div class="tile"><b>${fmtN(r.planned_next_week)}</b><span>Planned next week</span></div></div>
        ${r.best ? `<p class="hint" style="margin:0">Star of the week: <a href="https://youtu.be/${esc(r.best.id)}" target="_blank" rel="noopener">${esc(r.best.title)}</a> · ${fmtN(r.best.views)} views</p>` : ''}
        ${r.planned_next_week === 0 ? '<p class="hint" style="margin:8px 0 0">Nothing planned for next week yet. Use <b>Plan the week</b> on the New video tab.</p>' : ''}</div>`; })()}
    ${s.insights ? `<div class="card"><h2>What's working</h2><ul class="tips">${(s.insights.tips || []).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      ${(s.insights.top || []).length ? `<h3 class="chartttl">Your top videos</h3>${s.insights.top.map((v, i) => `<a class="toprow" href="https://studio.youtube.com/video/${esc(v.id)}/analytics" target="_blank" rel="noopener"><span class="rank">${i + 1}</span><span class="tt">${esc(v.title)}</span><span class="meta">${fmtN(v.views)} views${v.avg_pct ? ` · ${v.avg_pct}% watched` : ''}</span></a>`).join('')}` : ''}</div>` : ''}
    ${s.insights && s.insights.best_time ? `<div class="card"><h2>Best time to post</h2>${s.insights.best_time.slot
      ? `<p class="bigline">${esc(s.insights.best_time.slot)}</p><p class="hint">India time, based on early views per day.</p>${Object.entries(s.insights.best_time.tested).map(([k, v]) => meter(k, Math.round(v.views_per_day), Math.max(...Object.values(s.insights.best_time.tested).map((x) => x.views_per_day)) || 1, 'views/day')).join('')}`
      : `<p class="hint">Still learning. ${s.insights.best_time.try_next ? `Post your next 2 videos in the <b>${esc(s.insights.best_time.try_next)}</b> (India time) so the app can compare.` : 'Post at different times of day so the app can compare.'}</p>`}</div>` : ''}
    <div class="card"><h2>Partner Program progress</h2>
      <p class="hint">Earn from ads: 1,000 subscribers, plus 4,000 watch hours on long videos in 12 months <i>or</i> 10 million Shorts views in 90 days.</p>
      ${meter('Subscribers', c.subscribers || 0, 1000)}
      ${s.analytics ? meter('Long-video watch hours (12 months)', Math.round(hours), 4000, 'h') + meter('Shorts views (90 days)', sv, 10000000) : ''}
      <p class="hint" style="margin-top:14px">Earlier step (memberships, Super Thanks, shopping): 500 subscribers, 3 public videos in 90 days, and 3,000 watch hours or 3 million Shorts views.</p>
      ${meter('Subscribers', c.subscribers || 0, 500)}
      ${meter('Public videos (90 days)', uploads90, 3)}
      ${s.analytics ? meter('Long-video watch hours (12 months)', Math.round(hours), 3000, 'h') : ''}
      ${y.exact === false ? '<p class="hint">Watch hours include Shorts here, so the real number is a bit lower.</p>' : ''}
    </div>
    <div class="card"><h2>Recent videos</h2>
      ${recent.length ? recent.slice(0, 15).map((x) => `<a class="vrow" href="https://studio.youtube.com/video/${esc(x.id)}/analytics" target="_blank" rel="noopener">
        ${x.thumb ? `<img src="${esc(x.thumb)}" alt="" loading="lazy">` : ''}
        <div><div class="vt">${esc(x.title)}</div><div class="meta">${x.short ? 'Short' : 'Long'} · ${esc(x.privacy)} · ${esc(new Date(x.published).toLocaleDateString())}</div>
        <div class="meta">${fmtN(x.views)} views · ${fmtN(x.likes)} likes · ${fmtN(x.comments)} comments</div></div></a>`).join('') : '<p class="hint">No videos yet.</p>'}
    </div>
    <p class="hint">Numbers refresh every morning at 7 AM. YouTube's own figures run 2 to 3 days behind.</p>`;
  const wrap = v.querySelector('.chartwrap');
  if (wrap) {
    const tip = wrap.querySelector('.ctip');
    const show = (e) => {
      const g = e.target.closest('.cb'); if (!g) { tip.hidden = true; return; }
      v.querySelectorAll('.cb.on').forEach((x) => x.classList.remove('on')); g.classList.add('on');
      tip.textContent = g.dataset.tip; tip.hidden = false;
      const r = wrap.getBoundingClientRect(), b = g.getBoundingClientRect();
      tip.style.left = Math.min(Math.max(0, b.left - r.left + b.width / 2 - 90), r.width - 180) + 'px';
    };
    wrap.addEventListener('pointermove', show); wrap.addEventListener('click', show);
    wrap.addEventListener('pointerleave', () => { tip.hidden = true; v.querySelectorAll('.cb.on').forEach((x) => x.classList.remove('on')); });
  }
}

// ---------- income ----------
const money = { aff: { links: [] }, affSha: null, kitSha: null };
function paintAff() {
  const links = money.aff.links || [];
  $('affList').innerHTML = links.length ? links.map((l, i) => `<div class="affrow"><div><b>${esc(l.name)}</b><div class="meta">${esc(l.url)}</div>
    <div class="meta">${l.always ? 'Every video' : 'Videos about: ' + esc((l.keywords || []).join(', '))}</div></div><button class="danger affdel" data-i="${i}">Remove</button></div>`).join('')
    : '<p class="hint">No links yet.</p>';
}
async function loadMoney() {
  if (mode() !== 'github') { $('affMsg').textContent = 'Connect your GitHub project in Settings first.'; return; }
  try {
    const a = await gh.getFile('config/affiliates.json'); money.aff = (a && a.data) || { links: [] }; money.affSha = a && a.sha;
    const k = await gh.getFile('config/kit.json'); money.kitSha = k && k.sha;
    const kit = (k && k.data) || {};
    $('kitAbout').value = kit.about || ''; $('kitAudience').value = kit.audience || ''; $('kitOffers').value = (kit.offers || []).join('\n');
    $('kitRates').value = kit.rates || ''; $('kitEmail').value = kit.email || '';
    paintAff();
  } catch (err) { $('affMsg').className = 'msg bad'; $('affMsg').textContent = 'Could not load: ' + err.message; }
}
async function saveAff(msgText) {
  const r = await gh.putFile('config/affiliates.json', money.aff, 'Update affiliate links', money.affSha);
  money.affSha = r.content.sha; paintAff(); toast(msgText);
}
$('affAdd').addEventListener('click', async () => {
  const msg = $('affMsg'); msg.className = 'msg bad';
  const name = $('affName').value.trim(), url = $('affUrl').value.trim();
  const keywords = $('affWords').value.split(',').map((w) => w.trim()).filter(Boolean), always = $('affAlways').checked;
  if (!name) { msg.textContent = 'Please give the link a name.'; return; }
  if (!/^https:\/\/\S+$/.test(url)) { msg.textContent = 'The link must start with https:// and have no spaces.'; return; }
  if (!always && !keywords.length) { msg.textContent = 'Add some words, or tick "Add to every video".'; return; }
  try {
    money.aff.links = [...(money.aff.links || []), { name, url, keywords, always }];
    await saveAff('Link added. New videos will use it.');
    ['affName', 'affUrl', 'affWords'].forEach((id) => { $(id).value = ''; }); $('affAlways').checked = false; msg.textContent = '';
  } catch (err) { money.aff.links.pop(); msg.textContent = err.status === 409 ? 'Changed elsewhere. Open the Income tab again.' : 'Could not save: ' + err.message; }
});
$('affList').addEventListener('click', async (e) => {
  const b = e.target.closest('.affdel'); if (!b) return;
  const old = money.aff.links.slice();
  money.aff.links.splice(Number(b.dataset.i), 1);
  try { await saveAff('Link removed.'); } catch (err) { money.aff.links = old; toast('Could not save: ' + err.message); }
});
$('kitSave').addEventListener('click', async () => {
  const msg = $('kitMsg');
  const email = $('kitEmail').value.trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.className = 'msg bad'; msg.textContent = 'That email does not look right.'; return; }
  const kit = { about: $('kitAbout').value.trim(), audience: $('kitAudience').value.trim(), offers: $('kitOffers').value.split('\n').map((x) => x.trim()).filter(Boolean),
    rates: $('kitRates').value.trim(), email, updated: new Date().toISOString() };
  try {
    const r = await gh.putFile('config/kit.json', kit, 'Update media kit', money.kitSha); money.kitSha = r.content.sha;
    msg.className = 'msg ok'; msg.textContent = 'Saved. The media kit page shows it in about a minute.';
  } catch (err) { msg.className = 'msg bad'; msg.textContent = 'Could not save: ' + err.message; }
});
$('kitCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(new URL('kit.html', location.href).href); toast('Media kit link copied.'); } catch { toast('Could not copy.'); }
});

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
// ---------- subtitle languages ----------
const SUB_LANGS = { en: 'English', hi: 'Hindi', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German', ar: 'Arabic', id: 'Indonesian', ja: 'Japanese' };
function paintSubLangs() {
  const on = store.get('subLangs', ['hi', 'es']);
  $('subLangs').innerHTML = Object.entries(SUB_LANGS).filter(([k]) => k !== 'en').map(([k, n]) => `<button type="button" class="cchip${on.includes(k) ? ' on' : ''}" data-l="${k}">${n}</button>`).join('');
}
$('subLangs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-l]'); if (!b) return;
  let on = store.get('subLangs', ['hi', 'es']);
  on = on.includes(b.dataset.l) ? on.filter((x) => x !== b.dataset.l) : [...on, b.dataset.l].slice(-4);
  store.set('subLangs', on); paintSubLangs(); toast(on.length ? 'Saved. New videos get these subtitles.' : 'No extra languages. Only English subtitles.');
});
paintSubLangs();
function paintIntro() { $('introBtn').textContent = store.get('intro', true) ? 'Intro and end screen: ON (tap to turn off)' : 'Intro and end screen: OFF (tap to turn on)'; }
$('introBtn').addEventListener('click', () => { store.set('intro', !store.get('intro', true)); paintIntro(); toast('Saved for new long videos.'); });
paintIntro();
function paintQV() { $('qvBtn').textContent = store.get('quoteVoice', true) ? 'Second voice for quotes: ON (tap to turn off)' : 'Second voice for quotes: OFF (tap to turn on)'; }
$('qvBtn').addEventListener('click', () => { store.set('quoteVoice', !store.get('quoteVoice', true)); paintQV(); toast('Saved for new videos.'); });
paintQV();
const PACES = [['often', 'Often', 'new picture about every 6 seconds'], ['medium', 'Medium', 'about every 10 seconds'], ['calm', 'Calm', 'about every 15 seconds']];
function paintPace() {
  const v = store.get('picPace', 'often');
  $('paceChips').innerHTML = PACES.map(([k, n]) => `<button type="button" class="cchip${k === v ? ' on' : ''}" data-p="${k}">${n}</button>`).join('');
  const p = PACES.find((x) => x[0] === v), pics = picsFor({ format: 'long', length: 40, pic_pace: v });
  $('paceNote').textContent = `${p[2][0].toUpperCase() + p[2].slice(1)}. A 40-minute video needs about ${pics} pictures, which takes about ${Math.ceil(pics / PICS_PER_DAY)} day${pics > PICS_PER_DAY ? 's' : ''} of free pictures. Shorts always change about every 5 seconds.`;
}
$('paceChips').addEventListener('click', (e) => { const b = e.target.closest('[data-p]'); if (!b) return; store.set('picPace', b.dataset.p); paintPace(); toast('Saved for new videos.'); });
// ---------- pronunciation list ----------
const pron = { words: [], sha: null };
function paintPron() {
  $('pronList').innerHTML = pron.words.length ? pron.words.map((w, i) => `<div class="affrow"><div><b>${esc(w.word)}</b><div class="meta">said like: ${esc(w.say)}</div></div><button class="danger prdel" data-i="${i}">Remove</button></div>`).join('') : '<p class="hint">No words yet.</p>';
}
async function loadPron() {
  if (mode() !== 'github') return;
  try { const f = await gh.getFile('config/pronounce.json'); pron.words = (f && f.data.words) || []; pron.sha = f && f.sha; paintPron(); } catch { /* offline */ }
}
async function savePron(msg) {
  const r = await gh.putFile('config/pronounce.json', { words: pron.words }, 'Update pronunciation list', pron.sha); pron.sha = r.content.sha; paintPron(); toast(msg);
}
$('prAdd').addEventListener('click', async () => {
  const word = $('prWord').value.trim(), say = $('prSay').value.trim();
  if (!word || !say) { toast('Fill in both boxes.'); return; }
  pron.words = pron.words.filter((w) => w.word.toLowerCase() !== word.toLowerCase()).concat([{ word, say }]);
  try { await savePron('Saved. New videos will say it this way.'); $('prWord').value = ''; $('prSay').value = ''; } catch (err) { toast('Could not save: ' + err.message); }
});
$('pronList').addEventListener('click', async (e) => {
  const b = e.target.closest('.prdel'); if (!b) return;
  pron.words.splice(Number(b.dataset.i), 1);
  try { await savePron('Removed.'); } catch (err) { toast('Could not save: ' + err.message); }
});

// ---------- caption font ----------
const CAPTION_FONTS = [
  ['Anton', "'Anton'", 'Tall and bold (current)'], ['Bebas Neue', "'Bebas Neue'", 'Clean and modern'],
  ['Poppins', "'Poppins'", 'Round and friendly'], ['Lilita One', "'Lilita One'", 'Soft and playful'],
  ['Bangers', "'Bangers'", 'Comic book'], ['Luckiest Guy', "'Luckiest Guy'", 'Big cartoon letters'],
  ['Patrick Hand', "'Patrick Hand'", 'Handwritten'],
];
function paintFonts() {
  const cur = store.get('captionFont', 'Anton');
  $('fontList').innerHTML = CAPTION_FONTS.map(([name, css, note]) => `<label class="fontpick${name === cur ? ' on' : ''}">
    <input type="radio" name="capfont" value="${esc(name)}"${name === cur ? ' checked' : ''}>
    <span class="fontsample" style="font-family:${css},sans-serif;${name === 'Poppins' ? 'font-weight:700;' : ''}">${name === 'Patrick Hand' ? 'The fire spread fast' : 'THE FIRE SPREAD FAST'}</span>
    <span class="meta">${esc(name)} · ${esc(note)}</span></label>`).join('');
}
$('fontList').addEventListener('change', (e) => {
  if (e.target.name !== 'capfont') return;
  store.set('captionFont', e.target.value); paintFonts(); toast('Caption font saved. New videos will use it.');
});
paintFonts();
$('saveTargets').addEventListener('click', () => { store.set('tLong', Number($('tLong').value) || 0); store.set('tShort', Number($('tShort').value) || 0); toast('Targets saved'); });
$('demoBtn').addEventListener('click', () => { const on = !demo.on(); store.set('demo', on); $('demoBtn').textContent = on ? 'Turn off demo mode' : 'Turn on demo mode'; paintConn(); toast(on ? 'Demo mode on' : 'Demo mode off'); });
$('forgetBtn').addEventListener('click', () => { store.del('token'); $('ghToken').placeholder = 'github_pat_...'; paintConn(); toast('Access key removed from this tablet'); });

// ---------- YouTube sign-in ----------
// Google sends you back to this page with a one-time code. The app swaps it for a long-lasting
// "refresh token", which you save as a GitHub secret so the cloud can upload for you.
const YT_SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/youtube.force-ssl';
function ytRedirect() { return location.origin + location.pathname.replace(/index\.html$/, ''); }
function ytOut(html, cls) { const m = $('ytMsg'); m.className = 'msg ' + (cls || ''); m.innerHTML = html; }
$('ytRedirect').textContent = ytRedirect();
function paintAuto() { const on = store.get('ytAuto', false); $('ytAuto').textContent = on ? 'Automatic upload: ON (tap to turn off)' : 'Automatic upload: OFF (tap to turn on)'; }
$('ytAuto').addEventListener('click', () => { store.set('ytAuto', !store.get('ytAuto', false)); paintAuto(); toast(store.get('ytAuto', false) ? 'Approved videos will upload automatically.' : 'You will post approved videos yourself.'); });
paintAuto();
$('ytConnect').addEventListener('click', () => {
  const id = $('ytClientId').value.trim(), secret = $('ytSecret').value.trim();
  if (!id.endsWith('.apps.googleusercontent.com')) return ytOut('The Client ID should end with .apps.googleusercontent.com', 'bad');
  if (!secret) return ytOut('Please paste the Client secret too.', 'bad');
  store.set('ytClientId', id); store.set('ytSecret', secret);
  const q = new URLSearchParams({ client_id: id, redirect_uri: ytRedirect(), response_type: 'code', scope: YT_SCOPES,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state: 'yt' });
  location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
});
async function ytFinish() {
  const q = new URLSearchParams(location.search);
  if (q.get('state') !== 'yt') return false;
  history.replaceState(null, '', ytRedirect());
  showTab('settings');
  $('ytCard').scrollIntoView();
  if (q.get('error')) { ytOut('Google sign-in was cancelled (' + esc(q.get('error')) + '). Tap Sign in with Google to try again.', 'bad'); return true; }
  ytOut('Finishing sign-in...');
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: q.get('code'), client_id: store.get('ytClientId', ''), client_secret: store.get('ytSecret', ''),
        redirect_uri: ytRedirect(), grant_type: 'authorization_code' }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.error || res.status);
    if (!data.refresh_token) throw new Error('Google did not send a refresh token. Tap Sign in with Google again.');
    if (!String(data.scope || '').includes('youtube.upload')) throw new Error('The box allowing uploads was not ticked. Sign in again and tick every box.');
    ytOut(`<b>Signed in.</b> Now add three secrets in GitHub (Settings &gt; Secrets and variables &gt; Actions &gt; New repository secret):
      <span class="ytrow"><b>YT_CLIENT_ID</b><button data-copy="id">Copy</button></span>
      <span class="ytrow"><b>YT_CLIENT_SECRET</b><button data-copy="secret">Copy</button></span>
      <span class="ytrow"><b>YT_REFRESH_TOKEN</b><button data-copy="refresh">Copy</button></span>
      Tap Copy, then paste it into the Secret box of the secret with that name. Never paste these in chat.`, 'ok');
    ytFinish.vals = { id: store.get('ytClientId', ''), secret: store.get('ytSecret', ''), refresh: data.refresh_token };
  } catch (err) { ytOut('Sign-in did not finish: ' + esc(err.message), 'bad'); }
  return true;
}
$('ytMsg').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-copy]'); if (!b || !ytFinish.vals) return;
  try { await navigator.clipboard.writeText(ytFinish.vals[b.dataset.copy]); b.textContent = 'Copied'; toast('Copied. Paste it into GitHub.'); }
  catch { toast('Could not copy. Long-press to copy instead.'); }
});

// ---------- start ----------
window.addEventListener('DOMContentLoaded', function init() {  // after play.js has loaded
  const c = gh.conf();
  $('ghUser').value = c.user; $('ghRepo').value = c.repo;
  if (c.token) $('ghToken').placeholder = 'Saved on this tablet';
  if (store.get('targetsV', 1) < 2) { store.set('tLong', 3); store.set('tShort', 3); store.set('targetsV', 2); }
  $('tLong').value = store.get('tLong', 3); $('tShort').value = store.get('tShort', 3);
  $('demoBtn').textContent = demo.on() ? 'Turn off demo mode' : 'Turn on demo mode';
  ['voice', 'tone', 'audience'].forEach((k) => { const v = store.get('last' + k[0].toUpperCase() + k.slice(1)); if (v) $(k).value = v; });
  fillLengths(); ['tone', 'audience', 'voice'].forEach(chipify); paintPresets(); paintConn();
  $('ytClientId').value = store.get('ytClientId', ''); if (store.get('ytSecret', '')) $('ytSecret').placeholder = 'Saved on this tablet';
  showTab(mode() === 'none' ? 'settings' : store.get('homeV', 0) ? store.get('tab', 'home') : 'home'); store.set('homeV', 1);
  paintPace();
  ytFinish();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
});
