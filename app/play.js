// Story Studio: the livelier, interactive parts (Home, live preview, dice, board, swipe ideas,
// YouTube preview, money goals). Uses the helpers defined in app.js.
'use strict';

// ---------- small shared pieces ----------
const PICS_PER_DAY = 170;  // free Cloudflare picture allowance
function picsFor(j) {  // about one picture per scene (see make_scripts.py)
  if (j.parent_id) return 0;  // clips reuse the long video
  return j.format === 'long' ? Math.round((Number(j.length) || 40) * 150 / ({ often: 16, medium: 25, calm: 37 }[j.pic_pace || (j.created && j.created < '2026-11-21T05:40' ? 'calm' : store.get('picPace', 'often'))] || 16)) + 3 : Math.max(3, Math.round((Number(j.length) || 45) * 2.5 / 12));
}
const dayOf = (j) => j.plan_date || (/^\d{8}/.test(j.id || '') ? `${j.id.slice(0, 4)}-${j.id.slice(4, 6)}-${j.id.slice(6, 8)}` : isoDay(new Date(j.created)));
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
function ring(pct, big, small, color) {
  const r = 34, c = 2 * Math.PI * r, p = Math.max(0, Math.min(1, pct));
  return `<div class="ring"><svg viewBox="0 0 84 84" aria-hidden="true"><circle cx="42" cy="42" r="${r}" class="rbg"/><circle cx="42" cy="42" r="${r}" class="rfg" style="stroke:${color || 'var(--accent)'};stroke-dasharray:${c.toFixed(1)};stroke-dashoffset:${(c * (1 - p)).toFixed(1)}"/></svg>
    <div class="rtxt"><b>${big}</b></div><div class="rlbl">${small}</div></div>`;
}
function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = document.createElement('div'); box.className = 'confetti';
  const cols = ['#c8642e', '#e39a3b', '#2f7d4f', '#2d6a8a', '#f0b25a', '#b3362c'];
  box.innerHTML = Array.from({ length: 70 }, () => `<i style="left:${Math.random() * 100}%;background:${cols[Math.floor(Math.random() * cols.length)]};animation-delay:${(Math.random() * 0.4).toFixed(2)}s;animation-duration:${(1.6 + Math.random() * 1.2).toFixed(2)}s;transform:rotate(${Math.floor(Math.random() * 360)}deg)"></i>`).join('');
  document.body.appendChild(box); setTimeout(() => box.remove(), 3400);
}
// Cheer when a video becomes ready since the last look.
function celebrate(jobs) {
  const seen = store.get('seenStatus', null), now = {};
  jobs.forEach((j) => { now[j.id] = j.status; });
  if (seen) {
    const fresh = jobs.filter((j) => j.status === 'ready' && seen[j.id] && seen[j.id] !== 'ready');
    if (fresh.length) { confetti(); toast(fresh.length > 1 ? `${fresh.length} videos are ready to review!` : `Ready to review: ${fresh[0].title || fresh[0].topic}`); }
  }
  store.set('seenStatus', now);
}
function currentTab() { const t = document.querySelector('.tab.on'); return t ? t.id.replace('tab-', '') : ''; }
setInterval(() => {  // keep Home and Queue fresh while they are on screen
  if (document.hidden || mode() !== 'github') return;
  const t = currentTab();
  if (t === 'queue') loadQueue(true); else if (t === 'home') loadHome(true);
}, 90000);

// ---------- HOME ----------
let homeStats = null;
function streakFrom(days) {
  const set = new Set(days); let d = new Date(), n = 0, today = set.has(isoDay(d));
  if (!today) d = addDays(d, -1);
  while (set.has(isoDay(d))) { n += 1; d = addDays(d, -1); }
  let best = 0, run = 0, prev = null;
  [...set].sort().forEach((k) => { const t = new Date(k + 'T12:00'); run = prev && Math.round((t - prev) / 864e5) === 1 ? run + 1 : 1; best = Math.max(best, run); prev = t; });
  return { n, today, best };
}
async function loadHome(quiet) {
  const v = $('homeView');
  if (mode() === 'none') { v.innerHTML = '<div class="card empty">Connect your GitHub project in Settings to get started.</div>'; return; }
  if (!quiet && !v.innerHTML) v.innerHTML = '<div class="card empty">Loading...</div>';
  let jobs, hist = [];
  try { jobs = mode() === 'github' ? await gh.listJobs() : demo.list(); }
  catch (err) { v.innerHTML = `<div class="card empty">Could not load (${esc(err.message)}).</div>`; return; }
  if (mode() === 'github') {
    try { const [s, h] = await Promise.all([gh.getFile('stats/latest.json'), gh.getFile('stats/history.json')]); homeStats = s && s.data; hist = (h && h.data) || []; } catch { /* stats come later */ }
  }
  queueJobs = jobs; paintReviewCount(jobs); celebrate(jobs);
  const names = gh.names && mode() === 'github' ? gh.names : jobs.map((j) => j.id + '.json');
  const madeDays = names.filter((n) => /^\d{8}/.test(n) && !/-s\d+\.json$/.test(n)).map((n) => `${n.slice(0, 4)}-${n.slice(4, 6)}-${n.slice(6, 8)}`);
  const st = streakFrom(madeDays);
  const live = jobs.filter((j) => j.status !== 'rejected' && !j.parent_id);
  const todayKey = isoDay(new Date());
  const todays = live.filter((j) => dayOf(j) === todayKey);
  const tL = store.get('tLong', 3), tS = store.get('tShort', 3);
  const nL = todays.filter((j) => j.format === 'long').length, nS = todays.filter((j) => j.format === 'short').length;
  const c = (homeStats && homeStats.channel) || {};
  const hr = new Date().getHours(), hello = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  const count = (sts) => jobs.filter((j) => sts.includes(j.status)).length;
  const review = count(['ready']), post = count(['post_yourself']), problems = count(['failed']), making = count(['requested', 'scripting', 'script_ready', 'rendering', 'video_ready']);
  let since = '';
  if (hist.length >= 2) { const a = hist[hist.length - 2], b = hist[hist.length - 1]; since = `<div class="hsince"><span>+${fmtN(Math.max(0, b.views - a.views))} views</span><span>${b.subscribers - a.subscribers >= 0 ? '+' : ''}${fmtN(b.subscribers - a.subscribers)} subscribers</span><span class="tmut">since yesterday</span></div>`; }
  // this week, Monday to Sunday
  const mon = addDays(new Date(), -((new Date().getDay() + 6) % 7));
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(mon, i), k = isoDay(d), js = live.filter((j) => dayOf(j) === k);
    const L = js.filter((j) => j.format === 'long').length, S = js.filter((j) => j.format === 'short').length;
    const full = L >= tL && S >= tS;
    return `<button type="button" class="wday${k === todayKey ? ' now' : ''}${k < todayKey ? ' past' : ''}${full ? ' full' : ''}" data-day="${k}">
      <span class="wd">${d.toLocaleDateString([], { weekday: 'short' })}</span><span class="wn">${d.getDate()}</span>
      <span class="wdots">${'<i class="L"></i>'.repeat(Math.min(L, 4))}${'<i class="S"></i>'.repeat(Math.min(S, 6))}</span></button>`;
  }).join('');
  // badges
  const total = madeDays.length, posted = jobs.some((j) => ['posted', 'uploaded'].includes(j.status));
  const subs = c.subscribers || 0, maxViews = Math.max(0, ...((homeStats && homeStats.recent) || []).map((x) => x.views || 0));
  const badges = [
    ['First video planned', total >= 1, `${Math.min(total, 1)}/1`, '✦'], ['First video posted', posted, posted ? 'Done' : 'Not yet', '▶'],
    ['10 videos', total >= 10, `${Math.min(total, 10)}/10`, '10'], ['50 videos', total >= 50, `${Math.min(total, 50)}/50`, '50'],
    ['3-day streak', st.best >= 3, `best ${st.best}`, '3'], ['7-day streak', st.best >= 7, `best ${st.best}`, '7'], ['30-day streak', st.best >= 30, `best ${st.best}`, '30'],
    ['100 subscribers', subs >= 100, `${fmtN(Math.min(subs, 100))}/100`, '♟'], ['500 subscribers', subs >= 500, `${fmtN(Math.min(subs, 500))}/500`, '♞'], ['1,000 subscribers', subs >= 1000, `${fmtN(Math.min(subs, 1000))}/1,000`, '♛'],
    ['A video with 1,000 views', maxViews >= 1000, `${fmtN(Math.min(maxViews, 1000))}/1,000`, '★'],
  ];
  const earned = badges.filter((b) => b[1]).length;
  v.innerHTML = `
    <div class="hhero">
      <div class="hk">${hello}</div>
      <h1>${esc(c.title || 'Your studio')}</h1>
      <div class="hrow">
        <div class="flame${st.n ? ' lit' : ''}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c1 3.5 5 5.5 5 10.5A5 5 0 0 1 7 12.5c0-2 1-3.5 2-4.5 0 2 1 3 2 3 0-3-1-6 1-9z"/></svg><b>${st.n}</b><span>day${st.n === 1 ? '' : 's'} in a row</span></div>
        <div class="hsubs"><b>${c.subscribers_hidden ? '—' : fmtN(subs)}</b><span>subscribers</span></div>
      </div>
      ${st.n && !st.today ? '<div class="hnote">Plan a video today to keep your streak going.</div>' : ''}
      ${since}
    </div>
    <div id="remindBanner">${$('remindBanner') ? $('remindBanner').innerHTML : ''}</div>
    <div class="card"><div class="row"><h2>Today's mission</h2><span class="meta">${nL + nS} of ${tL + tS} planned</span></div>
      <div class="rings">${ring(tL ? nL / tL : 1, `${nL}/${tL}`, 'Long videos')}${ring(tS ? nS / tS : 1, `${nS}/${tS}`, 'Shorts', 'var(--ok)')}</div>
      ${nL < tL || nS < tS ? `<div class="hacts"><button type="button" data-go="short" class="cchip">+ New Short</button><button type="button" data-go="long" class="cchip">+ New long video</button><button type="button" data-go="dice" class="cchip">Surprise me</button></div>` : '<p class="okline" style="margin:8px 0 0">Today is fully planned. Nice work!</p>'}
    </div>
    <div class="ntiles">
      <button type="button" class="ntile${review ? ' hot' : ''}" data-go="review"><b>${review}</b><span>to review</span></button>
      <button type="button" class="ntile${post ? ' hot' : ''}" data-go="post"><b>${post}</b><span>to post</span></button>
      <button type="button" class="ntile" data-go="work"><b>${making}</b><span>being made</span></button>
      <button type="button" class="ntile${problems ? ' bad' : ''}" data-go="failed"><b>${problems}</b><span>need${problems === 1 ? 's' : ''} attention</span></button>
    </div>
    <div id="todoCard">${$('todoCard') ? $('todoCard').innerHTML : ''}</div>
    ${routineHTML()}
    <div id="healthCard">${$('healthCard') ? $('healthCard').innerHTML : ''}</div>
    <div class="card"><div class="row"><h2>This week</h2><span class="meta"><i class="dotL"></i> long <i class="dotS"></i> Short</span></div>
      <div class="week">${week}</div>
      <button type="button" class="ghostlink" data-go="week">Plan the rest of the week</button></div>
    <div class="card"><div class="row"><h2>Badges</h2><span class="meta">${earned} of ${badges.length}</span></div>
      <div class="badges">${badges.map(([n, ok, prog, ic]) => `<div class="badge${ok ? ' got' : ''}"><span class="bic">${ic}</span><b>${esc(n)}</b><span class="meta">${ok ? 'Earned' : esc(prog)}</span></div>`).join('')}</div></div>
    <div class="shortcuts">
      <button type="button" data-go="ideas">Browse ideas</button><button type="button" data-go="stats">Dashboard</button><button type="button" data-go="money">Income</button>
    </div>`;
  paintHealth(jobs);
  paintTodos();
  if (typeof paintPostBanner === 'function') paintPostBanner(jobs);
}
$('homeView').addEventListener('click', (e) => {
  const b = e.target.closest('[data-go],[data-day]'); if (!b) return;
  const g = b.dataset.go;
  if (b.dataset.day) { store.set('qFilter', 'all'); showTab('queue'); return; }
  if (g === 'short' || g === 'long') { showTab('create'); $('modeSeg').querySelector('[data-v="one"]').click(); document.querySelector(`#formatSeg button[data-v="${g}"]`).click(); $('topic').focus(); }
  else if (g === 'dice') { showTab('create'); $('modeSeg').querySelector('[data-v="one"]').click(); rollDice(); }
  else if (g === 'week') { showTab('create'); $('modeSeg').querySelector('[data-v="week"]').click(); }
  else if (g === 'fix') { showTab('settings'); window.scrollTo(0, 0); runCheckup(); }
  else if (g === 'review') showTab('review');
  else if (g === 'targets') { showTab('settings'); setTimeout(() => $('tLong').scrollIntoView({ block: 'center' }), 50); }
  else if (g === 'yt') { showTab('settings'); setTimeout(() => $('ytCard').scrollIntoView(), 50); }
  else if (g === 'blog') { showTab('money'); setTimeout(() => $('blogCard').scrollIntoView(), 300); }
  else if (g === 'pins') { showTab('money'); setTimeout(() => $('pinCard').scrollIntoView(), 300); }
  else if (g === 'prints') { showTab('money'); setTimeout(() => $('printCard').scrollIntoView(), 300); }
  else if (g === 'health') $('healthCard').scrollIntoView();
  else if (g === 'comments') { showTab('review'); setTimeout(() => $('commentsBox').scrollIntoView({ behavior: 'smooth' }), 600); }
  else if (g === 'growth') { showTab('settings'); setTimeout(() => $('growthCard').scrollIntoView({ block: 'center' }), 50); }
  else if (['post', 'work', 'failed', 'done'].includes(g)) { store.set('qFilter', g === 'post' ? 'ready' : g); store.set('qView', 'list'); showTab('queue'); }
  else showTab(g);
});

// ---------- NEW VIDEO: live preview, dice, picture budget ----------
const TONE_ART = {
  'Fun and witty': ['#f0b25a', '#c8642e', '#3b2a4a'], 'Curious and warm': ['#e9c27a', '#9a5b34', '#2a2f3d'],
  'Dramatic and suspenseful': ['#a33a2a', '#3a1f2a', '#0e1218'], 'Light and funny': ['#9fd3c7', '#e0a458', '#34405a'],
  'Calm and reflective': ['#9fb8c9', '#4d6a80', '#1c2733'], 'Epic and inspiring': ['#f3c46b', '#b0502a', '#1a1f33'],
};
function updatePreview() {
  const pv = $('pv'); if (!pv) return;
  const font = CAPTION_FONTS.find((f) => f[0] === store.get('captionFont', 'Anton')) || CAPTION_FONTS[0];
  const t = $('topic').value.trim() || 'Your topic appears here';
  const art = TONE_ART[$('tone').value] || TONE_ART['Curious and warm'];
  pv.className = 'pv ' + format;
  pv.style.setProperty('--a1', art[0]); pv.style.setProperty('--a2', art[1]); pv.style.setProperty('--a3', art[2]);
  const cap = $('pvCap');
  cap.textContent = font[0] === 'Patrick Hand' ? t : t.toUpperCase();
  cap.style.fontFamily = `${font[1]}, sans-serif`; cap.style.fontWeight = font[0] === 'Poppins' ? '700' : '400';
  const len = Number($('length').value) || 0;
  $('pvBadge').textContent = format === 'short' ? `SHORT · ${len}s` : `LONG · ${len} MIN`;
  $('pvFont').textContent = `Caption font: ${font[0]}`;
  paintBudget();
}
$('pv').addEventListener('click', () => {  // tap to try the next caption font
  const i = CAPTION_FONTS.findIndex((f) => f[0] === store.get('captionFont', 'Anton'));
  const next = CAPTION_FONTS[(i + 1) % CAPTION_FONTS.length][0];
  store.set('captionFont', next); paintFonts(); updatePreview(); toast(`Caption font: ${next}`);
});
['topic', 'theme'].forEach((id) => $(id).addEventListener('input', updatePreview));
$('jobForm').addEventListener('click', (e) => { if (e.target.closest('.cchip, #formatSeg button')) setTimeout(updatePreview, 0); });
$('formatSeg').addEventListener('click', () => setTimeout(updatePreview, 0));

const DICE_TOPICS = [
  ['The Great Emu War of 1932', 'the army that lost to birds'], ['The Dancing Plague of 1518', 'mystery'], ['The night the Library of Alexandria burned', 'turning point'],
  ['How the Rosetta Stone was cracked', 'detective story'], ['The Boston Molasses Flood', 'strange disaster'], ['Ching Shih, the pirate queen', 'forgotten hero'],
  ['The Kingdom of Kush and its pyramids', 'lost civilisation'], ['Building the Great Wall of China', 'how it was made'], ['The fall of Constantinople, 1453', 'last stand'],
  ['Mansa Musa, the richest man in history', 'larger than life'], ['The Christmas Truce of 1914', 'hope in war'], ['The Lost Colony of Roanoke', 'mystery'],
  ['How Nalanda University was built and lost', 'turning point'], ['The Voyage of the Kon-Tiki', 'adventure'], ['Tunguska: the sky that exploded in 1908', 'mystery'],
  ['The Mongol postal relay, the Yam', 'clever invention'], ['Krakatoa, 1883: the loudest sound ever', 'disaster'], ['The Antikythera mechanism', 'ancient computer'],
  ['Rani Lakshmibai of Jhansi', 'forgotten hero'], ['The Tulip Mania of 1637', 'what if'], ['How Shackleton saved all his men', 'survival'], ['The Year Without a Summer, 1816', 'chain reaction'],
];
async function rollDice() {
  const btn = $('diceBtn'); btn.classList.remove('spin'); void btn.offsetWidth; btn.classList.add('spin');
  if (!ideaCache.length && mode() === 'github') { try { const f = await gh.getFile('ideas/latest.json'); ideaCache = (f && f.data.ideas) || []; } catch { /* use the built-in list */ } }
  const pool = ideaCache.filter((i) => (i.format === 'long' ? 'long' : 'short') === format);
  let topic, theme;
  if (pool.length && Math.random() < 0.7) { const i = pool[Math.floor(Math.random() * pool.length)]; topic = i.topic || i.title; theme = i.angle || ''; }
  else { const p = DICE_TOPICS.filter((x) => x[0] !== $('topic').value)[Math.floor(Math.random() * (DICE_TOPICS.length - 1))]; [topic, theme] = p; }
  setTimeout(() => { $('topic').value = topic; $('theme').value = theme; updatePreview(); $('pv').classList.add('flash'); setTimeout(() => $('pv').classList.remove('flash'), 600); }, 450);
}
$('diceBtn').addEventListener('click', rollDice);
let budgetJobs = null, budgetAt = 0;
async function paintBudget() {
  const el = $('budget'); if (!el) return;
  if (mode() === 'github' && Date.now() - budgetAt > 120000) { budgetAt = Date.now(); try { budgetJobs = await gh.listJobs(); } catch { /* keep old */ } }
  const jobs = mode() === 'github' ? (budgetJobs || []) : demo.list();
  const waiting = jobs.filter((j) => ['requested', 'scripting', 'script_ready', 'rendering'].includes(j.status)).reduce((n, j) => n + picsFor(j), 0);
  const mine = picsFor({ format, length: $('length').value, pic_pace: store.get('picPace', 'often') });
  const days = Math.max(1, Math.ceil((waiting + mine) / PICS_PER_DAY));
  const pctW = Math.min(100, (waiting / PICS_PER_DAY) * 100), pctM = Math.min(100 - pctW, (mine / PICS_PER_DAY) * 100);
  el.innerHTML = `<div class="mrow"><span>Free pictures</span><b>${fmtN(waiting + mine)} needed · ${PICS_PER_DAY} a day</b></div>
    <div class="mbar two"><i style="width:${pctW.toFixed(1)}%"></i><i class="me" style="width:${pctM.toFixed(1)}%"></i></div>
    <div class="meta"><span class="dotW"></span> videos in line (${fmtN(waiting)}) <span class="dotM"></span> this one (about ${fmtN(mine)})</div>
    <div class="meta">${days === 1 ? 'Everything fits in today\'s free pictures.' : `Ready in about ${days} days at the free pace.`}</div>`;
}

// ---------- QUEUE: board view ----------
const BOARD = [
  ['Script', ['requested', 'scripting', 'script_ready']], ['Video', ['rendering', 'video_ready']], ['Review', ['ready']],
  ['YouTube', ['approved', 'uploading', 'post_yourself', 'uploaded', 'posted']], ['Problems', ['failed']],
];
function boardHTML(jobs) {
  const recent = Date.now() - 4 * 864e5;
  return `<div class="board">${BOARD.map(([name, sts]) => {
    const js = jobs.filter((j) => sts.includes(j.status) && !(['posted', 'uploaded'].includes(j.status) && new Date(j.posted || j.approved || j.created).getTime() < recent));
    if (name === 'Problems' && !js.length) return '';
    return `<div class="bcol"><div class="bhead"><span>${name}</span><b>${js.length}</b></div>${js.map((j) => `
      <button type="button" class="bcard ${j.format}" data-id="${esc(j.id)}">
        <span class="bfmt">${j.format === 'short' ? 'Short' : 'Long'}${j.kind === 'quiz' ? ' · Quiz' : ''}</span>
        <b>${esc(j.title || j.topic)}</b>
        <span class="meta">${esc(STATUS_TEXT[j.status] || j.status)}${j.plan_date ? ` · ${esc(new Date(j.plan_date + 'T12:00').toLocaleDateString([], { day: 'numeric', month: 'short' }))}` : ''}</span>
        ${['scripting', 'rendering', 'uploading'].includes(j.status) ? '<span class="pulse"></span>' : ''}
      </button>`).join('') || '<div class="bempty">Empty</div>'}</div>`;
  }).join('')}</div>`;
}
function paintQView() { const v = store.get('qView', 'list'); $('qView').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); }
$('qView').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; store.set('qView', b.dataset.v); paintQView(); loadQueue(); });
paintQView();
$('queueList').addEventListener('click', (e) => {
  const b = e.target.closest('.bcard'); if (!b) return;
  const j = queueJobs.find((x) => x.id === b.dataset.id); if (!j) return;
  if (j.status === 'ready') openReview(j.id);
  else if (['post_yourself', 'uploaded', 'failed', 'posted'].includes(j.status)) { store.set('qView', 'list'); store.set('qFilter', j.status === 'failed' ? 'failed' : j.status === 'post_yourself' ? 'ready' : 'done'); paintQView(); loadQueue(); }
  else if (j.status !== 'requested' && mode() === 'github') openScript(j);
  else toast('This one has not started yet.');
});

// ---------- IDEAS: swipe cards ----------
const ideaKey = (i) => String(i.topic || i.title || '').toLowerCase();
function paintIdeaSeg() { const v = store.get('ideaView', 'swipe'); $('ideaView').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); }
$('ideaView').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; store.set('ideaView', b.dataset.v); paintIdeaSeg(); loadIdeas(); });
paintIdeaSeg();
function ideaCard(i, n, top) {
  return `<div class="icard${top ? ' front' : ''}" data-n="${n}">
    <div class="istamp save">SAVE</div><div class="istamp skip">SKIP</div>
    <div class="ihead">${ring((i.score || 0) / 100, i.score || '–', 'score')}<div><span class="kind">${esc(i.kind || 'idea')}</span><span class="kind">${i.format === 'long' ? 'Long' : 'Short'}</span>${i.publish_by ? `<div class="meta">Post by ${esc(i.publish_by)}</div>` : ''}</div></div>
    <h3>${esc(i.title || i.topic)}</h3><p>${esc(i.angle || '')}</p><div class="meta">${esc(i.signal || '')}</div></div>`;
}
function paintIdeaMode() {
  const box = $('ideaCards'); if (!box || store.get('ideaView', 'swipe') !== 'swipe') return;
  const seen = store.get('ideaSeen', []), saved = store.get('ideaSaved', []);
  const left = ideaCache.map((i, n) => ({ i, n })).filter((x) => !seen.includes(ideaKey(x.i)));
  box.innerHTML = `
    <div class="deck">${left.length ? left.slice(0, 3).map((x, k) => ideaCard(x.i, x.n, k === 0)).reverse().join('')
      : `<div class="icard done"><h3>You've seen every idea</h3><p class="hint">New ideas arrive every morning, or tap <b>Get fresh ideas</b> above.</p><button type="button" id="deckReset">Show them again</button></div>`}</div>
    ${left.length ? `<div class="deckbtns"><button type="button" class="dbtn skip" data-act="skip" aria-label="Skip">✕</button><button type="button" class="dbtn make" data-act="make">Make it now</button><button type="button" class="dbtn save" data-act="save" aria-label="Save">★</button></div>
      <p class="hint" style="text-align:center">Swipe right to save, left to skip. ${left.length} left.</p>` : ''}
    ${saved.length ? `<div class="card"><h2>Saved ideas</h2>${saved.map((i, k) => `<div class="saved"><div><b>${esc(i.title || i.topic)}</b><div class="meta">${i.format === 'long' ? 'Long' : 'Short'} · ${esc(i.angle || '')}</div></div><button type="button" data-sv="${k}" class="svmake">Make it</button><button type="button" data-sv="${k}" class="svdel danger" aria-label="Remove">✕</button></div>`).join('')}</div>` : ''}`;
  const top = box.querySelector('.icard.front'); if (top) dragCard(top);
}
function ideaAct(act, n) {
  const i = ideaCache[n]; if (!i) return;
  if (act === 'make') { useIdea(i); return; }
  const seen = store.get('ideaSeen', []); seen.push(ideaKey(i)); store.set('ideaSeen', seen.slice(-300));
  if (act === 'save') { const s = store.get('ideaSaved', []).filter((x) => ideaKey(x) !== ideaKey(i)); s.unshift(i); store.set('ideaSaved', s.slice(0, 30)); toast('Saved for later'); }
  paintIdeaMode();
}
function flyOut(card, dir, act) {
  card.style.transition = 'transform .3s ease-in, opacity .3s'; card.style.transform = `translateX(${dir * 120}%) rotate(${dir * 18}deg)`; card.style.opacity = '0';
  setTimeout(() => ideaAct(act, Number(card.dataset.n)), 260);
}
function dragCard(card) {
  let x0 = null, dx = 0;
  card.addEventListener('pointerdown', (e) => { x0 = e.clientX; dx = 0; card.setPointerCapture(e.pointerId); card.style.transition = 'none'; });
  card.addEventListener('pointermove', (e) => {
    if (x0 === null) return; dx = e.clientX - x0;
    card.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`;
    card.querySelector('.save').style.opacity = Math.max(0, Math.min(1, dx / 90)); card.querySelector('.skip').style.opacity = Math.max(0, Math.min(1, -dx / 90));
  });
  const end = () => {
    if (x0 === null) return; x0 = null;
    if (Math.abs(dx) > 90) { flyOut(card, Math.sign(dx), dx > 0 ? 'save' : 'skip'); return; }
    card.style.transition = 'transform .2s'; card.style.transform = ''; card.querySelectorAll('.istamp').forEach((s) => { s.style.opacity = 0; });
  };
  card.addEventListener('pointerup', end); card.addEventListener('pointercancel', end);
}
$('ideasList').addEventListener('click', (e) => {
  const d = e.target.closest('.dbtn');
  if (d) { const top = document.querySelector('.icard.front'); if (!top) return; if (d.dataset.act === 'make') ideaAct('make', Number(top.dataset.n)); else flyOut(top, d.dataset.act === 'save' ? 1 : -1, d.dataset.act); return; }
  if (e.target.id === 'deckReset') { store.set('ideaSeen', []); paintIdeaMode(); return; }
  const sv = e.target.closest('[data-sv]');
  if (sv) {
    const s = store.get('ideaSaved', []), i = s[Number(sv.dataset.sv)]; if (!i) return;
    if (sv.classList.contains('svmake')) useIdea(i); else { s.splice(Number(sv.dataset.sv), 1); store.set('ideaSaved', s); paintIdeaMode(); }
  }
});

// ---------- REVIEW: YouTube preview, speed, chapters ----------
async function reviewExtras() {
  const { job, pkg, script } = rv; const v = $('reviewView');
  const vid = v.querySelector('video.player'); if (!vid) return;
  const starts = job.scene_starts || [];
  const chs = (script.chapters || []).map((c) => ({ title: c.title, t: starts[(c.scene || 1) - 1] })).filter((c) => typeof c.t === 'number');
  vid.closest('.card').insertAdjacentHTML('beforeend', `<div class="rvtools">
      <button type="button" id="rvFull">Watch full screen</button><button type="button" id="rvSpeed">Speed 1x</button>
      ${job.format === 'long' ? '<button type="button" id="rvBack">Back 10s</button><button type="button" id="rvFwd">Skip 30s</button>' : ''}</div>
    ${chs.length ? `<h3 class="chartttl">Jump to a chapter</h3><div class="chapstrip">${chs.map((c, k) => `<button type="button" class="chap" data-t="${c.t}" data-k="${k}"><span class="cframe"><video muted playsinline preload="none"></video></span><span class="ct">${fmtLen(c.t)}</span><b>${esc(c.title)}</b></button>`).join('')}</div>` : ''}`);
  $('rvFull').addEventListener('click', () => { (vid.requestFullscreen || vid.webkitEnterFullscreen || (() => {})).call(vid); vid.play().catch(() => {}); });
  const speeds = [1, 1.25, 1.5, 2];
  $('rvSpeed').addEventListener('click', () => { const s = speeds[(speeds.indexOf(vid.playbackRate) + 1) % speeds.length] || 1; vid.playbackRate = s; $('rvSpeed').textContent = `Speed ${s}x`; });
  if ($('rvBack')) { $('rvBack').addEventListener('click', () => { vid.currentTime = Math.max(0, vid.currentTime - 10); }); $('rvFwd').addEventListener('click', () => { vid.currentTime += 30; }); }
  const strip = v.querySelector('.chapstrip');
  if (strip) {
    strip.addEventListener('click', (e) => { const b = e.target.closest('.chap'); if (!b) return; vid.currentTime = Number(b.dataset.t) + 0.5; vid.play().catch(() => {}); vid.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    const frames = [...strip.querySelectorAll('.chap')];  // load chapter pictures one after another
    const next = (k) => { if (k >= frames.length) return; const fv = frames[k].querySelector('video'); fv.preload = 'metadata';
      fv.addEventListener('loadeddata', () => next(k + 1), { once: true }); fv.addEventListener('error', () => next(k + 1), { once: true });
      fv.src = `${job.video}#t=${Number(frames[k].dataset.t) + 2}`; };
    next(0);
    vid.addEventListener('timeupdate', () => { let on = -1; chs.forEach((c, k) => { if (vid.currentTime >= c.t) on = k; }); frames.forEach((f, k) => f.classList.toggle('on', k === on)); });
  }
  // YouTube preview, before the details card
  if (!homeStats && mode() === 'github') { try { const s = await gh.getFile('stats/latest.json'); homeStats = s && s.data; } catch { /* name falls back */ } }
  const det = $('rvTitle') && $('rvTitle').closest('.card'); if (!det) return;
  det.insertAdjacentHTML('beforebegin', `<div class="card"><h2>How it will look on YouTube</h2>
    <div class="seg fpseg" id="fpSeg"><button type="button" data-v="home" class="on">Home feed</button><button type="button" data-v="side">Up next</button></div>
    <div id="fpView" class="fpview"></div><p class="hint" id="fpTip" style="margin:10px 0 0"></p></div>`);
  let fp = 'home';
  const paint = () => {
    const title = $('rvTitle').value.trim() || pkg.title, pick = v.querySelector('.thpick.on'), th = pick ? pick.dataset.u : pkg.thumbnail;
    const chan = (homeStats && homeStats.channel && homeStats.channel.title) || 'Your channel', dur = fmtLen(job.video_seconds);
    const pic = th ? `<img src="${esc(th)}" alt="">` : `<video src="${esc(job.video)}#t=2" muted playsinline preload="metadata"></video>`;
    if (job.format === 'short') {
      $('fpView').innerHTML = `<div class="fpshorts"><div class="fpsh">${pic}<span class="fpst">${esc(title)}</span><span class="fpsv">New</span></div><div class="fpsh ghost"></div><div class="fpsh ghost"></div></div>`;
    } else if (fp === 'home') {
      $('fpView').innerHTML = `<div class="fphome"><div class="fpth">${pic}<span class="fpdur">${dur}</span></div><div class="fpmeta"><img class="fpav" src="icons/icon-192.png" alt=""><div><div class="fpt">${esc(title)}</div><div class="fpc">${esc(chan)} · New · just now</div></div></div></div>`;
    } else {
      $('fpView').innerHTML = `${[0, 1, 2].map((k) => k === 1 ? `<div class="fpside"><div class="fpth">${pic}<span class="fpdur">${dur}</span></div><div><div class="fpt">${esc(title)}</div><div class="fpc">${esc(chan)}<br>New · just now</div></div></div>` : '<div class="fpside ghost"><div class="fpth"></div><div><div class="gl"></div><div class="gl s"></div></div></div>').join('')}`;
    }
    $('fpSeg').hidden = job.format === 'short';
    const n = title.length;
    $('fpTip').textContent = n > 70 ? `Phones show about 70 characters, so the last ${n - 70} will be cut off. Put the exciting words first.` : n < 25 ? 'Short and punchy. A curiosity word (secret, why, how) can make it even more clickable.' : 'Good length: the whole title shows on phones.';
  };
  $('fpSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; fp = b.dataset.v; $('fpSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); paint(); });
  $('rvTitle').addEventListener('input', paint);
  v.addEventListener('click', (e) => { if (e.target.closest('.thpick, .chip')) setTimeout(paint, 0); });
  paint();
}

// ---------- INCOME: money goals and sponsor email ----------
const SOURCES = [['ads', 'Ads', 'var(--accent)'], ['affiliate', 'Affiliate', '#2d6a8a'], ['sponsor', 'Sponsor', 'var(--ok)'], ['other', 'Other', 'var(--accent-2)']];
const rupee = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
let mSrc = 'ads';
function earnings() { return store.get('earnings', { entries: [], monthGoal: 5000, bigGoal: 100000 }); }
function paintGoals() {
  const e = earnings(), ym = isoDay(new Date()).slice(0, 7);
  const month = e.entries.filter((x) => x.date.startsWith(ym)).reduce((n, x) => n + x.amount, 0);
  const all = e.entries.reduce((n, x) => n + x.amount, 0);
  const subs = (homeStats && homeStats.channel && homeStats.channel.subscribers) || 0;
  $('rings').innerHTML = ring(month / (e.monthGoal || 1), rupee(month), `This month<br>goal ${rupee(e.monthGoal)}`)
    + ring(all / (e.bigGoal || 1), rupee(all), `All time<br>goal ${rupee(e.bigGoal)}`, 'var(--ok)')
    + ring(subs / 1000, fmtN(subs), 'Subscribers<br>1,000 for ads', '#2d6a8a');
  const by = SOURCES.map(([k, n, c]) => [n, c, e.entries.filter((x) => x.source === k).reduce((s, x) => s + x.amount, 0)]);
  $('srcBar').innerHTML = all ? `<div class="srcbar">${by.filter((b) => b[2]).map(([, c, a]) => `<i style="width:${(a / all) * 100}%;background:${c}"></i>`).join('')}</div>
    <div class="srcleg">${by.map(([n, c, a]) => `<span><i style="background:${c}"></i>${n} ${rupee(a)}</span>`).join('')}</div>` : '<p class="hint" style="text-align:center">Your first rupee will show up here.</p>';
  $('mSrc').innerHTML = SOURCES.map(([k, n]) => `<button type="button" class="cchip${k === mSrc ? ' on' : ''}" data-s="${k}">${n}</button>`).join('');
  $('mLog').innerHTML = e.entries.length ? `<h3 class="chartttl">Recent</h3>${e.entries.slice(0, 8).map((x, k) => `<div class="affrow"><div><b>${rupee(x.amount)}</b> · ${esc((SOURCES.find((s) => s[0] === x.source) || [0, 'Other'])[1])}<div class="meta">${esc(new Date(x.date + 'T12:00').toLocaleDateString([], { dateStyle: 'medium' }))}${x.note ? ' · ' + esc(x.note) : ''}</div></div><button class="danger mdel" data-k="${k}">Remove</button></div>`).join('')}` : '';
  $('mGoalM').value = e.monthGoal; $('mGoalB').value = e.bigGoal;
}
$('mSrc').addEventListener('click', (ev) => { const b = ev.target.closest('[data-s]'); if (b) { mSrc = b.dataset.s; paintGoals(); } });
$('mQuick').addEventListener('click', (ev) => { const b = ev.target.closest('[data-a]'); if (b) $('mAmt').value = b.dataset.a; });
$('mAdd').addEventListener('click', () => {
  const amount = Math.round(Number($('mAmt').value)); if (!(amount > 0)) { toast('Type how much you received.'); return; }
  const e = earnings(); const before = e.entries.filter((x) => x.date.startsWith(isoDay(new Date()).slice(0, 7))).reduce((n, x) => n + x.amount, 0);
  e.entries.unshift({ date: isoDay(new Date()), source: mSrc, amount, note: $('mNote').value.trim() }); store.set('earnings', e);
  $('mAmt').value = ''; $('mNote').value = ''; paintGoals();
  if (before < e.monthGoal && before + amount >= e.monthGoal) { confetti(); toast('Monthly goal reached!'); } else toast('Added. Keep going!');
});
$('mLog').addEventListener('click', (ev) => { const b = ev.target.closest('.mdel'); if (!b) return; const e = earnings(); e.entries.splice(Number(b.dataset.k), 1); store.set('earnings', e); paintGoals(); });
$('mGoalSave').addEventListener('click', () => { const e = earnings(); e.monthGoal = Math.max(1, Math.round(Number($('mGoalM').value)) || 5000); e.bigGoal = Math.max(1, Math.round(Number($('mGoalB').value)) || 100000); store.set('earnings', e); paintGoals(); toast('Goals saved'); });
async function loadGoals() {
  if (!homeStats && mode() === 'github') { try { const s = await gh.getFile('stats/latest.json'); homeStats = s && s.data; } catch { /* rings still work */ } }
  paintGoals();
}
function pitchText() {
  const brand = $('spBrand').value.trim() || 'your team', why = $('spWhy').value.trim();
  const c = (homeStats && homeStats.channel) || {}, l = homeStats && homeStats.last28, chan = c.title || 'my channel';
  const offers = $('kitOffers').value.split('\n').map((x) => x.trim()).filter(Boolean);
  const nums = [c.subscribers && !c.subscribers_hidden ? `${fmtN(c.subscribers)} subscribers` : '', l && l.views ? `${fmtN(l.views)} views in the last 28 days` : '', c.videos ? `${fmtN(c.videos)} videos` : ''].filter(Boolean);
  const subject = `Partnership idea: ${chan} x ${brand}`;
  const body = `Hi ${brand},

I make ${chan}, a YouTube channel that tells true stories from history in richly illustrated, easy-to-follow videos. ${$('kitAbout').value.trim()}
${nums.length ? `\nLatest numbers: ${nums.join(', ')}.` : ''}${$('kitAudience').value.trim() ? `\nWho watches: ${$('kitAudience').value.trim()}.` : ''}

I think ${brand} would be a natural fit${why ? ` because of ${why}` : ''}. Some ways we could work together:
${(offers.length ? offers : ['A short sponsor mention in a long video', 'A link pinned in the description']).map((o) => `- ${o}`).join('\n')}

My media kit, with numbers that update every day: ${new URL('kit.html', location.href).href}

Would you be open to a quick chat?

Best regards,
${chan}`;
  return { subject, body: body.replace(/\n{3,}/g, '\n\n') };
}
$('spMake').addEventListener('click', async () => {
  if (!homeStats && mode() === 'github') { try { const s = await gh.getFile('stats/latest.json'); homeStats = s && s.data; } catch { /* write without numbers */ } }
  const p = pitchText(); $('spText').value = `Subject: ${p.subject}\n\n${p.body}`;
  $('spMail').href = `mailto:?subject=${encodeURIComponent(p.subject)}&body=${encodeURIComponent(p.body)}`; $('spMail').hidden = false;
  const subs = (homeStats && homeStats.channel && homeStats.channel.subscribers) || 0;
  $('spMsg').textContent = subs < 1000 ? 'Tip: big brands usually want 1,000+ subscribers. Small book shops, authors and history apps are great first sponsors.' : '';
});
$('spCopy').addEventListener('click', async () => { if (!$('spText').value) $('spMake').click(); try { await navigator.clipboard.writeText($('spText').value); toast('Email copied'); } catch { toast('Could not copy. Long-press the text instead.'); } });

// ---------- HOME: health card (expiry dates and deadlines) ----------
const AUDIT_SENT = '2026-11-21';
let healthCache = { at: 0, runs: {}, repo: null };
const fmtDay = (d) => new Date(d).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
const daysTo = (d) => Math.ceil((new Date(d) - new Date()) / 864e5);
async function healthData() {
  if (Date.now() - healthCache.at < 30 * 60000) return healthCache;
  const c = gh.conf(), runs = {};
  await Promise.all(['writer', 'render', 'upload', 'stats'].map(async (w) => {
    try {  // public project: readable without the key, so this works even if the key lacks Actions access
      const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(c.user)}/${encodeURIComponent(c.repo)}/actions/workflows/${w}.yml/runs?per_page=1&status=completed`, { cache: 'no-store' });
      if (r.ok) { const d = await r.json(); runs[w] = (d.workflow_runs || [])[0] || null; }
    } catch { /* offline */ }
  }));
  let repo = null; try { repo = await gh.test(); } catch { /* key problem shows below */ }
  healthCache = { at: Date.now(), runs, repo };
  return healthCache;
}
function hRow(level, title, detail, action) {
  return `<div class="hrowi ${level}"><span class="hdot"></span><div class="hmain"><b>${title}</b><div class="meta">${detail}</div>${action || ''}</div></div>`;
}
async function paintHealth(jobs) {
  const el = $('healthCard'); if (!el || mode() !== 'github') { if (el) el.innerHTML = ''; return; }
  const h = await healthData(), s = homeStats || {}, rows = [];
  // 1. GitHub access key
  const pat = store.get('patExpiry', '');
  const patHelp = '<div class="hhelp" hidden>Find the date on GitHub: your photo &gt; Settings &gt; Developer settings &gt; Personal access tokens &gt; Fine-grained tokens. It is shown next to your key.<input type="date" class="hdate" data-k="patExpiry"></div>';
  if (!h.repo) rows.push(hRow('bad', 'GitHub access key', 'GitHub refused the key. It has probably expired. On GitHub, open your key and tap <b>Regenerate token</b>, then paste the new key in Settings.', ''));
  else if (!pat) rows.push(hRow('warn', 'GitHub access key', 'Working. Add its expiry date so the app can warn you in time.', `<button type="button" class="hset">Add expiry date</button>${patHelp}`));
  else { const n = daysTo(pat + 'T23:59'); rows.push(hRow(n <= 10 ? (n < 0 ? 'bad' : 'warn') : 'ok', 'GitHub access key', `${n < 0 ? 'Expired on' : 'Expires on'} <b>${fmtDay(pat)}</b>${n >= 0 ? ` · ${n} day${n === 1 ? '' : 's'} left` : ''}. ${n <= 10 ? 'Regenerate it on GitHub now and paste the new key in Settings.' : ''}`, `<button type="button" class="hset">Change date</button>${patHelp}`)); }
  // 2. YouTube sign-in
  const upd = s.updated ? new Date(s.updated) : null, age = upd ? (Date.now() - upd) / 36e5 : null;
  if (!upd && !s.error) rows.push(hRow('warn', 'YouTube sign-in', 'No check yet. It is checked every morning at 7 AM.'));
  else if (s.sign_in_failed || s.error) rows.push(hRow('bad', 'YouTube sign-in', `${esc(s.error || 'Stopped working.')} Then update the YT_REFRESH_TOKEN secret on GitHub.`));
  else if (age > 36) rows.push(hRow('warn', 'YouTube sign-in', `Last checked ${fmtDay(upd)}. The morning check has not run since. Tell Claude if this stays.`));
  else rows.push(hRow('ok', 'YouTube sign-in', `Working · checked ${upd.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}. No expiry date: it stays active as long as it is used, and it is used every day.`));
  // 3. YouTube audit
  if (store.get('auditOk', false)) rows.push(hRow(store.get('ytAuto', false) ? 'ok' : 'warn', 'YouTube audit', store.get('ytAuto', false) ? 'Approved, and Automatic upload is on.' : 'Approved. Turn on <b>Automatic upload</b> in Settings so approved videos go straight to YouTube.'));
  else { const wait = -daysTo(AUDIT_SENT); rows.push(hRow('wait', 'YouTube audit', `Sent on ${fmtDay(AUDIT_SENT)} · waiting ${wait} day${wait === 1 ? '' : 's'} for Google's email. Until then, post videos yourself from the Queue.`, '<button type="button" class="haudit">Google approved it</button>')); }
  // 4. Cloud workers
  const names = { writer: 'Scripts', render: 'Videos', upload: 'Uploads', stats: 'Stats' };
  const known = Object.entries(h.runs).filter(([, r]) => r);
  const broken = known.filter(([, r]) => r.conclusion === 'failure');
  if (!known.length) rows.push(hRow('wait', 'Cloud workers', 'Could not check right now.'));
  else rows.push(hRow(broken.length ? 'bad' : 'ok', 'Cloud workers', broken.length ? `Last run failed: ${broken.map(([w]) => names[w]).join(', ')}. It usually fixes itself on the next run; tell Claude if it stays red.` : `All working · ${known.map(([w, r]) => `${names[w]} ${new Date(r.updated_at || r.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`).join(' · ')}`));
  // 5. GitHub's 60-day pause of scheduled jobs
  if (h.repo && h.repo.pushed_at) { const until = new Date(new Date(h.repo.pushed_at).getTime() + 60 * 864e5); rows.push(hRow(daysTo(until) < 14 ? 'warn' : 'ok', 'Daily schedule', `Stays switched on until at least ${fmtDay(until)}. The date moves forward every time the app saves something, so it never runs out while you use it.`)); }
  // 6. Free AI limits
  const limitHits = jobs.filter((j) => j.status === 'failed' || j.error).filter((j) => /quota|limit|429|busy|exhaust/i.test(j.error || '')).length;
  rows.push(hRow(limitHits ? 'warn' : 'ok', 'Free AI allowances', limitHits ? `${limitHits} video${limitHits > 1 ? 's are' : ' is'} waiting for the free daily allowance to reset (scripts at 1:30 PM, pictures at 5:30 AM India time). Tell Claude if this keeps happening.` : 'Within the free limits. No expiry dates.'));
  // 7. Amazon Associates (optional)
  const amz = store.get('amazonJoined', '');
  const amzHelp = '<div class="hhelp" hidden>The date you were accepted into Amazon Associates.<input type="date" class="hdate" data-k="amazonJoined"></div>';
  if (amz) { const until = new Date(new Date(amz + 'T12:00').getTime() + 180 * 864e5), n = daysTo(until); rows.push(hRow(n < 30 ? 'warn' : 'wait', 'Amazon Associates', `Needs 3 sales by <b>${fmtDay(until)}</b> (${Math.max(0, n)} days left), or the account closes. You can join again afterwards.`, `<button type="button" class="hset">Change date</button>${amzHelp}`)); }
  else rows.push(hRow('none', 'Amazon Associates', 'Not joined yet. When you join, add the date and the app tracks the 180-day deadline.', `<button type="button" class="hset">Add join date</button>${amzHelp}`));
  const nBad = rows.filter((r) => r.includes('hrowi bad')).length, nWarn = rows.filter((r) => r.includes('hrowi warn')).length;
  el.innerHTML = `<div class="card health"><div class="row"><h2>Health</h2><span class="hsum ${nBad ? 'bad' : nWarn ? 'warn' : 'ok'}">${nBad ? `${nBad} need${nBad > 1 ? '' : 's'} you now` : nWarn ? `${nWarn} to look at` : 'All good'}</span></div>${rows.join('')}<button type="button" class="hfix">Check and fix problems</button></div>`;
}
$('homeView').addEventListener('click', (e) => {
  const set = e.target.closest('.hset');
  if (set) { const help = set.nextElementSibling; help.hidden = !help.hidden; if (!help.hidden) { const i = help.querySelector('input'); i.value = store.get(i.dataset.k, ''); i.focus(); } return; }
  if (e.target.closest('.hfix')) { showTab('settings'); window.scrollTo(0, 0); runCheckup(); return; }
  if (e.target.closest('.haudit')) { store.set('auditOk', true); confetti(); toast('Great news! Now turn on Automatic upload in Settings.'); paintHealth(queueJobs); }
});
$('homeView').addEventListener('change', (e) => {
  const i = e.target.closest('.hdate'); if (!i || !i.value) return;
  store.set(i.dataset.k, i.value); toast('Date saved'); paintHealth(queueJobs);
});

// ---------- Settings: check-up and repair ----------
const STUCK_BACK = { scripting: 'requested', rendering: 'script_ready', uploading: 'approved' };
const ago = (j) => { const t = j.updated || j.started || j.claimed || j.created; return t ? (Date.now() - new Date(t)) / 36e5 : 0; };
async function releaseAssets(id) {
  const c = gh.conf();
  const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(c.user)}/${encodeURIComponent(c.repo)}/releases/tags/video-${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (r.status === 404) return [];
  if (!r.ok) return null;  // unknown (rate limit): skip
  return ((await r.json()).assets || []).map((a) => a.name);
}
async function editJob(id, change, message) {
  const f = await gh.getFile(`jobs/${id}.json`); if (!f) throw new Error('not found');
  const job = { ...f.data, ...change };
  ['error', 'attempts', 'render_attempts', 'package_attempts', 'upload_attempts', 'failed_step'].forEach((k) => { if (!(k in change)) delete job[k]; });
  await gh.putFile(`jobs/${id}.json`, job, message, f.sha);
}
let fixes = [];
async function runCheckup() {
  const out = $('fixList'); const btn = $('fixRun');
  if (mode() !== 'github') { out.innerHTML = '<p class="hint">Connect your GitHub project first.</p>'; return; }
  btn.disabled = true; btn.textContent = 'Checking...'; out.innerHTML = '<p class="hint">Looking at every part of the app. This takes about 20 seconds.</p>';
  fixes = []; const ok = [];
  try { await gh.test(); ok.push('GitHub access key works'); }
  catch (e) { fixes.push({ t: 'GitHub refused your access key', d: 'Make a new key on GitHub (Regenerate token) and paste it in the box at the top of Settings.', manual: true }); }
  let jobs = [];
  try { gh._jc = {}; jobs = await gh.listJobs(); ok.push(`Read ${jobs.length} videos`); } catch { /* covered above */ }
  jobs.filter((j) => STUCK_BACK[j.status] && ago(j) > (j.status === 'rendering' && j.format === 'long' ? 7 : 3)).forEach((j) => fixes.push({ t: `Stuck: ${j.title || j.topic}`, d: `"${STATUS_TEXT[j.status]}" for much longer than usual. Start that step again.`,
    run: () => editJob(j.id, { status: STUCK_BACK[j.status] }, `Repair stuck job: ${j.topic.slice(0, 50)}`) }));
  jobs.filter((j) => j.status === 'failed').forEach((j) => fixes.push({ t: `Failed: ${j.title || j.topic}`, d: esc(j.error || 'Something went wrong').replace(/\.?$/, '.') + ' Try it again.',
    run: () => editJob(j.id, { status: { video: 'script_ready', package: 'video_ready', upload: 'approved' }[j.failed_step] || 'requested' }, `Repair: try again ${j.topic.slice(0, 50)}`) }));
  const withVideo = jobs.filter((j) => j.video && ['video_ready', 'ready', 'approved', 'post_yourself'].includes(j.status)).slice(0, 12);
  for (const j of withVideo) {
    const names = await releaseAssets(j.id); if (names === null || names.includes('video.mp4')) continue;
    if (names.includes('video_wrapped.mp4')) fixes.push({ t: `Video won't open: ${j.title || j.topic}`, d: 'The file was saved under the wrong name. The cloud renames it on its next run (within the hour), no pictures needed.', run: () => nudge() });
    else fixes.push({ t: `Video file missing: ${j.title || j.topic}`, d: 'The video file is gone. Make the video again from the same script (uses free pictures).', run: () => editJob(j.id, { status: 'script_ready', revision: (j.revision || 0) + 1 }, `Repair: remake video ${j.topic.slice(0, 50)}`) });
  }
  if (withVideo.length) ok.push(`Checked ${withVideo.length} video files`);
  try {  // video files left behind by videos deleted earlier
    const names = new Set((gh.names || []).map((n) => n.replace(/\.json$/, '')));
    const rels = await gh.call('/releases?per_page=100');
    const left = rels.filter((r) => /^(video|work)-/.test(r.tag_name) && !names.has(r.tag_name.replace(/^(video|work)-/, '').replace(/-r\d+$/, '')));
    if (left.length) fixes.push({ t: `${left.length} leftover video file${left.length > 1 ? 's' : ''}`, d: 'From videos you deleted. Remove them to keep your project tidy.', run: () => deleteReleases((t) => left.some((r) => r.tag_name === t)) });
  } catch { /* skip */ }
  jobs.filter((j) => j.error && ['video_ready', 'ready', 'post_yourself', 'posted', 'uploaded'].includes(j.status)).forEach((j) => fixes.push({ t: `Old warning on: ${j.title || j.topic}`, d: `"${esc(j.error)}" is out of date. Clear it.`, run: () => editJob(j.id, {}, `Clear old warning: ${j.topic.slice(0, 50)}`) }));
  const waiting = jobs.filter((j) => ['requested', 'script_ready', 'video_ready'].includes(j.status) && ago(j) > 6 && !(j.plan_date && j.plan_date > isoDay(new Date())));
  if (waiting.length) fixes.push({ t: `${waiting.length} video${waiting.length > 1 ? 's' : ''} waiting a long time`, d: 'Wake up the cloud workers now instead of waiting for their hourly run. (If free pictures ran out, they continue after 5:30 AM.)', run: () => nudge() });
  try { const s = await gh.getFile('stats/latest.json'); if (s && s.data && (s.data.error || s.data.sign_in_failed)) fixes.push({ t: 'YouTube sign-in stopped working', d: 'Tap Sign in with Google in Settings, then update the YT_REFRESH_TOKEN secret on GitHub.', manual: true }); else if (s) ok.push('YouTube sign-in works'); } catch { /* ignore */ }
  btn.disabled = false; btn.textContent = 'Run the check-up again';
  out.innerHTML = (fixes.length ? `<p class="flagnote">${fixes.length} problem${fixes.length > 1 ? 's' : ''} found</p>${fixes.map((f, k) => `<div class="fixrow" data-k="${k}"><div><b>${esc(f.t)}</b><div class="meta">${f.d}</div></div>${f.manual ? '<span class="meta">You need to do this</span>' : `<button type="button" class="fixone" data-k="${k}">Fix</button>`}</div>`).join('')}
    ${fixes.some((f) => !f.manual) ? '<button class="primary" id="fixAll">Fix everything</button>' : ''}` : '<p class="okline">No problems found.</p>')
    + `<ul class="tips oklist">${ok.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
}
async function nudge() {
  const old = await gh.getFile('requests/nudge.json');
  await gh.putFile('requests/nudge.json', { at: new Date().toISOString() }, 'Wake up the cloud workers', old && old.sha);
}
async function doFix(k) {
  const f = fixes[k]; if (!f || f.done || !f.run) return;
  const row = document.querySelector(`.fixrow[data-k="${k}"]`), b = row && row.querySelector('button');
  if (b) { b.disabled = true; b.textContent = 'Fixing...'; }
  try { if (f.run === nudge && fixes.some((x) => x.done && x.run === nudge)) { /* already woken */ } else await f.run(); f.done = true; if (b) { b.textContent = 'Fixed'; row.classList.add('fixed'); } }
  catch (e) { if (b) { b.disabled = false; b.textContent = 'Try again'; } toast('Could not fix: ' + e.message); }
}
$('fixRun').addEventListener('click', runCheckup);
$('fixApp').addEventListener('click', async () => {
  try { if ('serviceWorker' in navigator) { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map((r) => r.unregister())); }
    if (window.caches) { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); } } catch { /* reload anyway */ }
  toast('Loading the newest version...'); setTimeout(() => location.reload(), 600);
});
$('fixNudge').addEventListener('click', async () => { try { await nudge(); toast('Cloud workers woken up. Check the Queue in a few minutes.'); } catch (e) { toast('Could not reach GitHub: ' + e.message); } });
$('fixList').addEventListener('click', async (e) => {
  const one = e.target.closest('.fixone'); if (one) { await doFix(Number(one.dataset.k)); return; }
  if (e.target.id === 'fixAll') { e.target.disabled = true; for (let k = 0; k < fixes.length; k += 1) await doFix(k); e.target.textContent = 'All fixed'; confetti(); toast('Repairs sent. The cloud picks them up in a few minutes.'); }
});

// ---------- HOME: daily routine (about 30 minutes) ----------
const ROUTINE = {
  daily: [
    ['health', 'Glance at the Health card', 'Anything red or orange? Tap Check and fix problems.', 'fix', '1 min'],
    ['review', 'Review finished videos', 'Watch at 1.5x or 2x, check flagged facts, pick a thumbnail, then Approve, Regenerate or Reject.', 'review', '15 min'],
    ['post', 'Post approved videos', 'Queue > Needs you: follow the numbered steps. Schedule each one for your posting time, pick the Related video on Shorts, then paste the link and tap I posted it. On long videos, also set up Test & compare.', 'post', '10 min'],
    ['plan', "Plan tomorrow's videos", 'Swipe through Ideas or tap Surprise me, then Start making it. Watch the picture meter.', 'ideas', '4 min'],
    ['reply', 'Approve comment replies', 'Review > Comment replies: read each AI draft, change it if you like, tap Send reply or Skip. Hearting comments in the YouTube Studio app helps too.', 'comments', '3 min'],
    ['share', 'Share one video on Reddit or Quora', 'Queue > Done: open Share it on Reddit and Quora under a posted video, copy the draft and post it by hand. One a day is plenty.', 'done', '3 min'],
  ],
  weekly: [
    ['report', 'Read your weekly report card', 'Dashboard: grade, star video, what is working and the best time to post.', 'stats', '3 min'],
    ['topics', 'Read the weekly topic report', 'Ideas tab, top card: topics like the videos that kept viewers watching, plus a series idea. Tap Use this on one or two.', 'ideas', '3 min'],
    ['test', 'Check Test & compare winners', 'Chrome, studio.youtube.com (Desktop site) > Content: open last week\'s long videos and see which thumbnail won.', '', '3 min'],
    ['week', 'Plan the whole week', 'New video > Plan the week. Put anniversaries on their exact day.', 'week', '10 min'],
    ['money', 'Update money and sponsors', 'Income: log any payouts, and send one sponsor email.', 'money', '5 min'],
  ],
};
function routineState() {
  const today = isoDay(new Date()), mon = isoDay(addDays(new Date(), -((new Date().getDay() + 6) % 7)));
  const st = store.get('routine', {});
  if (st.day !== today) { st.day = today; st.daily = []; }
  if (st.week !== mon) { st.week = mon; st.weekly = []; }
  return st;
}
function routineHTML() {
  const st = routineState(), sunday = new Date().getDay() === 0;
  const item = (kind) => ([k, t, d, go, m]) => { const on = (st[kind] || []).includes(k);
    return `<div class="rtask${on ? ' done' : ''}"><button type="button" class="rtick" data-rk="${kind}:${k}" aria-label="Mark done">${on ? '✓' : ''}</button>
      <div class="rbody"><b>${esc(t)}</b> <span class="rmin">${m}</span><div class="meta">${esc(d)}</div>${go ? `<button type="button" class="rgo" data-go="${go}">Open</button>` : ''}</div></div>`; };
  const nd = (st.daily || []).length, nt = ROUTINE.daily.length;
  return `<div class="card routine"><div class="row"><h2>Today's routine</h2><span class="meta">${nd} of ${nt} done · about 30 min</span></div>
    <div class="mbar" style="margin:4px 0 6px"><i style="width:${(nd / nt) * 100}%"></i></div>
    ${ROUTINE.daily.map(item('daily')).join('')}
    <details class="rweek"${sunday ? ' open' : ''}><summary>Once a week${sunday ? ' (today is a good day)' : ''} · ${(st.weekly || []).length} of ${ROUTINE.weekly.length} done</summary>${ROUTINE.weekly.map(item('weekly')).join('')}</details></div>`;
}
$('homeView').addEventListener('click', (e) => {
  const t = e.target.closest('.rtick[data-rk]'); if (!t) return;
  const [kind, k] = t.dataset.rk.split(':'); const st = routineState();
  st[kind] = (st[kind] || []).includes(k) ? st[kind].filter((x) => x !== k) : [...(st[kind] || []), k];
  store.set('routine', st);
  const card = t.closest('.routine'), open = card.querySelector('details').open;
  card.outerHTML = routineHTML(); if (open) document.querySelector('.routine details').open = true;
  if (kind === 'daily' && st.daily.length === ROUTINE.daily.length) { confetti(); toast('Daily routine done. See you tomorrow!'); }
});

// ---------- delete a video for good (files in the project + its video files) ----------
async function deleteFile(path, message) {
  let f; try { f = await gh.call(`/contents/${path}`); } catch (e) { if (e.status === 404) return; throw e; }
  await gh.call(`/contents/${path}`, { method: 'DELETE', body: JSON.stringify({ message, sha: f.sha }) });
}
async function deleteReleases(match) {
  const rels = await gh.call('/releases?per_page=100');
  for (const r of rels.filter((x) => match(x.tag_name))) {
    await gh.call(`/releases/${r.id}`, { method: 'DELETE' });
    try { await gh.call(`/git/refs/tags/${encodeURIComponent(r.tag_name)}`, { method: 'DELETE' }); } catch { /* tag already gone */ }
  }
}
async function deleteVideo(id) {
  const ids = [id, ...queueJobs.filter((j) => j.parent_id === id).map((j) => j.id)];  // its cut-down Shorts too
  for (const x of ids) for (const dir of ['jobs', 'scripts', 'packages']) await deleteFile(`${dir}/${x}.json`, `Delete video ${x}`);
  try { await deleteReleases((t) => ids.some((x) => t === `video-${x}` || t.startsWith(`work-${x}-`))); }
  catch (e) { if (e.status !== 403) throw e; toast('Deleted. The big video file stays on GitHub (your key cannot remove it).'); }
  if (gh._jc) ids.forEach((x) => delete gh._jc[x + '.json']);
}

// ---------- HOME: my to-dos (one-time jobs, future jobs, and things to always keep in mind) ----------
// Items tick themselves when the app can see they are done; the rest you tick by hand.
let todoInfo = { at: 0, blog: {}, articles: 0, amazonTag: '' };
async function todoData() {
  if (Date.now() - todoInfo.at < 10 * 60000 || mode() !== 'github') return todoInfo;
  const info = { at: Date.now(), blog: {}, articles: 0, amazonTag: '' };
  try {
    const [st, cfg, dir] = await Promise.all([gh.getFile('blog/status.json'), gh.getFile('config/blog.json'), gh.call('/contents/blog').catch(() => [])]);
    info.blog = (st && st.data) || {}; info.amazonTag = ((cfg && cfg.data) || {}).amazon_tag || '';
    info.articles = (dir || []).filter((f) => /^\d.*\.json$/.test(f.name)).length;  // written or published
    info.published = Number(info.blog.published || 0);
  } catch { /* shown as not known yet */ }
  todoInfo = info; return info;
}
function todoList(d) {
  const pub = d.published || 0;
  const ch = (homeStats && homeStats.channel) || {}, ypp = (homeStats && homeStats.ypp) || {};
  const subs = ch.subscribers || 0, views = ch.views || 0, hours = Math.round(ypp.long_watch_hours_365 || 0), sv = ypp.shorts_views_90 || 0;
  // Amazon: worth joining once people are actually seeing the links (3 sales are needed within 180 days of joining)
  const amzReady = pub >= 10 || subs >= 100 || views >= 5000;
  const amzJoined = store.get('amazonJoined', '');
  const amzLeft = amzJoined ? daysTo(new Date(new Date(amzJoined + 'T12:00').getTime() + 180 * 864e5)) : null;
  return {
    now: [
      { k: 'checkup', t: 'Run the check-up once', d: 'Settings > Fix problems > <b>Run a check-up</b>, then tap <b>Fix everything</b> (the Run it now button below does the first part for you). This removes leftover files from the videos you deleted.', go: 'fix', btn: 'Run it now' },
      { k: 'pat', t: 'Add your GitHub key\'s expiry date', d: 'On the Health card, tap <b>Add expiry date</b>. The app then warns you 10 days before the key stops working.', go: 'health', btn: 'Go to Health card', auto: !!store.get('patExpiry', '') },
      { k: 'target', t: 'Set your daily target', d: 'Settings > <b>Long videos per day</b>: 1, <b>Shorts per day</b>: 3, then tap <b>Save targets</b>. That fits the free pictures each day.', go: 'targets', btn: 'Open targets', auto: !!store.get('targetsSaved', false) },
      { k: 'greatfire', t: 'Delete the old Great Fire Short on YouTube', d: 'YouTube Studio app > <b>Content</b> > <b>Shorts</b> > tap the three dots next to the private Great Fire Short > <b>Delete forever</b>.' },
      { k: 'blog', t: 'Connect the blog', d: 'Done when the Blog box in Income says Connected.', go: 'blog', btn: 'Open Blog', auto: !!d.blog.connected },
      { k: 'pinterest', t: 'Set up Pinterest (15 minutes, once)', d: 'Make a free Pinterest business account, make a <i>History Stories</i> board and prove the blog is yours. Then, once the Pinterest box says a pin is ready, paste your pin list link under <b>Settings</b> &gt; <b>Create Pins in bulk</b> &gt; <b>Connect RSS feed</b>. Exact steps are in Income &gt; Pinterest pins &gt; <b>Set up Pinterest</b>. After that, pins post by themselves.', go: 'pins', btn: 'Open Pinterest steps' },
      { k: 'posttime', t: 'Pick your daily posting time', d: 'Settings > Growth > <b>My posting time</b>: pick a time (6:00 PM is a good start), then tap <b>Save posting time</b>. The Queue then tells you to schedule every video for that time.', go: 'growth', btn: 'Open Growth', auto: !!store.get('postTime', '') },
      { k: 'verify', t: 'Verify your channel with your phone (free, 2 minutes)', d: 'In Chrome open <b>youtube.com/verify</b>, pick <b>India</b>, choose <b>Text me the verification code</b>, type your number, then enter the code. This unlocks custom thumbnails and <b>Test &amp; compare</b> (testing 3 thumbnails and titles).' },
    ],
    later: [
      { k: 'meta', t: 'Connect Instagram and Facebook so Shorts post there by themselves (optional, about 30 minutes)',
        d: 'Free, but has several steps. Until then, each posted Short in the Queue has <b>Download video</b> and <b>Copy Reels caption</b> for posting by hand.<ol class="psteps">'
          + '<li>Instagram app: Profile &gt; <b>☰</b> &gt; <b>Account type and tools</b> &gt; <b>Switch to professional account</b> &gt; <b>Creator</b>.</li>'
          + '<li>Facebook app: <b>Menu</b> &gt; <b>Pages</b> &gt; <b>Create</b> a Page called Ember &amp; Ink. In the Page\'s settings tap <b>Linked accounts</b> &gt; <b>Instagram</b> &gt; <b>Connect</b>.</li>'
          + '<li>In Chrome (tap <b>⋮</b> &gt; tick <b>Desktop site</b>) open <b>developers.facebook.com</b> &gt; <b>Get started</b>, then <b>My Apps</b> &gt; <b>Create app</b> named Story Studio (no card needed; it stays in development mode, which is enough for your own accounts).</li>'
          + '<li>Then ask Claude in the project chat: "walk me through the Meta token". You will add three GitHub secrets: <b>META_PAGE_TOKEN</b>, <b>FB_PAGE_ID</b> and <b>IG_USER_ID</b>.</li></ol>',
        auto: (typeof queueJobs !== 'undefined' && queueJobs || []).some((j) => j.social && /^ok/.test(String(j.social.instagram || j.social.facebook || ''))) },
      { k: 'audit', t: 'When Google\'s audit email arrives', d: 'Tap <b>Google approved it</b> on the Health card, then Settings > tap <b>Automatic upload</b> so it says ON. Until then, post each video yourself from the Queue.', go: 'health', btn: 'Go to Health card', auto: store.get('auditOk', false) && store.get('ytAuto', false) },
      { k: 'adsense', t: pub >= 20 ? 'Apply for AdSense now: your blog has 20 articles' : `Apply for AdSense at 20 blog articles (${pub} of 20 published)`,
        d: 'On blogger.com tap the menu (three lines) > <b>Earnings</b> > <b>Sign up for AdSense</b>, pick your Google account, and follow the steps (country India, your name and address as on your ID). Free, never asks for a card. Google checks the blog, which can take 2 to 4 weeks. When the email says approved, tick this.',
        ready: pub >= 20, remind: 'Your blog has 20 articles. Time to apply for AdSense (free).' },
      amzJoined && amzLeft !== null && d.amazonTag
        ? { k: 'amazon3', t: `Amazon: 3 sales needed by ${fmtDay(new Date(new Date(amzJoined + 'T12:00').getTime() + 180 * 864e5))} (${Math.max(0, amzLeft)} days left)`,
          d: 'Check Amazon Associates > <b>Reports</b>. If you are short of 3 sales, add your best book links in Income > Affiliate links so they appear in video descriptions too. If the account closes, you can simply join again later.',
          ready: amzLeft <= 30, remind: `Only ${Math.max(0, amzLeft)} days left to get 3 Amazon sales. Check your Amazon report.` }
        : { k: 'amazon', t: amzReady ? 'Join Amazon Associates now: people are seeing your links' : 'Join Amazon Associates (the app tells you when)',
          d: `Wait until the blog has 10 articles, or 100 subscribers, or 5,000 views${amzReady ? '. You are there now.' : ` (now ${pub} articles, ${fmtN(subs)} subscribers, ${fmtN(views)} views)`}, because you need 3 sales within 180 days of joining. Then on Chrome open <b>affiliate-program.amazon.com</b> > <b>Sign up</b>, add your blog and channel addresses as your websites, and copy your tracking ID (it ends in -20). Paste it in Income > Blog > <b>Save blog settings</b>, and add today's date on the Health card under Amazon Associates.`,
          go: 'blog', btn: 'Open Blog', ready: amzReady, auto: !!d.amazonTag && !!amzJoined, remind: 'Your blog and channel now get enough visitors. Time to join Amazon Associates (free).' },
      { k: 'ypp', t: subs >= 1000 && (hours >= 4000 || sv >= 10e6) ? 'Apply for the YouTube Partner Program now' : `YouTube Partner Program (${fmtN(subs)} of 1,000 subscribers, ${fmtN(hours)} of 4,000 watch hours)`,
        d: 'Needs 1,000 subscribers and 4,000 watch hours in a year (or 10 million Shorts views in 90 days). Then in the YouTube Studio app: <b>Earn</b> > <b>Apply now</b>, accept the terms, and link AdSense (the same AdSense account as your blog).',
        go: 'stats', btn: 'Open Dashboard', ready: subs >= 1000 && (hours >= 4000 || sv >= 10e6), remind: 'You qualify for the YouTube Partner Program. Apply in YouTube Studio > Earn.' },
      { k: 'yppearly', t: 'YouTube fan funding (early access)', d: 'At 500 subscribers and 3,000 watch hours (or 3 million Shorts views), YouTube Studio > <b>Earn</b> lets you turn on Super Thanks and memberships.', ready: subs >= 500 && (hours >= 3000 || sv >= 3e6), remind: 'You qualify for YouTube fan funding (Super Thanks). Have a look in YouTube Studio > Earn.' },
    ],
    always: [
      'Make every posted video <b>Public</b>. The blog only posts an article once its video is Public.',
      'Renew the GitHub key before it expires. The Health card turns orange 10 days before.',
      'If the Health card says the YouTube sign-in stopped, or the Blog box is not connected: Settings > Connect YouTube > <b>Sign in with Google</b>, tick every box, then update <b>YT_REFRESH_TOKEN</b> on GitHub.',
      'Answer Google\'s emails about your YouTube API project (for example the yearly check) before their deadline. Forward them to Claude if unsure.',
      'Never add a card anywhere. If a site asks for one, stop and tell Claude.',
      'Reddit and Quora: the app only drafts posts, you post them by hand. Read each community\'s rules, share where it really helps, and never post the same link in many places at once.',
      'Paste the video link when you tap <b>I posted it</b>. The app then adds subtitles, translated titles, the playlist and the thumbnail by itself.',
      'Keep the Pinterest tag in your Blogger theme. If you change the blog theme, paste the tag again or the pins stop.',
      'When a video has a paid sponsor, tick <b>Includes paid promotion</b> for it in YouTube Studio.',
    ],
  };
}
function todoRow(i, ticked) {
  const done = i.auto || !!ticked[i.k];
  const tick = i.auto !== undefined && i.auto ? `<span class="rtick" aria-label="Done">✓</span>` : `<button type="button" class="rtick tdtick" data-tk="${i.k}" aria-label="${done ? 'Mark not done' : 'Mark done'}">${done ? '✓' : ''}</button>`;
  return `<div class="rtask${done ? ' done' : ''}${i.ready && !done ? ' tdready' : ''}">${tick}<div class="rbody"><b>${i.t}</b>${i.auto ? ' <span class="rmin">done automatically</span>' : i.ready && !done ? ' <span class="rmin tdnow">do it now</span>' : ''}
    ${done ? '' : `<div class="meta">${i.d}</div>${i.go ? `<button type="button" class="rgo" data-go="${i.go}">${i.btn || 'Open'}</button>` : ''}`}</div></div>`;
}
async function paintTodos() {
  const el = $('todoCard'); if (!el) return;
  if (mode() !== 'github') { el.innerHTML = ''; return; }
  const d = await todoData(), L = todoList(d), ticked = store.get('todosDone', {});
  const isDone = (i) => i.auto || !!ticked[i.k];
  const nowOpen = L.now.filter((i) => !isDone(i)), laterOpen = L.later.filter((i) => !isDone(i));
  const finished = [...L.now, ...L.later].filter(isDone);
  const urgent = nowOpen.length + laterOpen.filter((i) => i.ready).length;
  const due = laterOpen.filter((i) => i.ready && i.remind);
  const bn = $('remindBanner');
  if (bn) bn.innerHTML = due.map((i) => `<div class="remind"><span class="rbell">🔔</span><div><b>Reminder</b><div>${esc(i.remind)}</div></div><button type="button" class="rgo rshow">Show me how</button></div>`).join('');
  const seen = store.get('remindSeen', []), fresh = due.filter((i) => !seen.includes(i.k));
  if (fresh.length) { store.set('remindSeen', [...seen, ...fresh.map((i) => i.k)]); toast('🔔 ' + fresh[0].remind); }
  el.innerHTML = `<div class="card routine todos"><div class="row"><h2>My to-dos</h2><span class="hsum ${urgent ? 'warn' : 'ok'}">${urgent ? `${urgent} to do now` : 'Nothing urgent'}</span></div>
    ${nowOpen.length ? `<h3 class="tdhead">Do now</h3>${nowOpen.map((i) => todoRow(i, ticked)).join('')}` : ''}
    ${laterOpen.length ? `<h3 class="tdhead">Later, when it happens</h3>${laterOpen.map((i) => todoRow(i, ticked)).join('')}` : ''}
    <details class="rweek"><summary>Always keep in mind (${L.always.length})</summary><ul class="tdalways">${L.always.map((x) => `<li>${x}</li>`).join('')}</ul></details>
    ${finished.length ? `<details class="rweek"><summary>Done (${finished.length})</summary>${finished.map((i) => todoRow(i, ticked)).join('')}</details>` : ''}</div>`;
}
$('homeView').addEventListener('click', (e) => {
  if (e.target.closest('.rshow')) { $('todoCard').scrollIntoView({ behavior: 'smooth' }); return; }
  const t = e.target.closest('.tdtick'); if (!t) return;
  const ticked = store.get('todosDone', {});
  if (ticked[t.dataset.tk]) delete ticked[t.dataset.tk]; else ticked[t.dataset.tk] = new Date().toISOString();
  store.set('todosDone', ticked); paintTodos();
  if (ticked[t.dataset.tk]) toast('Ticked off. Nice!');
});
