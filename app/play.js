// Story Studio: the livelier, interactive parts (Home, live preview, dice, board, swipe ideas,
// YouTube preview, money goals). Uses the helpers defined in app.js.
'use strict';

// ---------- small shared pieces ----------
const PICS_PER_DAY = 170;  // free Cloudflare picture allowance
function picsFor(j) {  // about one picture per scene (see make_scripts.py)
  if (j.parent_id) return 0;  // clips reuse the long video
  return j.format === 'long' ? Math.round((Number(j.length) || 40) * 150 / 37) + 3 : Math.max(3, Math.round((Number(j.length) || 45) * 2.5 / 12));
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
    <div class="card"><div class="row"><h2>This week</h2><span class="meta"><i class="dotL"></i> long <i class="dotS"></i> Short</span></div>
      <div class="week">${week}</div>
      <button type="button" class="ghostlink" data-go="week">Plan the rest of the week</button></div>
    <div class="card"><div class="row"><h2>Badges</h2><span class="meta">${earned} of ${badges.length}</span></div>
      <div class="badges">${badges.map(([n, ok, prog, ic]) => `<div class="badge${ok ? ' got' : ''}"><span class="bic">${ic}</span><b>${esc(n)}</b><span class="meta">${ok ? 'Earned' : esc(prog)}</span></div>`).join('')}</div></div>
    <div class="shortcuts">
      <button type="button" data-go="ideas">Browse ideas</button><button type="button" data-go="stats">Dashboard</button><button type="button" data-go="money">Income</button>
    </div>`;
}
$('homeView').addEventListener('click', (e) => {
  const b = e.target.closest('[data-go],[data-day]'); if (!b) return;
  const g = b.dataset.go;
  if (b.dataset.day) { store.set('qFilter', 'all'); showTab('queue'); return; }
  if (g === 'short' || g === 'long') { showTab('create'); $('modeSeg').querySelector('[data-v="one"]').click(); document.querySelector(`#formatSeg button[data-v="${g}"]`).click(); $('topic').focus(); }
  else if (g === 'dice') { showTab('create'); $('modeSeg').querySelector('[data-v="one"]').click(); rollDice(); }
  else if (g === 'week') { showTab('create'); $('modeSeg').querySelector('[data-v="week"]').click(); }
  else if (g === 'review') showTab('review');
  else if (['post', 'work', 'failed'].includes(g)) { store.set('qFilter', g === 'post' ? 'ready' : g); store.set('qView', 'list'); showTab('queue'); }
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
  const mine = picsFor({ format, length: $('length').value });
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
