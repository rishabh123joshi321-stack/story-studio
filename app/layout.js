// Workbench layout: side rail, section lists on Settings and Income, and fold-up task lists.
// Only changes how things are laid out; every card, button and name stays the same.
'use strict';

(function () {
  // ---------- Settings and Income: a list of sections on the left, one section open on the right ----------
  const PANES = { 'tab-settings': 'paneSettings', 'tab-money': 'paneMoney' };
  function cardTitle(c) { const h = c.querySelector('h2'); return h ? h.textContent.trim() : 'More'; }
  function buildPane(secId) {
    const sec = $(secId); if (!sec || sec.querySelector('.pane')) return;
    const cards = [...sec.children].filter((c) => c.classList.contains('card'));
    if (!cards.length) return;
    const pane = document.createElement('div'); pane.className = 'pane';
    const nav = document.createElement('nav'); nav.className = 'pnav'; nav.setAttribute('aria-label', 'Sections');
    const body = document.createElement('div'); body.className = 'pbody';
    cards[0].before(pane); pane.append(nav, body);
    cards.forEach((c) => body.append(c));
    paintNav(secId);
    nav.addEventListener('click', (e) => { const b = e.target.closest('button[data-i]'); if (!b) return; openCard(secId, Number(b.dataset.i)); window.scrollTo({ top: 0 }); });
    const saved = store.get(PANES[secId], 0);
    openCard(secId, saved);
  }
  function visibleCards(secId) { return [...$(secId).querySelectorAll('.pbody > .card')].filter((c) => !c.hidden); }
  function paintNav(secId) {
    const sec = $(secId), nav = sec.querySelector('.pnav'), cards = visibleCards(secId);
    const on = sec.querySelector('.pbody > .card.pon');
    nav.innerHTML = cards.map((c, i) => `<button type="button" data-i="${i}" class="${c === on ? 'on' : ''}"><span>${esc(cardTitle(c))}</span><i aria-hidden="true">›</i></button>`).join('');
  }
  function openCard(secId, i) {
    const cards = visibleCards(secId); if (!cards.length) return;
    const n = Math.max(0, Math.min(i, cards.length - 1));
    $(secId).querySelectorAll('.pbody > .card').forEach((c) => c.classList.toggle('pon', c === cards[n]));
    store.set(PANES[secId], n); paintNav(secId);
  }
  // Open the section that holds an element (used when the app jumps to a card or a box).
  function reveal(el) {
    if (!el || !el.closest) return;
    const card = el.closest('.pbody > .card'); if (!card || card.classList.contains('pon')) return;
    const sec = card.closest('.tab'); const i = visibleCards(sec.id).indexOf(card);
    if (i >= 0) openCard(sec.id, i);
  }
  window.revealSection = reveal;
  const sIV = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (...a) { reveal(this); return sIV.apply(this, a); };
  const fo = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (...a) { reveal(this); return fo.apply(this, a); };
  if (typeof runCheckup === 'function') {
    const rc = runCheckup;
    // eslint-disable-next-line no-global-assign
    runCheckup = function (...a) { reveal($('fixCard')); return rc.apply(this, a); };
  }
  Object.keys(PANES).forEach(buildPane);

  // ---------- Home: to-dos and routine fold up; tap a task to see its steps ----------
  $('homeView').addEventListener('click', (e) => {
    if (e.target.closest('button, a, input, summary, details ul')) return;
    const head = e.target.closest('.rbody > b, .rbody > .rmin, .rbody'); if (!head) return;
    const t = head.closest('.rtask'); if (!t || !t.querySelector('.rbody .meta')) return;
    if (t.classList.contains('open') && e.target.closest('.meta')) return;
    t.classList.toggle('open');
  });
})();
