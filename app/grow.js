/* Story Studio: growth and reach helpers (2026-11-21).
   Growth: 1 hook options, 2 Test & compare, 3 Shorts as trailers, 4 series playlists, 5 weekly topic report,
   6 steady posting time, 7 comment replies. Reach: Reels cross-posting, Reddit and Quora drafts, blog link,
   subtitles/translations on videos posted by hand. Loaded after app.js and play.js. */

// ---------- small helpers ----------
function ytIdFrom(raw) {
  const s = String(raw || '').trim(); if (!s) return '';
  const m = s.match(/(?:youtu\.be\/|shorts\/|[?&]v=|\/video\/|live\/)([A-Za-z0-9_-]{11})/) || s.match(/^([A-Za-z0-9_-]{11})$/);
  return m ? m[1] : '';
}
function postTimeLabel() {
  const t = store.get('postTime', ''); if (!t) return '';
  const [h, m] = t.split(':').map(Number); const d = new Date(); d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function jobById(id) { return (typeof queueJobs !== 'undefined' && queueJobs || []).find((j) => j.id === id); }

// ---------- 3 + 4 + 6: posting steps ----------
function postSteps(j) {
  const parent = j.parent_id ? jobById(j.parent_id) : null;
  const pt = postTimeLabel();
  const steps = [
    'Tap <b>Download video</b>.',
    'In the YouTube app tap <b>+</b> &gt; <b>Upload a video</b> and pick it.',
    'Tap <b>Copy title</b> and <b>Copy description</b> and paste them. Add the tags under <b>Show more</b> &gt; <b>Add tags</b>.',
  ];
  if (parent) {
    const done = ['posted', 'uploaded'].includes(parent.status);
    steps.push(done ? `Trailer: tap <b>Related video</b> and pick <b>${esc(parent.title || parent.topic)}</b>. Viewers can then jump from this Short to the full video.`
      : `Trailer: post the long video <b>${esc(parent.title || parent.topic)}</b> first. Then tap <b>Related video</b> here and pick it.`);
  } else if (j.format === 'short') {
    steps.push('If one of your long videos tells the same story, tap <b>Related video</b> and pick it.');
  }
  if (j.series) steps.push(`Series: tap <b>Add to playlists</b> and tick <b>${esc(j.series)}</b> (tap <b>Create playlist</b> the first time).`);
  if (j.format === 'long') steps.push('Thumbnail: tap the pencil on the picture and upload the one from the <b>Thumbnail</b> button below.');
  steps.push(pt ? `Tap <b>Visibility</b> &gt; <b>Schedule</b> and pick <b>${pt}</b> today (tomorrow if that time has passed). Posting at the same time every day helps.`
    : 'Tap <b>Visibility</b> &gt; <b>Public</b>. (Pick a steady posting time in Settings &gt; Growth and the app will tell you when.)');
  steps.push('Tap <b>Upload</b>. Then paste the pinned comment under the video and tap <b>Pin</b>.');
  steps.push('Paste the video link below and tap <b>I posted it</b>.');
  return `<ol class="psteps">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>`;
}

// ---------- 2: Test & compare, and Reels for Shorts ----------
function growHelper(j) {
  let out = '';
  if (j.format === 'long') {
    out += `<details class="tcbox" data-id="${esc(j.id)}"><summary>Test 3 thumbnails and titles (YouTube Test &amp; compare)</summary>
      <p class="meta">YouTube shows each version to different viewers and keeps the one that gets watched most. Do this right after posting.</p>
      <ol class="psteps"><li>In Chrome open <b>studio.youtube.com</b>, tap the <b>⋮</b> menu and tick <b>Desktop site</b>.</li>
      <li><b>Content</b> &gt; tap this video &gt; under <b>Thumbnail</b> tap <b>Test &amp; compare</b>.</li>
      <li>Download the 3 thumbnails below and add all 3. If it also offers titles, tap <b>Copy all 3 titles</b> and add them one per box.</li>
      <li>Tap <b>Done</b>, then <b>Save</b>. The winner shows in about 1 to 2 weeks.</li></ol>
      <p class="meta">No Test &amp; compare button? Your channel needs phone verification first (see My to-dos).</p>
      <span class="tclinks" data-id="${esc(j.id)}"></span>
      <button class="pcopy" data-id="${esc(j.id)}" data-what="titles_all">Copy all 3 titles</button></details>`;
  } else {
    out += `<button class="pcopy" data-id="${esc(j.id)}" data-what="social_caption">Copy Reels caption</button>`;
  }
  return out;
}
document.addEventListener('toggle', async (e) => {  // fill the thumbnail links when the box opens
  const box = e.target; if (!box.classList || !box.classList.contains('tcbox') || !box.open) return;
  const sp = box.querySelector('.tclinks'); if (!sp || sp.dataset.done) return;
  try {
    const id = box.dataset.id;
    if (!pkgCache[id]) { const f = await gh.getFile(`packages/${id}.json`); pkgCache[id] = f && f.data; }
    const opts = (pkgCache[id] && pkgCache[id].thumbnail_options) || [];
    sp.innerHTML = opts.map((u, n) => `<a class="btnlink" href="${esc(u)}" target="_blank" rel="noopener" download>Thumbnail ${n + 1}</a>`).join('') || '<span class="meta">Only one thumbnail was made for this video.</span>';
    sp.dataset.done = '1';
  } catch { sp.textContent = 'Could not load the thumbnails.'; }
}, true);

// ---------- reach: Reels status, Reddit and Quora drafts (after posting) ----------
function shareHelper(j) {
  const so = j.social || {};
  const st = (k) => String(so[k] || '').startsWith('ok') ? 'shared ✓' : so[k] ? 'not shared yet' : 'waiting';
  let reels = '';
  if (j.format === 'short') {
    reels = so.instagram || so.facebook
      ? `<p class="meta">Instagram Reel: ${st('instagram')} · Facebook Reel: ${st('facebook')}</p>`
      : `<p class="meta">Instagram and Facebook: shared automatically once connected (see My to-dos). Until then: <b>Download video</b>, <b>Copy Reels caption</b>, and in Instagram tap <b>+</b> &gt; <b>Reel</b>; tick <b>Share to Facebook</b>.</p>
         ${j.video ? `<a class="btnlink" href="${esc(j.video)}" download>Download video</a>` : ''}<button class="pcopy" data-id="${esc(j.id)}" data-what="social_caption">Copy Reels caption</button>`;
  }
  return `<details class="tcbox sharebox"><summary>Share it on Reddit and Quora</summary>
    <p class="meta">You post these by hand: Reddit and Quora ban accounts that post automatically. Read each community's rules, share where it is genuinely useful, and never post the same link in many places at once.</p>
    <h4>Reddit</h4>
    <button class="pcopy" data-id="${esc(j.id)}" data-what="reddit_title">Copy Reddit title</button>
    <button class="pcopy" data-id="${esc(j.id)}" data-what="reddit_body">Copy Reddit post</button>
    <span class="subred" data-id="${esc(j.id)}"></span>
    <h4>Quora</h4>
    <button class="pcopy" data-id="${esc(j.id)}" data-what="quora_question">Copy question</button>
    <button class="pcopy" data-id="${esc(j.id)}" data-what="quora_answer">Copy answer</button>
    <p class="meta">In Quora tap <b>Search</b>, paste the question, open the closest match and tap <b>Answer</b>.</p>
  </details>${reels}`;
}
document.addEventListener('toggle', async (e) => {  // suggested subreddits
  const box = e.target; if (!box.classList || !box.classList.contains('sharebox') || !box.open) return;
  const sp = box.querySelector('.subred'); if (!sp || sp.dataset.done) return;
  try {
    const id = sp.dataset.id;
    if (!pkgCache[id]) { const f = await gh.getFile(`packages/${id}.json`); pkgCache[id] = f && f.data; }
    const subs = ((pkgCache[id] && pkgCache[id].reddit) || {}).subreddits || [];
    sp.innerHTML = subs.length ? subs.map((r) => { const n = String(r).replace(/^\/?r\//, '').replace(/[^A-Za-z0-9_]/g, '');
      return n ? `<a class="btnlink" href="https://www.reddit.com/r/${n}/about/rules" target="_blank" rel="noopener">r/${esc(n)} rules</a>` : ''; }).join('')
      : '<span class="meta">Drafts are made for videos packaged from now on.</span>';
    sp.dataset.done = '1';
  } catch { /* fine */ }
}, true);

// Text for the Copy buttons that need more than one field.
function growText(id, p, what) {
  const j = jobById(id) || {};
  const link = j.youtube_url || '';
  const parent = j.parent_id ? jobById(j.parent_id) : null;
  switch (what) {
    case 'titles_all': return (p.title_options && p.title_options.length ? p.title_options : [p.title]).join('\n');
    case 'social_caption': return p.social_caption || `${p.title || j.topic}\n\nFull story on YouTube: Ember & Ink`;
    case 'reddit_title': return (p.reddit || {}).title || '';
    case 'reddit_body': return (p.reddit || {}).body ? p.reddit.body + (link ? `\n\nI made a short animated video telling this story, if you prefer watching: ${link}` : '') : '';
    case 'quora_question': return (p.quora || {}).question || '';
    case 'quora_answer': return (p.quora || {}).answer ? p.quora.answer + (link ? `\n\nI told this story in a short animated video: ${link}` : '') : '';
    case 'description': return parent && parent.youtube_url && !String(p.description || '').includes(parent.youtube_url)
      ? `Watch the full story: ${parent.youtube_url}\n\n${p.description || ''}` : null;
    default: return null;
  }
}

// ---------- 1: hook options in Review ----------
function hookCard(script) {
  const opts = script.hook_options || []; if (opts.length < 2) return '';
  const best = Number(script.best_hook || 0);
  return `<div class="card"><h2>Opening line</h2><p class="hint">The AI wrote ${opts.length} openings and picked the one most likely to keep viewers past the first 5 seconds.</p>
    ${opts.map((h, n) => `<div class="hookopt${n === best ? ' on' : ''}"><p class="hookline">“${esc(h)}”</p>
      ${n === best ? `<span class="okline">Used in this video${script.hook_reason ? `: ${esc(script.hook_reason)}` : ''}</span>` : `<button type="button" class="usehook" data-n="${n}">Use this opening instead</button>`}</div>`).join('')}</div>`;
}
$('reviewView').addEventListener('click', (e) => {
  const b = e.target.closest('.usehook'); if (!b || !rv) return;
  const h = (rv.script.hook_options || [])[Number(b.dataset.n)]; if (!h) return;
  $('rvRegenBox').hidden = false; $('rvRejectBox').hidden = true;
  const r = document.querySelector('input[name="regen"][value="script"]'); if (r) r.checked = true;
  $('rvNotes').value = `Start with this opening line: "${h}"`;
  $('rvNotes').scrollIntoView({ behavior: 'smooth', block: 'center' }); toast('Check the note, then tap Redo it.');
});

// ---------- 7: comment replies (Review tab) ----------
async function paintComments() {
  const box = $('commentsBox'); if (!box || mode() !== 'github') return;
  let inbox, approved = [];
  try {
    const [f, dir] = await Promise.all([gh.getFile('comments/inbox.json'), gh.call('/contents/comments/approved').catch(() => [])]);
    inbox = (f && f.data) || { items: [] }; approved = (dir || []).map((x) => x.name.replace(/\.json$/, ''));
  } catch { box.innerHTML = ''; return; }
  const open = (inbox.items || []).filter((i) => ['new', 'suggest_skip'].includes(i.status) && !approved.includes(i.id))
    .sort((a, b) => String(b.published).localeCompare(String(a.published)));
  const sent = (inbox.items || []).filter((i) => i.status === 'sent').length;
  box.innerHTML = `<div class="card"><div class="row"><h2>Comment replies</h2><span class="hsum ${open.length ? 'warn' : 'ok'}">${open.length ? `${open.length} to answer` : 'All answered'}</span></div>
    <p class="hint">The AI drafts a friendly reply to each new comment. Change it if you like, then tap <b>Send reply</b>. Nothing is sent without you. New comments are checked every 3 hours.${sent ? ` ${sent} sent recently.` : ''}</p>
    ${inbox.note ? `<p class="msg bad">${esc(inbox.note)}</p>` : ''}
    ${(inbox.items || []).filter((i) => i.error && approved.includes(i.id)).length ? '<p class="hint">Some approved replies are waiting for the YouTube sign-in to be fixed.</p>' : ''}
    ${open.slice(0, 15).map((c) => `<div class="cmt" data-id="${esc(c.id)}">
      <div class="meta">${esc(c.author)} on <b>${esc(c.video_title || 'your video')}</b> · ${esc(new Date(c.published).toLocaleDateString())}${c.question ? ' · <span class="kind">question</span>' : ''}</div>
      <p class="ctext">${esc(c.text)}</p>
      ${c.ai_skip ? '<p class="meta flagnote">The AI suggests skipping this one (spam, or no reply needed).</p>' : ''}
      <textarea rows="3" class="creply" aria-label="Your reply">${esc(c.draft || '')}</textarea>
      <div class="row"><button type="button" class="primary csend" style="flex:2">Send reply</button><button type="button" class="cskip" style="flex:1">Skip</button></div>
    </div>`).join('')}
    ${!open.length && !(inbox.items || []).length ? '<p class="hint">No comments yet. They appear here a few hours after viewers write them.</p>' : ''}</div>`;
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('#commentsBox .csend, #commentsBox .cskip'); if (!b) return;
  const card = b.closest('.cmt'), id = card.dataset.id, skip = b.classList.contains('cskip');
  const reply = card.querySelector('.creply').value.trim();
  if (!skip && !reply) { toast('Write a reply first, or tap Skip.'); return; }
  card.querySelectorAll('button').forEach((x) => { x.disabled = true; });
  try {
    await gh.putFile(`comments/approved/${id}.json`, skip ? { skip: true } : { reply }, skip ? 'Skip a comment' : 'Approve a comment reply');
    card.remove(); toast(skip ? 'Skipped.' : 'Approved. It appears on YouTube in a minute or two.');
  } catch (err) { toast('Could not save: ' + err.message); card.querySelectorAll('button').forEach((x) => { x.disabled = false; }); }
});

// ---------- 5: weekly topic report (Ideas tab) ----------
let weeklyCache = null;
async function paintWeekly() {
  const box = $('weeklyBox'); if (!box || mode() !== 'github') return;
  let r;
  try { const f = await gh.getFile('ideas/weekly.json'); r = f && f.data; } catch { return; }
  weeklyCache = r;
  const ask = '<button type="button" id="askWeekly" class="ghost">Make a new report</button>';
  if (!r) { box.innerHTML = `<div class="card"><h2>Weekly topic report</h2><p class="hint">Every Sunday the app looks at which videos kept viewers watching longest and suggests similar topics and a series.</p>${ask}</div>`; return; }
  const when = new Date(r.created).toLocaleDateString([], { day: 'numeric', month: 'short' });
  box.innerHTML = `<div class="card weekly"><div class="row"><h2>Weekly topic report</h2><span class="meta">${when}</span></div>
    <p class="hint">${esc(r.summary || '')}</p>
    ${(r.based_on || []).length ? `<p class="meta">Based on: ${r.based_on.map(esc).join(' · ')}</p>` : ''}
    ${(r.ideas || []).map((i, n) => `<div class="widea"><b>${esc(i.title || i.topic)}</b> <span class="kind">${i.format === 'long' ? 'Long' : 'Short'}</span>
      <div class="meta">${esc(i.why || i.angle || '')}</div><button type="button" class="wuse" data-n="${n}">Use this</button></div>`).join('')}
    ${r.series ? `<div class="widea"><b>Series idea: ${esc(r.series.name)}</b><div class="meta">${esc(r.series.why || '')}</div>
      <ol class="psteps">${(r.series.parts || []).map((p) => `<li>${esc(p)}</li>`).join('')}</ol><button type="button" class="wseries">Start this series</button></div>` : ''}
    ${ask}<p id="weeklyMsg" class="msg"></p></div>`;
}
document.addEventListener('click', async (e) => {
  const u = e.target.closest('#weeklyBox .wuse');
  if (u && weeklyCache) { useIdea(weeklyCache.ideas[Number(u.dataset.n)]); return; }
  if (e.target.closest('#weeklyBox .wseries') && weeklyCache && weeklyCache.series) {
    const s = weeklyCache.series; useIdea({ topic: (s.parts || [])[0] || s.name, angle: `Part 1 of the series "${s.name}"`, format: 'long' });
    $('series').value = s.name; paintSeriesHint(); toast('Part 1 is filled in. Later parts: type the same series name.'); return;
  }
  if (e.target.closest('#askWeekly')) {
    const b = e.target.closest('#askWeekly'); b.disabled = true;
    try { const old = await gh.getFile('requests/topics.json'); await gh.putFile('requests/topics.json', { requested: new Date().toISOString() }, 'Ask for a topic report', old && old.sha);
      toast('Asked! The report arrives in about 5 minutes. Tap Refresh then.'); }
    catch (err) { toast('Could not ask: ' + err.message); } finally { b.disabled = false; }
  }
});

// ---------- 6 + reach settings (Settings > Growth) ----------
const growth = { cfg: { post_time: '', schedule_public: false, social: { instagram: true, facebook: true } }, sha: null };
function paintGrowth() {
  const c = growth.cfg;
  if ($('postTime')) $('postTime').value = c.post_time || store.get('postTime', '');
  $('schedPub').textContent = c.schedule_public ? 'Automatic uploads go Public at my posting time: ON' : 'Automatic uploads go Public at my posting time: OFF';
  $('igOn').textContent = (c.social || {}).instagram !== false ? 'Share Shorts to Instagram: ON' : 'Share Shorts to Instagram: OFF';
  $('fbOn').textContent = (c.social || {}).facebook !== false ? 'Share Shorts to Facebook: ON' : 'Share Shorts to Facebook: OFF';
}
async function loadGrowth() {
  if (!$('growthCard') || mode() !== 'github') return;
  try {
    const [f, s] = await Promise.all([gh.getFile('config/growth.json'), gh.getFile('stats/latest.json')]);
    if (f) { growth.cfg = { ...growth.cfg, ...f.data }; growth.sha = f.sha; if (f.data.post_time) store.set('postTime', f.data.post_time); }
    const bt = s && s.data && s.data.insights && s.data.insights.best_time;
    $('postTimeHint').innerHTML = bt && bt.slot ? `Your videos do best in the <b>${esc(bt.slot)}</b> (India time). Pick a time in it.`
      : 'Not enough videos yet to know your best time. Evening (about 6 PM India time) is a good start for a global audience.';
  } catch { /* defaults */ }
  paintGrowth();
}
async function saveGrowth(note) {
  try { const r = await gh.putFile('config/growth.json', growth.cfg, 'Update growth settings', growth.sha); growth.sha = r.content.sha; toast(note); }
  catch (err) { toast(err.status === 409 ? 'Changed elsewhere. Open Settings again.' : 'Could not save: ' + err.message); }
  paintGrowth();
}
if ($('growthCard')) {
  $('savePostTime').addEventListener('click', () => {
    const t = $('postTime').value; if (!/^\d{2}:\d{2}$/.test(t)) { toast('Pick a time first.'); return; }
    growth.cfg.post_time = t; store.set('postTime', t); saveGrowth(`Posting time saved: ${postTimeLabel()} every day.`);
  });
  $('schedPub').addEventListener('click', () => { growth.cfg.schedule_public = !growth.cfg.schedule_public; saveGrowth(growth.cfg.schedule_public ? 'Uploads will go Public at your posting time.' : 'Uploads stay Private until you publish them.'); });
  $('igOn').addEventListener('click', () => { growth.cfg.social = { ...growth.cfg.social, instagram: growth.cfg.social.instagram === false }; saveGrowth('Saved.'); });
  $('fbOn').addEventListener('click', () => { growth.cfg.social = { ...growth.cfg.social, facebook: growth.cfg.social.facebook === false }; saveGrowth('Saved.'); });
}

// ---------- 6: posting-time reminder on Home ----------
function paintPostBanner(jobs) {
  const v = $('homeView'); if (!v) return;
  const old = document.getElementById('postBanner'); if (old) old.remove();
  const t = store.get('postTime', ''); if (!t) return;
  const waiting = (jobs || []).filter((j) => j.status === 'post_yourself').length;
  const [h, m] = t.split(':').map(Number), now = new Date(), at = new Date(); at.setHours(h, m, 0, 0);
  const mins = (at - now) / 60000;
  if (!waiting || mins > 120 || mins < -60) return;
  const el = document.createElement('div'); el.id = 'postBanner'; el.className = 'remind';
  el.innerHTML = `<span class="rbell">⏰</span><div><b>${mins > 0 ? `Posting time is ${postTimeLabel()}` : 'It is posting time'}</b><div>${waiting} video${waiting > 1 ? 's are' : ' is'} ready to post. Schedule ${waiting > 1 ? 'them' : 'it'} for ${postTimeLabel()}.</div></div><button type="button" class="rgo" data-go="post">Open</button>`;
  v.prepend(el);
}
