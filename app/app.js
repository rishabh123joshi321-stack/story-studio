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
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name || (name === 'script' && b.dataset.tab === 'queue') || (name === 'reviewone' && b.dataset.tab === 'review')));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('on', s.id === 'tab-' + name));
  if (!['script', 'reviewone'].includes(name)) store.set('tab', name);
  if (name === 'queue') loadQueue();
  if (name === 'ideas') loadIdeas();
  if (name === 'review') loadReview();
  if (name === 'stats') loadStats();
  if (name === 'money') loadMoney();
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
function fillLengths() {
  $('length').innerHTML = LENGTHS[format].map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  $('length').value = format === 'short' ? '45' : '40';
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
    captionFont: store.get('captionFont', 'Anton'),
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
  const tL = store.get('tLong', 3), tS = store.get('tShort', 3);
  $('dailyBar').innerHTML = `<div><b>${today.filter((j) => j.format === 'long').length} / ${tL}</b>long videos planned today</div><div><b>${today.filter((j) => j.format === 'short').length} / ${tS}</b>Shorts planned today</div>`;
  if (!jobs.length) { list.innerHTML = '<div class="card empty">Nothing yet. Plan your first video in the New video tab.</div>'; return; }
  queueJobs = jobs;
  paintReviewCount(jobs);
  list.innerHTML = jobs.map((j) => {
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
    else if (j.status === 'requested' && j.error) extra = `<div class="meta">Retrying soon: ${esc(j.error)}</div>`;
    else if (j.error) extra = `<div class="meta" style="color:var(--bad)">${esc(j.error)}</div>`;
    if (['post_yourself', 'uploaded'].includes(j.status) && mode() === 'github') extra += postHelper(j);
    if (j.status === 'failed' && mode() === 'github') extra += `<button class="retry" data-id="${esc(j.id)}">Try again</button>`;
    return `<div class="card job${tap ? ' tap' : ''}" data-id="${esc(j.id)}"><div><h3>${esc(j.topic)}</h3><div class="meta">${j.format === 'short' ? 'Short' : 'Long video'} · ${j.length} ${esc(j.lengthUnit)} · ${esc(j.tone)} · ${when}</div>${extra}</div><span class="status ${cls}">${esc(STATUS_TEXT[j.status] || j.status)}</span></div>`;
  }).join('');
}
let queueJobs = [];
// "Post it yourself": until Google's audit passes, videos sent by the app are locked Private,
// so the owner posts them from the YouTube app with these buttons.
function postHelper(j) {
  return `<div class="posthelp">
    ${j.status === 'post_yourself' ? '<p class="meta">1. Download the video. 2. In the YouTube app tap + then Upload a video and pick it. 3. Paste the title and description, and add the tags under Add tags (or Show more). 4. Tap I posted it.</p>' : '<p class="meta">This copy is locked Private by Google. To publish now, download it and post it from the YouTube app, then delete the locked copy in Studio.</p>'}
    ${j.video ? `<a class="btnlink" href="${esc(j.video)}" download>Download video</a>` : ''}
    <button class="pcopy" data-id="${esc(j.id)}" data-what="title">Copy title</button>
    <button class="pcopy" data-id="${esc(j.id)}" data-what="description">Copy description</button>
    <button class="pcopy" data-id="${esc(j.id)}" data-what="tags">Copy tags</button>
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
    ${pkg.thumbnail ? `<div class="card"><h2>Thumbnail</h2><img class="thumb" src="${esc(pkg.thumbnail)}" alt="Thumbnail"></div>` : ''}
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
  $('rvRegen').addEventListener('click', () => { $('rvRegenBox').hidden = !$('rvRegenBox').hidden; $('rvRejectBox').hidden = true; });
  $('rvReject').addEventListener('click', () => { $('rvRejectBox').hidden = !$('rvRejectBox').hidden; $('rvRegenBox').hidden = true; });
  $('rvRegenGo').addEventListener('click', () => reviewAct('regen'));
  $('rvRejectGo').addEventListener('click', () => reviewAct('reject'));
}

function editedPackage() {
  const title = $('rvTitle').value.trim();
  const tags = $('rvTags').value.split(',').map((t) => t.trim()).filter(Boolean);
  return { ...rv.pkg, title, description: $('rvDesc').value.trim(), tags, edited: new Date().toISOString() };
}
function packageChanged(p) {
  return p.title !== rv.pkg.title || p.description !== rv.pkg.description || p.tags.join(',') !== (rv.pkg.tags || []).join(',');
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
const YT_SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly';
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
(function init() {
  const c = gh.conf();
  $('ghUser').value = c.user; $('ghRepo').value = c.repo;
  if (c.token) $('ghToken').placeholder = 'Saved on this tablet';
  if (store.get('targetsV', 1) < 2) { store.set('tLong', 3); store.set('tShort', 3); store.set('targetsV', 2); }
  $('tLong').value = store.get('tLong', 3); $('tShort').value = store.get('tShort', 3);
  $('demoBtn').textContent = demo.on() ? 'Turn off demo mode' : 'Turn on demo mode';
  ['voice', 'tone', 'audience'].forEach((k) => { const v = store.get('last' + k[0].toUpperCase() + k.slice(1)); if (v) $(k).value = v; });
  fillLengths(); paintConn();
  $('ytClientId').value = store.get('ytClientId', ''); if (store.get('ytSecret', '')) $('ytSecret').placeholder = 'Saved on this tablet';
  showTab(mode() === 'none' ? 'settings' : store.get('tab', 'create'));
  ytFinish();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
