/* ============================================================
   game.js — Vanishing Act. Six perspective puzzles per round,
   alternating two verbs:
     odd  (A) two receding edges are drawn — tap the hidden
              vanishing point where their extensions meet;
     even (B) the vanishing point is shown — press the bold
              start dot and drag the receding edge into it.
   Scoring is pure geometry (helpers at the top, canvas-free so
   they are unit-testable); the round reports the mean of six.
   Skeleton follows the template: init → round → input → score →
   ArtDaily.report, one theme-aware canvas, no libraries.
   ============================================================ */
(function () {
  'use strict';

  var SLUG = 'perspective';
  var PUZZLES_PER_ROUND = 6;
  var REVEAL_MS = 1400;   /* how long the accent reveal stays up */
  var GRAB_RADIUS = 28;   /* px around P that starts a type-B stroke */
  var MIN_STROKE = 24;    /* px of drag before an angle can be read */
  var MARGIN = 14;        /* constructions keep off the canvas edge */

  /* ===== pure scoring math (geometry in, 0–100 out) ===== */

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  /* Type A: tap error as a fraction of canvas width.
     err = dist(tap, VP) / W; score = 100 * clamp(1 - err/0.12, 0, 1).
     Within ~7% of the width scores 40; ~1% scores 90; dead-on is 100. */
  function scoreVpTap(tapX, tapY, vpX, vpY, canvasWidth) {
    if (!(canvasWidth > 0)) return 0; /* degenerate canvas: never NaN */
    var err = Math.hypot(tapX - vpX, tapY - vpY) / canvasWidth;
    return 100 * clamp01(1 - err / 0.12);
  }

  /* Fold an angular difference to [0, 90] degrees — a drawn edge has
     no inherent direction, so 178° off really means 2° off. */
  function foldDeg(d) {
    d = Math.abs(d) % 180;
    return d > 90 ? 180 - d : d;
  }

  /* Principal axis (degrees) of a point cloud, least-squares fit;
     null when the points do not span a line. */
  function fitDirectionDeg(points) {
    var n = points.length;
    if (n < 2) return null;
    var mx = 0, my = 0, i;
    for (i = 0; i < n; i++) { mx += points[i].x; my += points[i].y; }
    mx /= n; my /= n;
    var sxx = 0, syy = 0, sxy = 0, dx, dy;
    for (i = 0; i < n; i++) {
      dx = points[i].x - mx; dy = points[i].y - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    if (sxx + syy < 1e-6) return null;
    return 0.5 * Math.atan2(2 * sxy, sxx - syy) * 180 / Math.PI;
  }

  /* Type B: angle between the stroke's best-fit line and the true
     P→VP edge, folded to [0,90]; score = 100 * clamp(1 - angErr/14).
     Within 8.4° scores 40; 1.4° scores 90; exactly on line is 100. */
  function scoreEdgeStroke(points, pX, pY, vpX, vpY) {
    var drawn = fitDirectionDeg(points);
    if (drawn === null) return null;
    var trueDeg = Math.atan2(vpY - pY, vpX - pX) * 180 / Math.PI;
    return 100 * clamp01(1 - foldDeg(drawn - trueDeg) / 14);
  }

  /* ===== chrome ===== */

  var canvas = document.getElementById('gameCanvas');
  var ctx = canvas.getContext('2d');
  var hint = document.getElementById('hint');
  var toast = document.getElementById('toast');
  var hudRound = document.getElementById('hudRound');
  var hudScore = document.getElementById('hudScore');
  var hudBest = document.getElementById('hudBest');

  ArtDaily.init({ slug: SLUG });

  /* ---- theme-aware inks (re-read on every repaint) ---- */
  function inks() {
    var cs = getComputedStyle(document.documentElement);
    return {
      ink: cs.getPropertyValue('--ink').trim(),
      muted: cs.getPropertyValue('--muted').trim(),
      accent: cs.getPropertyValue('--game-accent').trim() || cs.getPropertyValue('--bubblegum').trim(),
    };
  }

  /* ---- crisp canvas at any devicePixelRatio; height tracks width ---- */
  var W = 0, H = 0;
  function fitCanvas() {
    var rect = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.round(W * 0.62);
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ===== round state ===== */
  /* phase: 'idle' | 'play' | 'reveal' */
  var round = 0, idx = 0, scores = [], puzzle = null, phase = 'idle';
  var stroke = null;       /* in-progress type-B drag samples */
  var strokeId = null;     /* pointer that owns the stroke (ignore extra fingers) */
  var reveal = null;       /* { score, tap | points } after each puzzle */
  var revealTimer = null;

  function rand(lo, hi) { return lo + Math.random() * (hi - lo); }
  function deg(r) { return r * 180 / Math.PI; }

  /* One edge segment on a ray out of the VP: radial span [gap, gap+len]
     at elevation e off the horizon, picked so both endpoints stay on
     canvas; gap and len shrink when the corner is too tight. */
  function placeSegment(vpX, vpY, side, vSign, gapFrac, lenFrac) {
    var gap = gapFrac * W, len = lenFrac * W;
    var hspace = side > 0 ? W - MARGIN - vpX : vpX - MARGIN;
    var vspace = vSign > 0 ? H - MARGIN - vpY : vpY - MARGIN;
    var eMin = 12, eMax = 60, reach, k;
    for (k = 0; k < 24; k++) {
      reach = gap + len;
      eMin = Math.max(12, deg(Math.acos(clamp01(hspace / reach))));
      eMax = Math.min(60, deg(Math.asin(clamp01(vspace / reach))));
      if (eMin <= eMax) break;
      gap = Math.max(0.05 * W, gap * 0.85);
      len = Math.max(0.11 * W, len * 0.92);
    }
    var e = (eMin <= eMax ? rand(eMin, eMax) : Math.max(8, Math.min(eMin, eMax))) * Math.PI / 180;
    var ux = side * Math.cos(e), uy = vSign * Math.sin(e);
    return {
      x1: vpX + ux * gap, y1: vpY + uy * gap,
      x2: vpX + ux * (gap + len), y2: vpY + uy * (gap + len)
    };
  }

  /* Type A: pick the VP first, then two edges elsewhere pointing at
     it — roof and base of an implied box, one above the horizon and
     one below, so their lines cross cleanly at the hidden VP.
     Ramp: later puzzles get shorter segments placed further away. */
  function makePuzzleA(aIdx) {
    var hy = rand(0.2, 0.8) * H;
    var vpX = rand(0.05, 0.95) * W;
    var side = vpX < W / 2 ? 1 : -1; /* the edges go where the room is */
    var lenFrac = 0.25 - 0.05 * aIdx + rand(-0.01, 0.01);
    var gapFrac = 0.16 + 0.08 * aIdx + rand(-0.02, 0.02);
    return {
      type: 'A', hy: hy, vpX: vpX, vpY: hy,
      segs: [
        placeSegment(vpX, hy, side, -1, gapFrac, lenFrac),
        placeSegment(vpX, hy, side, 1, gapFrac, lenFrac)
      ]
    };
  }

  /* Type B: horizon + visible VP, plus a bold start dot P.
     Ramp: P sits nearer the horizon — shallow edges are the test. */
  function makePuzzleB(bIdx) {
    var hy = rand(0.2, 0.8) * H;
    var vpX = rand(0.05, 0.95) * W;
    var side = vpX < W / 2 ? 1 : -1;
    var dy = (0.34 - 0.12 * bIdx + rand(-0.02, 0.02)) * H;
    var below = hy + dy <= H - MARGIN - 20;
    var above = hy - dy >= MARGIN + 20;
    var vSign = (below && above) ? (Math.random() < 0.5 ? 1 : -1) : (below ? 1 : -1);
    var pX = vpX + side * rand(0.35, 0.52) * W;
    pX = Math.max(MARGIN + 10, Math.min(W - MARGIN - 10, pX));
    return { type: 'B', hy: hy, vpX: vpX, vpY: hy, pX: pX, pY: hy + vSign * dy };
  }

  function nextPuzzle() {
    reveal = null;
    stroke = null;
    var typeA = idx % 2 === 0;
    puzzle = typeA ? makePuzzleA(Math.floor(idx / 2)) : makePuzzleB(Math.floor(idx / 2));
    phase = 'play';
    hint.textContent = typeA
      ? 'puzzle ' + (idx + 1) + ' of ' + PUZZLES_PER_ROUND + ' — two edges recede. tap the point where they meet.'
      : 'puzzle ' + (idx + 1) + ' of ' + PUZZLES_PER_ROUND + ' — press the bold dot, drag the edge into the ringed point.';
    draw();
  }

  function newRound() {
    /* "new round" mid-reveal of the last puzzle: the round *was*
       completed, so report it before resetting — completed rounds
       always reach ArtDaily.report exactly once. */
    if (phase === 'reveal' && scores.length === PUZZLES_PER_ROUND) finishRound();
    round += 1;
    idx = 0;
    scores = [];
    clearTimeout(revealTimer);
    hudRound.textContent = String(round);
    hudScore.textContent = '–';
    nextPuzzle();
  }

  /* ===== painting (canvas bg stays clear so the dot-grid shows) ===== */

  function line(x1, y1, x2, y2) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  function dot(x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function ring(x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  function draw() {
    var c = inks();
    ctx.clearRect(0, 0, W, H);
    if (!puzzle) return;

    /* muted horizon */
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.6;
    line(0, puzzle.hy, W, puzzle.hy);
    ctx.globalAlpha = 1;

    ctx.lineCap = 'round';
    if (puzzle.type === 'A') {
      /* the two given receding edges */
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 3;
      var i, s;
      for (i = 0; i < puzzle.segs.length; i++) {
        s = puzzle.segs[i];
        line(s.x1, s.y1, s.x2, s.y2);
      }
    } else {
      /* visible VP: accent ring on the horizon */
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 2.5;
      ring(puzzle.vpX, puzzle.vpY, 7);
      ctx.fillStyle = c.accent;
      dot(puzzle.vpX, puzzle.vpY, 2.5);
      /* bold start dot P with a grab halo */
      ctx.fillStyle = c.ink;
      dot(puzzle.pX, puzzle.pY, 8);
      ctx.strokeStyle = c.muted;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.7;
      ring(puzzle.pX, puzzle.pY, 14);
      ctx.globalAlpha = 1;
      /* live stroke */
      if (stroke && stroke.length > 1) {
        ctx.strokeStyle = c.ink;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(stroke[0].x, stroke[0].y);
        for (i = 1; i < stroke.length; i++) ctx.lineTo(stroke[i].x, stroke[i].y);
        ctx.stroke();
      }
    }

    if (reveal) drawReveal(c);
  }

  /* Reveal: every construction line extended home to the true VP in
     accent, the player's attempt on top, and the score flashed. */
  function drawReveal(c) {
    var i;
    ctx.save();
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    if (puzzle.type === 'A') {
      for (i = 0; i < puzzle.segs.length; i++) {
        line(puzzle.vpX, puzzle.vpY, puzzle.segs[i].x2, puzzle.segs[i].y2);
      }
    } else {
      line(puzzle.pX, puzzle.pY, puzzle.vpX, puzzle.vpY);
    }
    ctx.setLineDash([]);

    /* the true VP */
    ctx.fillStyle = c.accent;
    dot(puzzle.vpX, puzzle.vpY, 4);
    ring(puzzle.vpX, puzzle.vpY, 9);

    /* the player's answer */
    if (reveal.tap) {
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 2.5;
      line(reveal.tap.x - 7, reveal.tap.y - 7, reveal.tap.x + 7, reveal.tap.y + 7);
      line(reveal.tap.x - 7, reveal.tap.y + 7, reveal.tap.x + 7, reveal.tap.y - 7);
    }
    if (reveal.points && reveal.points.length > 1) {
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 2.5;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(reveal.points[0].x, reveal.points[0].y);
      for (i = 1; i < reveal.points.length; i++) ctx.lineTo(reveal.points[i].x, reveal.points[i].y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    /* score flash */
    ctx.fillStyle = c.accent;
    ctx.font = '900 30px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(String(reveal.score), W / 2, 40);
    ctx.restore();
  }

  /* ===== input ===== */

  function pointerPos(ev) {
    var rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  canvas.addEventListener('pointerdown', function (ev) {
    if (phase !== 'play' || !puzzle) return;
    ev.preventDefault();
    var p = pointerPos(ev);
    if (puzzle.type === 'A') {
      settlePuzzle(scoreVpTap(p.x, p.y, puzzle.vpX, puzzle.vpY, W), { tap: p });
      return;
    }
    if (stroke) return; /* one finger draws; extras are ignored */
    if (Math.hypot(p.x - puzzle.pX, p.y - puzzle.pY) > GRAB_RADIUS) {
      hint.textContent = 'start on the bold dot, then drag toward the ringed point.';
      return;
    }
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    stroke = [p];
    strokeId = ev.pointerId;
    draw();
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (!stroke || ev.pointerId !== strokeId || phase !== 'play') return;
    ev.preventDefault();
    var p = pointerPos(ev);
    var last = stroke[stroke.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) >= 3) {
      stroke.push(p);
      draw();
    }
  });

  canvas.addEventListener('pointerup', function (ev) {
    if (!stroke || ev.pointerId !== strokeId || phase !== 'play') return;
    ev.preventDefault();
    var pts = stroke;
    stroke = null;
    strokeId = null;
    pts.push(pointerPos(ev));
    var span = Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y);
    var s = span < MIN_STROKE ? null : scoreEdgeStroke(pts, puzzle.pX, puzzle.pY, puzzle.vpX, puzzle.vpY);
    if (s === null) {
      hint.textContent = 'too short — drag a longer edge so its angle can be read.';
      draw();
      return;
    }
    settlePuzzle(s, { points: pts });
  });

  canvas.addEventListener('pointercancel', function () {
    stroke = null;
    strokeId = null;
    draw();
  });

  /* ===== score bookkeeping ===== */

  function feedbackLine(s) {
    var word = s >= 90 ? 'nailed it' : s >= 70 ? 'close' : s >= 40 ? 'drifting' : 'wide of the mark';
    return word + ' — ' + s + ' for that one.';
  }

  function settlePuzzle(score, attempt) {
    scores.push(score);
    reveal = { score: Math.round(score), tap: attempt.tap || null, points: attempt.points || null };
    phase = 'reveal';
    hint.textContent = feedbackLine(reveal.score);
    draw();
    clearTimeout(revealTimer);
    revealTimer = setTimeout(function () {
      idx += 1;
      if (idx < PUZZLES_PER_ROUND) nextPuzzle();
      else finishRound();
    }, REVEAL_MS);
  }

  function finishRound() {
    phase = 'idle';
    puzzle = null;
    reveal = null;
    draw();
    var mean = scores.reduce(function (a, b) { return a + b; }, 0) / scores.length;
    var res = ArtDaily.report(mean);
    hudScore.textContent = String(res.score);
    hudBest.textContent = res.best === null ? '–' : String(res.best);
    hint.textContent = 'round done — press “new round” to hunt again.';
    showToast((res.isNewBest ? 'new best! ' : 'score ') + res.score + ' / 100', res.isNewBest);
  }

  var toastTimer = null;
  function showToast(msg, celebrate) {
    toast.innerHTML = '';
    var s = document.createElement('span');
    s.className = celebrate ? 'toast-accent' : '';
    s.textContent = msg;
    toast.appendChild(s);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 2200);
  }

  /* ===== chrome wiring ===== */

  document.getElementById('btnRound').addEventListener('click', newRound);

  var btnHow = document.getElementById('btnHow');
  var howTo = document.getElementById('howTo');
  btnHow.addEventListener('click', function () {
    howTo.hidden = !howTo.hidden;
    btnHow.setAttribute('aria-expanded', String(!howTo.hidden));
  });

  ArtDaily.onTheme(draw);

  /* The aspect is fixed, so a resize is a uniform rescale of the live
     puzzle — scores stay honest because errors are width-relative. */
  function scalePoint(p, f) { p.x *= f; p.y *= f; }
  function scalePuzzle(f) {
    var i;
    puzzle.hy *= f; puzzle.vpX *= f; puzzle.vpY *= f;
    if (puzzle.segs) {
      for (i = 0; i < puzzle.segs.length; i++) {
        puzzle.segs[i].x1 *= f; puzzle.segs[i].y1 *= f;
        puzzle.segs[i].x2 *= f; puzzle.segs[i].y2 *= f;
      }
    }
    if (puzzle.type === 'B') { puzzle.pX *= f; puzzle.pY *= f; }
    if (reveal && reveal.tap) scalePoint(reveal.tap, f);
    if (reveal && reveal.points) for (i = 0; i < reveal.points.length; i++) scalePoint(reveal.points[i], f);
    stroke = null; /* abandon a mid-resize drag */
    strokeId = null;
  }

  window.addEventListener('resize', function () {
    var oldW = W;
    fitCanvas();
    if (puzzle && oldW > 0 && W !== oldW) scalePuzzle(W / oldW);
    draw();
  });

  /* ===== boot ===== */
  fitCanvas();
  var best = ArtDaily.best();
  hudBest.textContent = best === null ? '–' : String(best);
  newRound();
})();
