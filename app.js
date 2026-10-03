/* ---------------------------------------------------------------
   presentation timer
   --------------------------------------------------------------- */
(function () {
  'use strict';

  var root = document.documentElement;
  var screenEl = document.getElementById('screen');
  var displayEl = document.getElementById('display');
  var listEl = document.getElementById('list');
  var themeBtn = document.getElementById('theme');
  var fullBtn = document.getElementById('full');
  var warnEl = document.getElementById('warn');
  var bellBtn = document.getElementById('bell');

  var W = {
    m0: document.getElementById('m0'),
    m1: document.getElementById('m1'),
    s0: document.getElementById('s0'),
    s1: document.getElementById('s1'),
    x0: document.getElementById('x0'),
    x1: document.getElementById('x1')
  };

  var CELLS = 11;                 /* 0..9 plus one repeat for the wrap */
  var MAX_PRESETS = 5;             /* the last few countdowns that ran */
  var MAX_MINUTES = 99;              /* the most minutes two digits hold */
  var MIN_ROLL = 1;               /* seconds each way for a minute digit */
  var SEC_ROLL = 0.25;            /* the same, but for a one second digit */
  var FLASH_MS = 500;            /* one complete light/dark transition */
  var AWAKE_MS = 1000;            /* pointer still: before the controls go */
  var KEY = 'presentation-timer';

  var S = {
    theme: 'dark',
    set: 900,                    /* the countdown that was set last     */
    warn: 5,                     /* minutes of warning lead time       */
    presets: [],                 /* times of countdowns already begun  */
    left: 900,                   /* seconds still to run               */
    end: 0,                      /* moment the countdown hits zero     */
    running: false,
    done: false,
    mode: 'minutes',
    hitWarn: false,
    hitMin: false,
    hitEnd: false,
    muted: false,                  /* the bell is struck or passed over */
    phaseRed: false,
    phaseYellow: false,
    m: 15,                       /* minutes, fractional while dragging */
    drag: null,
    snap: null,
    xDrag: null
  };

  /* --- helpers --------------------------------------------------- */
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOut(t) { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, 3); }

  /* Strip position of the wheel that shows R, for a wheel of period P
     seconds.  The strip travels one cell per value, so a higher value
     sits half a cell higher and comes in from above.  A value change
     starts half a cell before it happens and is snapped into place half
     a cell later, so the digit sits still in between.  T is the length
     of one of those two halves; T = 0 leaves the wheel at rest. */
  function wheel(R, P, T) {
    var n = Math.floor(R / P);
    if (!T) return n;
    var toChange = (R / P - n) * P;           /* seconds until the digit turns */
    if (toChange <= T) return n - 0.5 * (1 - toChange / T);
    if (toChange >= P - T) return n + 0.5 * (1 - (P - toChange) / T);
    return n;
  }

  /* Wheel positions for a - possibly fractional - amount of minutes.
     The left wheel carries while the right one travels from 9 to 0.
     99 to 00 is one continuous turn, so nothing is clamped here. */
  /* Resting, the two wheels stand square on the digits, the tens carrying
     while the ones rolls past nine.  Under a finger they are geared: the
     tens turn a tenth as fast as the ones, so the left wheel tracks the
     drag all the way and not only when a ten is crossed. */
  function minutePos(m) {
    m = cycle(m);
    var t = Math.floor(m / 10);
    var u = m - t * 10;
    return { l: t + Math.max(0, u - 9), r: u };
  }
  function gearedPos(m) {
    m = cycle(m);
    return { l: m / 10, r: m % 10 };
  }

  /* the same digit, but on the turn of the strip closest to from */
  function nearest(target, from) {
    return target + Math.round((from - target) / 10) * 10;
  }

  /* keep a value on the 0..MAX_MINUTES cycle; 100 reads as 0 */
  function cycle(v) {
    var span = MAX_MINUTES + 1;
    return ((v % span) + span) % span;
  }

  /* Positions are strip values, so the strip - which counts downwards -
     puts the larger value half a cell higher.  Values near 100 are kept
     as they are and folded by the modulo in setPos, which lets 99 roll
     into 00 without a seam. */
  function setPos(el, v) {
    var i = 9 - v;
    el.firstElementChild.style.setProperty('--pos', i - Math.floor(i / 10) * 10);
  }

  function cellHeight(el) {
    return el.firstElementChild.firstElementChild.getBoundingClientRect().height || 1;
  }

  function buildStrip(el) {
    var html = '';
    for (var j = 0; j < CELLS; j++) {
      html += '<div class="cell" data-d="' + (((9 - j) % 10) + 10) % 10 + '">' + (((9 - j) % 10) + 10) % 10 + '</div>';
    }
    el.firstElementChild.innerHTML = html;
  }

  function fmt(sec) {
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* --- persistence ----------------------------------------------- */
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        theme: S.theme, set: S.set, warn: S.warn, presets: S.presets,
        muted: S.muted
      }));
    } catch (err) {}
  }

  function load() {
    var d = null;
    try { d = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (err) {}
    if (!d || typeof d !== 'object') return;
    if (d.theme === 'light' || d.theme === 'dark') S.theme = d.theme;
    if (typeof d.muted === 'boolean') S.muted = d.muted;
    if (typeof d.set === 'number' && isFinite(d.set) && d.set >= 0) {
      S.set = Math.round(d.set / 60) * 60;
    }
    if (typeof d.warn === 'number' && isFinite(d.warn) && d.warn >= 0) {
      S.warn = clamp(Math.round(d.warn), 0, MAX_MINUTES);
    }
    if (Object.prototype.toString.call(d.presets) === '[object Array]' && d.presets.length) {
      var out = [];
      for (var i = 0; i < d.presets.length && out.length < MAX_PRESETS; i++) {
        var v = d.presets[i];
        if (typeof v === 'number' && isFinite(v) && v >= 0 && out.indexOf(v) < 0) {
          out.push(v);
        }
      }
      S.presets = out;
    }
  }

  /* --- the list of times ----------------------------------------- */
  /* The list is kept in the order the countdowns were begun, newest
     first, and shown the long way down. */
  function renderList() {
    var shown = S.presets.slice().sort(function (a, b) { return b - a; });
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    for (var i = 0; i < shown.length; i++) {
      var li = document.createElement('li');
      li.setAttribute('data-v', shown[i]);
      li.textContent = fmt(shown[i]);
      listEl.appendChild(li);
    }
    fitList();
  }

  /* A long column is scaled down so that all of it stays on the screen */
  function fitList() {
    listEl.style.fontSize = '';
    if (!listEl.childElementCount) return;
    var full = parseFloat(getComputedStyle(listEl).fontSize) || 30;
    var avail = window.innerHeight - parseFloat(getComputedStyle(listEl).top) - 6;
    var high = listEl.scrollHeight;
    if (high > avail) listEl.style.fontSize = (full * avail / high) + 'px';
  }

  window.addEventListener('resize', fitList);

  /* A countdown that has begun: the newest goes on top and the one that
     has been waiting longest comes off the bottom. */
  function addPreset(v) {
    var i = S.presets.indexOf(v);
    if (i >= 0) S.presets.splice(i, 1);
    S.presets.unshift(v);
    while (S.presets.length > MAX_PRESETS) S.presets.pop();
    save();
    renderList();
  }

  function removePreset(v) {
    var i = S.presets.indexOf(v);
    if (i < 0) return;
    S.presets.splice(i, 1);
    save();
    renderList();
  }

  function pick(v) {
    S.set = v;
    save();
    reset(false);
  }

  /* --- look ------------------------------------------------------ */
  function applyLook() {
    var c = [S.theme];
    if (S.phaseRed) c.push('red');
    if (S.phaseYellow) c.push('yellow');
    if (root.classList.contains('flash')) c.push('flash');
    if (root.classList.contains('awake')) c.push('awake');
    root.className = c.join(' ');
  }

  function setMode(m) {
    S.mode = m;
    displayEl.classList.toggle('mode-minutes', m === 'minutes');
    displayEl.classList.toggle('mode-seconds', m === 'seconds');
  }

  function setPaused(p) {
    displayEl.classList.toggle('paused', p);
  }

  /* --- the bell ----------------------------------------------------
     No sound file is loaded: a bell is a handful of partials that do
     not sit at whole multiples of one another, and each of them dies
     away at its own rate, the high ones first.  That is what lets the
     strike fade and still go on ringing.  Grown from the ratios of a
     real bell, but the partials are near enough, so what comes out is
     more a chime than a church tower.                               */
  var BELL_HZ = 523.25;            /* the strike, five hundred and a bit */
  var BELL_AT = 0.004;             /* seconds from silence to full voice  */
  var BELL_GAP = FLASH_MS / 1000;  /* one strike for each light/dark turn  */
  var BELL_LOUD = 0.5;             /* as much as the sum of them, halved  */
  var BELL = [
    /*  ratio   loudness   tail in seconds                        */
    /*  0.50      0.62       3.20     the hum, heard under all    */
    /*  1.00      1.00       2.40     the prime, the note itself   */
    /*  1.19      0.55       1.70     the tierce                   */
    /*  1.56      0.42       1.30     the quint                    */
    /*  2.00      0.66       1.00     the nominal                  */
    /*  2.51      0.30       0.62                                   */
    /*  3.01      0.22       0.42                                   */
    /*  4.17      0.14       0.26                                   */
    /*  5.43      0.09       0.16     the upper ringing, gone soon */
    [0.5, 0.62, 3.2], [1, 1, 2.4], [1.19, 0.55, 1.7], [1.56, 0.42, 1.3],
    [2, 0.66, 1], [2.51, 0.3, 0.62], [3.01, 0.22, 0.42], [4.17, 0.14, 0.26],
    [5.43, 0.09, 0.16]
  ];

  var BELL_SUM = 0;
  for (var b = 0; b < BELL.length; b++) BELL_SUM += BELL[b][1];

  var audio = null;                /* made once, and then kept */

  /* One bell, one set of partials: each is a sine that is given its
     own little slice of the total loudness and put out of its misery
     over the length of its own tail. */
  function strike(at, loud) {
    var t = audio.currentTime + at;
    for (var i = 0; i < BELL.length; i++) {
      var p = BELL[i];
      var o = audio.createOscillator();
      var g = audio.createGain();
      var peak = BELL_LOUD * loud * p[1] / BELL_SUM;
      o.type = 'sine';
      o.frequency.value = BELL_HZ * p[0];
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + BELL_AT);
      g.gain.exponentialRampToValueAtTime(0.0001, t + p[2]);
      o.connect(g);
      g.connect(audio.destination);
      o.start(t);
      o.stop(t + p[2] + 0.02);
    }
  }

  /* As many strikes as there are flashes, on the beat of them, each a
     little quieter than the one before it so that the second and the
     third do not pile on top of the first. */
  function ding(times) {
    if (S.muted) return;
    for (var i = 0; i < times; i++) strike(i * BELL_GAP, 1 - 0.18 * i);
  }

  /* Browsers will not let a sound out until the page has been touched,
     and a context made after that touch stays shut, so it is opened by
     the first press and left open afterwards. */
  function ringOn() {
    if (!audio) {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) return;
      try { audio = new C(); } catch (err) { return; }
    }
    if (audio.state === 'suspended' && audio.resume) audio.resume();
  }

  ['pointerdown', 'keydown'].forEach(function (t) {
    window.addEventListener(t, function once() {
      window.removeEventListener(t, once);
      ringOn();
    });
  });

  /* --- the bell, as a switch ----------------------------------------
     The glyph is the warning lead time as well, and it keeps it: the
     bell rings alongside the wheels unless it is put to sleep.  It is
     struck through when it is, so the state is read off the symbol and
     not off any words.                                                */
  function showBell() {
    bellBtn.setAttribute('aria-pressed', S.muted ? 'true' : 'false');
    bellBtn.setAttribute('aria-label', S.muted ? 'bell is muted' : 'bell rings');
    bellBtn.setAttribute('title', S.muted ? 'bell is muted' : 'mute the bell');
  }

  bellBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    S.muted = !S.muted;
    showBell();
    save();
  });

  /* --- flashing --------------------------------------------------- */
  var flashTimer = null;
  var phaseTimer = null;
  var phaseNext = null;

  /* Stop the flashing.  `flush' also carries out the phase change that was
     still queued, so a clock stopped halfway through a warning does not
     silently lose it. */
  function cancelFlash(flush) {
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
    if (phaseTimer) { clearTimeout(phaseTimer); phaseTimer = null; }
    var then = phaseNext;
    phaseNext = null;
    root.classList.remove('flash');
    if (flush && then) then();
  }

  /* `times' flashes of half a second, then `then' changes the state */
  function flash(times, then) {
    root.style.setProperty('--flash-n', times);
    root.classList.remove('flash');
    void root.offsetWidth;                   /* let the animation restart */
    root.classList.add('flash');
    ding(times);
    flashTimer = setTimeout(function () {
      root.classList.remove('flash');
      flashTimer = null;
    }, times * FLASH_MS);
    if (then) {
      phaseNext = then;
      phaseTimer = setTimeout(function () { phaseTimer = null; phaseNext = null; then(); }, times * FLASH_MS);
    }
  }

  /* --- start, stop, reset ----------------------------------------- */
  function reset(start) {
    cancelFlash();
    S.left = S.set;
    S.end = performance.now() + S.set * 1000;
    S.running = !!start;
    S.done = false;
    S.hitWarn = S.hitMin = S.hitEnd = false;
    S.phaseRed = S.phaseYellow = false;
    S.drag = null;
    S.snap = null;
    S.frozen = null;
    S.m = S.set / 60;
    displayEl.classList.remove('pulse');
    applyLook();
    setMode('minutes');
    setPaused(!start);
    if (start) addPreset(S.set);          /* this countdown is under way */
  }

  /* A time that was set and never run has no warning due: the phases and
     the flags of the last countdown go with it.  The time itself is
     remembered, as it is after any other way of setting one. */
  function forgetWarnings() {
    S.done = false;
    S.hitWarn = S.hitMin = S.hitEnd = false;
    S.phaseRed = S.phaseYellow = false;
    displayEl.classList.remove('pulse');
    applyLook();
    save();
  }

  /* Freeze the clock where it stands.  A warning that was already due
     still takes effect, it just happens without the blinking. */
  function pause() {
    if (!S.running) return;
    /* Where the digits are standing is where they stay: a hand on a
       running clock stops it under the fingers, mid roll if need be,
       instead of straightening the digits up in front of you. */
    S.frozen = S.running ? still() : null;
    S.running = false;
    setPaused(true);
    cancelFlash(true);
    S.m = S.left / 60;
    S.snap = null;
  }

  /* the two wheels as they are drawn this frame, be it mid roll or not */
  function still() {
    if (S.mode === 'minutes') {
      var t = S.running ? MIN_ROLL : 0;
      return { mode: 'minutes', l: wheel(S.left, 600, t), r: wheel(S.left, 60, t) };
    }
    var s = S.running ? SEC_ROLL : 0;
    return { mode: 'seconds', l: wheel(S.left, 10, s), r: wheel(S.left, 1, s) };
  }

  /* Run on from the value that is left */
  function resume() {
    if (S.running) return;
    if (S.done || S.left <= 0) { reset(true); return; }
    S.frozen = null;
    S.end = performance.now() + S.left * 1000;
    S.running = true;
    setPaused(false);
    addPreset(S.set);                      /* ... and it is running again */
  }

  function toggle() {
    if (S.running) pause(); else resume();
  }

  function onWarn() {
    flash(1, function () { S.phaseRed = true; applyLook(); });
  }

  function onMinute() {
    flash(2, function () {
      S.phaseRed = true;
      S.phaseYellow = true;
      applyLook();
      setMode('seconds');
    });
  }

  function onEnd() {
    S.running = false;
    setPaused(true);
    S.snap = {                         /* settle the half finished roll */
      sec: true,
      fl: wheel(0.25, 10, SEC_ROLL), fr: wheel(0.25, 1, SEC_ROLL),
      tl: 0, tr: 0,
      t0: performance.now(), dur: 0.5
    };
    flash(3, function () {
      S.done = true;
      displayEl.classList.add('pulse');
    });
  }

  /* --- drawing ----------------------------------------------------- */
  function draw(now) {
    if (S.mode === 'minutes') {
      var p;
      if (S.drag) {
        p = gearedPos(S.m);
      } else if (S.snap && S.snap.min) {
        var e = easeOut((now - S.snap.t0) / (S.snap.dur * 1000));
        p = { l: lerp(S.snap.fl, S.snap.tl, e), r: lerp(S.snap.fr, S.snap.tr, e) };
      } else if (!S.running && S.frozen && S.frozen.mode === 'minutes') {
        p = { l: S.frozen.l, r: S.frozen.r };
      } else {
        var t = S.running ? MIN_ROLL : 0;
        p = { l: wheel(S.left, 600, t), r: wheel(S.left, 60, t) };
      }
      setPos(W.m0, p.l);
      setPos(W.m1, p.r);
      /* Nine minutes is 9, not 09, and it is said so from the first
         frame: the tens wheel steps out of the way the moment the
         number gets under ten, roll and all.                        */
      var said = (S.drag || (S.snap && S.snap.min)) ? S.m : S.left / 60;
      W.m0.classList.toggle('z', said < 10);
    } else {
      var l, r;
      if (S.snap && S.snap.sec) {
        var e2 = easeOut((now - S.snap.t0) / (S.snap.dur * 1000));
        l = lerp(S.snap.fl, S.snap.tl, e2);
        r = lerp(S.snap.fr, S.snap.tr, e2);
      } else if (!S.running && S.frozen && S.frozen.mode === 'seconds') {
        l = S.frozen.l;
        r = S.frozen.r;
      } else {
        var t2 = S.running ? SEC_ROLL : 0;
        l = wheel(S.left, 10, t2);
        r = wheel(S.left, 1, t2);
      }
      setPos(W.s0, l);
      setPos(W.s1, r);
    }
  }

  function frame(now) {
    if (S.running) S.left = (S.end - now) / 1000;
    if (S.running && !S.done) {
      if (!S.hitEnd && S.left <= 0) {
        S.hitEnd = true;
        S.left = 0;
        onEnd();
      } else if (!S.hitMin && S.left <= 60) {
        S.hitMin = true;
        onMinute();
      } else if (!S.hitWarn && S.warn > 0 && S.left <= S.warn * 60) {
        S.hitWarn = true;
        onWarn();
      }
    }
    if (S.snap && now - S.snap.t0 >= S.snap.dur * 1000) S.snap = null;
    draw(now);
    drawWarn(now);
    requestAnimationFrame(frame);
  }

  /* --- dragging the digits ------------------------------------------ */
  var tap = false;              /* a press that has not become a drag */
  var tapDigit = false;         /* ... and it landed on a digit        */
  var stoppedByDown = false;    /* ... and it stopped a running clock  */

  /* the wheel under this press, if any */
  function wheelAt(e) {
    var els = S.mode === 'minutes' ? [W.m0, W.m1] : [W.s0, W.s1];
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right) return els[i];
    }
    return null;
  }

  screenEl.addEventListener('pointerdown', function (e) {
    tap = true;
    tapDigit = false;
    stoppedByDown = false;
    var el = wheelAt(e);
    if (!el) return;
    tapDigit = true;
    /* a press on a digit stops a clock that is running */
    if (S.running) { pause(); stoppedByDown = true; }
    if (S.mode !== 'minutes' || S.done) return;
    var which = el === W.m0 ? 'left' : 'right';
    e.preventDefault();
    displayEl.setPointerCapture(e.pointerId);
    S.drag = {
      which: which, x: e.clientX, y: e.clientY,
      m: S.m, set: S.set, cell: cellHeight(W.m1), moved: 0
    };
    S.snap = null;
  });

  window.addEventListener('pointermove', function (e) {
    var d = S.drag;
    if (!d) return;
    e.preventDefault();
    var dy = e.clientY - d.y;
    d.moved = Math.max(d.moved, Math.abs(dy), Math.abs(e.clientX - d.x));
    S.m = cycle(d.m + (dy / d.cell) * (d.which === 'left' ? 10 : 1));
    S.set = cycle(Math.round(S.m)) * 60;
    S.left = S.set;
  });

  function endDigitDrag() {
    var d = S.drag;
    if (!d) return;
    S.drag = null;
    if (d.moved <= 3) return;                   /* that was a tap */
    tap = false;                                /* a drag is not a tap */
    stoppedByDown = false;
    var m = cycle(Math.round(S.m));
    var from = gearedPos(S.m);
    var to = minutePos(m);
    S.snap = {
      min: true,
      fl: from.l, fr: from.r,
      tl: nearest(to.l, from.l), tr: nearest(to.r, from.r),
      t0: performance.now(), dur: snapDur(from, to)
    };
    S.m = m;
    S.set = m * 60;
    S.left = S.set;
    S.frozen = null;
    forgetWarnings();                       /* setting is not starting   */
  }

  function snapDur(from, to) {
    var d = Math.max(
      Math.abs(nearest(to.l, from.l) - from.l),
      Math.abs(nearest(to.r, from.r) - from.r)
    );
    return clamp(d * 0.8, 0.12, 1);
  }

  window.addEventListener('pointerup', endDigitDrag);
  window.addEventListener('pointercancel', endDigitDrag);

  /* a tap on a digit starts or stops the clock; a tap anywhere else
     starts it again from the value that was set last */
  window.addEventListener('pointerup', function () {
    if (!tap) return;
    tap = false;
    var onDigit = tapDigit;
    tapDigit = false;
    if (!onDigit) { reset(true); return; }
    if (stoppedByDown) { stoppedByDown = false; return; }   /* that press stopped it */
    toggle();
  });

  /* --- list of times: tap, drag in, drag out ------------------------ */
  var listDrag = null;

  listEl.addEventListener('pointerdown', function (e) {
    var li = e.target && e.target.closest ? e.target.closest('li') : null;
    if (!li) return;
    e.preventDefault();
    listDrag = { v: parseInt(li.getAttribute('data-v'), 10), rect: listEl.getBoundingClientRect() };
  });

  window.addEventListener('pointermove', function (e) {
    if (!listDrag) return;
    var r = listDrag.rect;
    if (e.clientX >= r.left && e.clientX <= r.right &&
        e.clientY >= r.top && e.clientY <= r.bottom) return;
    var inward = e.clientX < r.left || e.clientY > r.bottom;
    var v = listDrag.v;
    listDrag = null;
    if (inward) pick(v);
    else removePreset(v);
  });

  window.addEventListener('pointerup', function () {
    if (!listDrag) return;
    var v = listDrag.v;
    listDrag = null;
    pick(v);
  });

  /* --- warning lead time ------------------------------------------
     The same two wheels as the minutes, and dragged the same way: the
     digits follow the finger, so the tens are worth ten a cell.        */
  var xPos = S.warn;
  var xSnap = null;

  function drawWarn(now) {
    var p;
    if (S.xDrag) {
      p = gearedPos(xPos);
    } else if (xSnap) {
      if (now - xSnap.t0 >= xSnap.dur * 1000) { xSnap = null; p = minutePos(xPos); }
      else {
        var e = easeOut((now - xSnap.t0) / (xSnap.dur * 1000));
        p = { l: lerp(xSnap.fl, xSnap.tl, e), r: lerp(xSnap.fr, xSnap.tr, e) };
      }
    } else {
      p = minutePos(xPos);
    }
    setPos(W.x0, p.l);
    setPos(W.x1, p.r);
  }

  warnEl.addEventListener('pointerdown', function (e) {
    var el = warnWheelAt(e);
    if (!el) return;
    e.preventDefault();
    warnEl.classList.add('dragging');
    warnEl.setPointerCapture(e.pointerId);
    xSnap = null;
    S.xDrag = { which: el === W.x0 ? 'tens' : 'ones', y: e.clientY, v: xPos, cell: cellHeight(W.x1), moved: 0 };
  });

  /* the warning wheel under this press, if any */
  function warnWheelAt(e) {
    var els = [W.x0, W.x1];
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right) return els[i];
    }
    return null;
  }

  window.addEventListener('pointermove', function (e) {
    if (!S.xDrag) return;
    e.preventDefault();
    var dy = e.clientY - S.xDrag.y;
    S.xDrag.moved = Math.max(S.xDrag.moved, Math.abs(dy));
    xPos = cycle(S.xDrag.v + (dy / S.xDrag.cell) * (S.xDrag.which === 'tens' ? 10 : 1));
    drawWarn(e.timeStamp);
  });

  function endWarnDrag() {
    if (!S.xDrag) return;
    var moved = S.xDrag.moved;
    S.xDrag = null;
    warnEl.classList.remove('dragging');
    if (moved > 3) {
      var m = cycle(Math.round(xPos));
      var from = gearedPos(xPos);
      var to = minutePos(m);
      xSnap = {
        fl: from.l, fr: from.r,
        tl: nearest(to.l, from.l), tr: nearest(to.r, from.r),
        t0: performance.now(), dur: snapDur(from, to)
      };
      S.warn = m;
    }
    xPos = S.warn;
    save();
  }

  window.addEventListener('pointerup', endWarnDrag);
  window.addEventListener('pointercancel', endWarnDrag);

  /* --- theme ---------------------------------------------------------- */
  themeBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    S.theme = S.theme === 'dark' ? 'light' : 'dark';
    applyLook();
    save();
  });

  /* --- full screen ----------------------------------------------------
     'f' toggles it, escape leaves it, and the corner symbol does the
     same.  The symbol is the same either way round, so the label and
     the title carry the state.                                      */
  var FS = '&#x26F6;';               /* four corners: grow            */
  var FS_IN = FS;
  var FS_OUT = FS;

  function fullElement() {
    return document.fullscreenElement || document.webkitFullscreenElement ||
           document.mozFullScreenElement || document.msFullscreenElement || null;
  }

  function fullOn() {
    var el = root;
    var go = el.requestFullscreen || el.webkitRequestFullscreen ||
             el.mozRequestFullScreen || el.msRequestFullscreen;
    if (!go) return;
    try {
      var p = go.call(el);
      if (p && p.catch) p.catch(function () {});
    } catch (err) {}
  }

  function fullOff() {
    var go = document.exitFullscreen || document.webkitExitFullscreen ||
             document.mozCancelFullScreen || document.msExitFullscreen;
    if (!go || !fullElement()) return;
    try {
      var p = go.call(document);
      if (p && p.catch) p.catch(function () {});
    } catch (err) {}
  }

  function toggleFull() {
    if (fullElement()) fullOff(); else fullOn();
  }

  function showFull(on) {
    fullBtn.innerHTML = on ? FS_OUT : FS_IN;
    fullBtn.setAttribute('aria-label', on ? 'leave full screen' : 'enter full screen');
    fullBtn.setAttribute('title', on ? 'leave full screen (esc)' : 'full screen (f)');
  }

  ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange',
   'MSFullscreenChange'].forEach(function (t) {
    document.addEventListener(t, function () { showFull(!!fullElement()); });
  });

  fullBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    toggleFull();
  });

  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    var k = e.key;
    if (k === 'f' || k === 'F') {
      e.preventDefault();
      toggleFull();
    } else if (k === 'Escape' || k === 'Esc') {
      if (fullElement()) { e.preventDefault(); fullOff(); }
    }
  });

  showFull(false);

  /* --- what is on show ----------------------------------------------
     The countdown is never hidden.  The controls round the edges go a
     second after the pointer stops, and come back the moment it moves
     again.  A drag that is still going keeps them, so that a control
     does not vanish from under the finger that is holding it.         */
  var awakeTimer = null;

  function wake() {
    root.classList.add('awake');
    if (awakeTimer) clearTimeout(awakeTimer);
    awakeTimer = setTimeout(function () {
      awakeTimer = null;
      if (S.drag || S.xDrag || listDrag) return wake();   /* still at it */
      root.classList.remove('awake');
    }, AWAKE_MS);
  }

  ['pointermove', 'pointerdown', 'wheel', 'touchstart', 'keydown'].forEach(function (t) {
    window.addEventListener(t, wake, true);
  });

  /* --- the time this run starts with ---------------------------------
     ?t=15 is fifteen minutes, ?t=15.5 or ?t=15:30 is fifteen thirty,
     and a minus sign in front is no more than a flourish.  It is read
     once, it is not remembered, and it is not a countdown that ever
     ran, so it does not go into the list.                             */
  function fromUrl() {
    var q = /[?&]t=([^&#]*)/.exec(window.location.search || '');
    if (!q) return null;
    var v = decodeURIComponent(q[1]).trim().replace(/^[-+]\s*/, '');
    var mins = /^\d+(?:\.\d+)?$/.exec(v);
    var parts = /^(\d+):([0-5]\d)$/.exec(v);
    var secs;
    if (mins) secs = parseFloat(mins[0]) * 60;
    else if (parts) secs = parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
    else return null;
    if (!isFinite(secs)) return null;
    return clamp(Math.round(secs), 0, MAX_MINUTES * 60 + 59);
  }

  /* --- go -------------------------------------------------------------- */
  load();
  buildStrip(W.m0); buildStrip(W.m1); buildStrip(W.s0); buildStrip(W.s1);
  buildStrip(W.x0); buildStrip(W.x1);
  xPos = S.warn;
  setPos(W.s0, 0);
  setPos(W.s1, 0);
  applyLook();
  setMode('minutes');
  setPaused(true);
  showBell();
  var wanted = fromUrl();
  if (wanted !== null) { S.presets = []; S.set = wanted; S.left = wanted; }
  renderList();
  S.m = S.set / 60;
  requestAnimationFrame(frame);
})();
