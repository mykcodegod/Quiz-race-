'use strict';

/**
 * Countdown bar. The server sends "remainingMs"; the clock counts down locally
 * from the moment the message arrives, and freezes while the game is paused.
 */
window.RaceClock = function (fillEl, numEl) {
  const track = fillEl.parentElement;
  let deadline = 0;
  let total = 1;
  let frozen = null;
  let warn = true;
  let raf = 0;

  function frame() {
    const ms = frozen !== null ? frozen : Math.max(0, deadline - performance.now());
    fillEl.style.width = Math.min(100, (ms / total) * 100) + '%';
    numEl.textContent = Math.ceil(ms / 1000);
    track.classList.toggle('low', warn && ms > 0 && ms <= 5000);
    track.classList.toggle('reveal', !warn);
    raf = requestAnimationFrame(frame);
  }

  return {
    set(remainingMs, totalMs, paused, isQuestion) {
      total = totalMs || 1;
      warn = isQuestion;
      if (paused) {
        frozen = remainingMs;
      } else {
        frozen = null;
        deadline = performance.now() + remainingMs;
      }
      if (!raf) frame();
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
};

function makeEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

/** Draws the scoreboard. Uses textContent only, so names can't inject HTML. */
window.renderBoard = function (ol, board, mePid) {
  ol.replaceChildren();
  for (const b of board) {
    const li = document.createElement('li');
    const mine = b.pid === mePid;
    if (mine) li.classList.add('you');
    if (!b.connected) li.classList.add('away');

    let mark = '';
    if (b.gain !== undefined && b.gain !== null) mark = b.gain > 0 ? '+' + b.gain : '';
    else if (b.answered) mark = '\u2713';

    li.append(
      makeEl('span', 'rank', b.rank),
      makeEl('span', 'name', b.name + (mine ? ' (you)' : '') + (b.connected ? '' : ' - offline')),
      makeEl('span', 'mark', mark),
      makeEl('span', 'score', b.score.toLocaleString())
    );
    ol.append(li);
  }
};

window.makeEl = makeEl;
