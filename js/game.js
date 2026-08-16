/* ============================================================
   game.js — Vanishing Act. Six perspective puzzles per round,
   alternating two halves of one skill, both drawn by hand:
     odd  (A) two receding edges are drawn — press an edge's
              tip-dot and STROKE the edge onward to the hidden
              vanishing point; scored on your stroke's angle and
              on where its line crosses the horizon vs the true VP;
     even (B) the vanishing point is shown — press the bold start
              dot and drag the receding edge into it, blind: the
              ink only appears when you release.
   Scoring is pure geometry (helpers at the top, canvas-free so
   they are unit-testable); straightness counts — a steered arc
   scores below a confident straight stroke. Reveals are player-
   paced (tap/Enter to advance) and the round ends on a recap
   with a hunt/aim split; the round reports the mean of six.
   Skeleton follows the template: init → round → input → score →
   ArtDaily.report, one theme-aware canvas, no libraries.
   ============================================================ */
(function () {
  'use strict';

  var SLUG = 'perspective';
  var PUZZLES_PER_ROUND = 6;
  var GRAB_RADIUS = 28;   /* base px around a start dot — eased per hardware */
  /* SNAP, DO NOT REJECT. On a screenless tablet the hand is out of sight,
     so acquiring a small dot is the single hardest thing that device
     does, and a refusal produces no ink at all — which reads as "this
     site is broken", not as "you missed". A press anywhere inside SNAP×
     the grab radius is accepted and its first sample is translated onto
     the dot, so the stroke the player meant is the stroke that is
     scored. */
  var GRAB_SNAP = 3;
  var MIN_STROKE = 24;    /* px of drag before an angle can be read */
  /* A trackpad physically cannot pull a long stroke in one throw: it
     runs out of pad, lifts, re-places and pulls again. A new press that
     lands near the last lift, soon after, CONTINUES the same stroke
     instead of being scored as a separate short one. */
  var RESUME_MS = 900, RESUME_PX = 60;

  /* The error at which a stroke scores zero, before easing. Both are
     motor-skill tolerances on a drawn mark, so both get eased: a mouse
     pivots at the wrist and cannot creep, a finger is a blunt tool. */
  var ANG_ZERO_DEG = 18;
  var CROSS_ZERO_FRAC = 0.11;
  var CROSS_ZERO_PX = 42;  /* absolute floor, so a phone is not stricter */
  var MARGIN = 14;        /* constructions keep off the canvas edge */
  var KB_LEN = 0.35;      /* keyboard guide-edge length, fraction of W */

  /* ===== pure scoring math (geometry in, 0–100 out) ===== */

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  /* Fold an angular difference to [0, 90] degrees — a drawn edge has
     no inherent direction, so 178° off really means 2° off. */
  function foldDeg(d) {
    d = Math.abs(d) % 180;
    return d > 90 ? 180 - d : d;
  }

  /* Least-squares line through a point cloud: principal direction in
     degrees, centroid, and the RMS perpendicular residual (how far
     the points wobble off their own best line). Null when the points
     do not span a line. */
  function fitLine(points) {
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
    var tr = sxx + syy;
    /* `tr < 1e-6` alone let a NaN through: NaN < 1e-6 is false, so a point
       cloud with one non-finite coordinate produced a fit object whose
       every field was NaN, and scoreVpStroke then returned score: NaN —
       which reaches the HUD, the toast and (via report) the permanent
       best as the literal text "NaN". A fit that is not a real line is
       NOT a fit: return null and let the caller say "that mark was too
       short to read an angle from", which is the honest outcome and the
       one path that is already handled everywhere. */
    if (!isFinite(tr) || tr < 1e-6) return null;
    var disc = Math.sqrt(Math.max(0, (sxx - syy) * (sxx - syy) + 4 * sxy * sxy));
    var lambdaMin = (tr - disc) / 2; /* variance perpendicular to the fit */
    var out = {
      deg: 0.5 * Math.atan2(2 * sxy, sxx - syy) * 180 / Math.PI,
      cx: mx, cy: my,
      rms: Math.sqrt(Math.max(0, lambdaMin) / n)
    };
    if (!isFinite(out.deg) || !isFinite(out.cx) || !isFinite(out.cy) || !isFinite(out.rms)) return null;
    return out;
  }

  /* Straightness factor in [0.6, 1]: free below 1% wobble-per-span
     (honest hand tremor), sliding penalty up to 40% by 7% — a slow
     steered arc can't cash in on where it happened to end up. */
  function straightnessFactor(rms, span) {
    /* This multiplies the WHOLE score, so a NaN here is a NaN score — the
       one value that must never reach the HUD or the permanent best.
       fitLine already refuses to hand out a non-finite rms, so this guard
       is the identity in real play; it exists so the next refactor of
       fitLine cannot quietly turn a broken fit into "NaN / 100". */
    if (!(span > 0) || !isFinite(rms)) return 1;
    var r = rms / span;
    return 0.6 + 0.4 * clamp01(1 - Math.max(0, r - 0.01) / 0.06);
  }

  /* Type B: angle between the stroke's best-fit line and the true
     P→VP edge, folded to [0,90]; base = 100 * clamp(1 - angErr/14),
     scaled by straightness. missY = where the drawn line crosses the
     VP's vertical, minus vpY (negative = aimed high). */
  function scoreEdgeStroke(points, pX, pY, vpX, vpY, ease) {
    var e = (typeof ease === 'number' && isFinite(ease) && ease > 0) ? ease : 1;
    var fit = fitLine(points);
    if (fit === null) return null;
    var span = Math.hypot(points[points.length - 1].x - points[0].x,
                          points[points.length - 1].y - points[0].y);
    var trueDeg = Math.atan2(vpY - pY, vpX - pX) * 180 / Math.PI;
    var angErr = foldDeg(fit.deg - trueDeg);
    var th = fit.deg * Math.PI / 180;
    var missY = Math.abs(Math.cos(th)) < 1e-6
      ? null
      : fit.cy + (vpX - fit.cx) * Math.tan(th) - vpY;
    return {
      score: 100 * clamp01(1 - angErr / (ANG_ZERO_DEG * e)) * straightnessFactor(fit.rms, span),
      angErr: angErr,
      missY: missY
    };
  }

  /* Type A: the stroke extends a given edge (from tipX,tipY) toward
     the hidden VP. Half the score is the angle off the true tip→VP
     ray; half is where the drawn line crosses the horizon (y = vpY)
     vs the true VP, as a fraction of canvas width (same 0.12
     tolerance the old tap used). Straightness scales the total.
     missX = crossing minus vpX (negative = crossed left of the VP). */
  function scoreVpStroke(points, tipX, tipY, vpX, vpY, canvasWidth, ease) {
    if (!(canvasWidth > 0)) return null;
    var e = (typeof ease === 'number' && isFinite(ease) && ease > 0) ? ease : 1;
    var fit = fitLine(points);
    if (fit === null) return null;
    var span = Math.hypot(points[points.length - 1].x - points[0].x,
                          points[points.length - 1].y - points[0].y);
    var trueDeg = Math.atan2(vpY - tipY, vpX - tipX) * 180 / Math.PI;
    var angErr = foldDeg(fit.deg - trueDeg);
    var angleScore = 100 * clamp01(1 - angErr / (ANG_ZERO_DEG * e));
    var th = fit.deg * Math.PI / 180;
    /* HOW FAR THE LINE PASSES FROM THE POINT, measured perpendicular to
       the line itself — not where it crosses the horizon.
       The horizontal crossing was the wrong yardstick: when the true ray
       is shallow (which it usually is, because the vanishing point sits
       out sideways) a 1° wobble slides the horizon crossing by three or
       four times as much as it moves the line. That amplification is
       geometry, not skill, and it hit exactly the strokes a beginner
       makes. The perpendicular miss says the honest thing — "your line
       passed this far from the point" — and treats a steep ray and a
       shallow one alike. missX is still reported, because "you crossed
       left of it" is the sentence the reveal wants. */
    var crossZero = Math.max(CROSS_ZERO_FRAC * canvasWidth, CROSS_ZERO_PX) * e;
    var ux = Math.cos(th), uy = Math.sin(th);
    var perpMiss = Math.abs((vpX - fit.cx) * uy - (vpY - fit.cy) * ux);
    var crossScore = isFinite(perpMiss) ? 100 * clamp01(1 - perpMiss / crossZero) : 0;
    var missX = null;
    if (Math.abs(Math.sin(th)) >= 1e-3) {
      missX = fit.cx + (vpY - fit.cy) / Math.tan(th) - vpX;
    }
    /* The point on the drawn line closest to the true VP — the far end of
       the distance that was actually scored. The reveal draws the gap so
       the picture and the number agree; without it the sheet showed only
       an × on the horizon, which on a shallow ray can sit hundreds of px
       away from a line that in fact passed close. */
    var proj = (vpX - fit.cx) * ux + (vpY - fit.cy) * uy;
    return {
      score: (0.5 * angleScore + 0.5 * crossScore) * straightnessFactor(fit.rms, span),
      angErr: angErr,
      missX: missX,
      perpMiss: perpMiss,
      foot: isFinite(proj) ? { x: fit.cx + ux * proj, y: fit.cy + uy * proj } : null
    };
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

  function hexRGB(h) {
    if (!/^#[0-9a-fA-F]{6}$/.test(h)) return null;
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  function mixHex(a, b, wa) {
    var ca = hexRGB(a), cb = hexRGB(b), out = '#', i, v;
    if (!ca || !cb) return a;
    for (i = 0; i < 3; i++) {
      v = Math.round(ca[i] * wa + cb[i] * (1 - wa));
      out += (v < 16 ? '0' : '') + v.toString(16);
    }
    return out;
  }

  /* getComputedStyle() on the root forces a style resolve, and this ran at
     the top of every repaint — once per pointer sample while a stroke is
     being pulled — plus two hex parses and a mix for the accent. The
     tokens only move when the sheet flips theme, so cache them against
     data-theme; the cache invalidates itself the moment that attribute
     changes, so onTheme still repaints in the new colours. */
  var inkCache = null, inkKey = null;
  function inks() {
    var key = document.documentElement.dataset.theme || '';
    if (inkCache && inkKey === key) return inkCache;
    var cs = getComputedStyle(document.documentElement);
    var ink = cs.getPropertyValue('--ink').trim();
    var accent = cs.getPropertyValue('--game-accent').trim() || cs.getPropertyValue('--bubblegum').trim();
    /* the stylesheet's sticker recipe: bubblegum inked 55/45 toward graphite
       on paper (2.95:1 raw → 5.71:1), pure accent on the dark sheet where it
       already clears AA. Everything the reveal means — the true VP, the
       construction lines, the score — is painted in this. */
    if (ArtDaily.theme() !== 'dark') accent = mixHex(accent, ink, 0.55);
    inkKey = key;
    inkCache = {
      ink: ink,
      muted: cs.getPropertyValue('--muted').trim(),
      accent: accent,
    };
    return inkCache;
  }

  /* ---- crisp canvas at any devicePixelRatio; height tracks width ----
     Returns true only when the sheet really changed size: assigning
     canvas.width reallocates and clears the backing store, and `resize`
     fires on every address-bar nudge on a phone. */
  var W = 0, H = 0, fitDpr = 0;
  function fitCanvas() {
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var dpr = window.devicePixelRatio || 1;
    if (w === W && dpr === fitDpr) return false;
    W = w;
    H = Math.round(W * 0.62);
    fitDpr = dpr;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  /* ---- one repaint per frame ----
     A pointermove can land two or three times inside one displayed frame,
     and each one used to redraw the horizon, both given edges, their grab
     dots and the whole live polyline. Only the last is ever shown. One
     rAF paints on the same vsync with the rest of that work skipped. */
  var drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(function () { drawQueued = false; draw(); });
  }

  /* ===== round state ===== */
  /* phase: 'idle' | 'play' | 'reveal' */
  var round = 0, idx = 0, results = [], puzzle = null, phase = 'idle';
  var stroke = null;       /* in-progress drag samples */
  var strokeId = null;     /* pointer that owns the stroke (ignore extra fingers) */
  var grabTip = null;      /* type A: which edge tip the stroke grew from */
  var kbAim = null;        /* keyboard guide edge: {x, y, deg} */
  var reveal = null;       /* { score, points, missX, detail } after each puzzle */
  var recap = null;        /* end-of-round recap data */

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
      x1: vpX + ux * gap, y1: vpY + uy * gap,   /* inner tip (nearer the VP) */
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
    strokeId = null;
    grabTip = null;
    kbAim = null;
    pending = null;
    lastLift = null;
    var typeA = idx % 2 === 0;
    puzzle = typeA ? makePuzzleA(Math.floor(idx / 2)) : makePuzzleB(Math.floor(idx / 2));
    phase = 'play';
    var n = 'puzzle ' + (idx + 1) + ' of ' + PUZZLES_PER_ROUND + ' — ';
    /* "THE DOTS AT THEIR NEAR ENDS" POINTED THE WRONG WAY. placeSegment
       puts each grab dot at x1 — the end of its edge NEAREST the vanishing
       point, i.e. the far, distant end of a receding edge in the picture.
       To anyone who already thinks in perspective, "the near end" is the
       opposite end, the big foreground one; to a beginner it names nothing
       at all, and this is the very first press the drill ever asks for.
       Point at the dot instead — there is exactly one per edge and it is
       drawn with a halo — and say the action as continuing the line, which
       is what the stroke actually is. */
    say(typeA
      ? n + 'two edges run away from you and would meet somewhere off in the distance. press the dot on the end of either edge, then keep that same line going, out to where you think they meet.'
      : n + 'press the bold dot and pull the line into the ringed point. blind: the ink appears when you let go.');
    draw();
  }

  /* THE OPENING LESSON SURVIVES THE FIRST FUMBLE.
     The drill draws a faint horizontal line on every puzzle and, on the
     opening screen only, the hint is the one place that names it — and
     defines "vanishing point" at all. But every in-puzzle re-prompt
     (missed the tip-dot, missed the bold dot, mark too short to read)
     wrote straight over hint.textContent, and a beginner's FIRST press is
     exactly the press most likely to miss or to stop short. The one
     sentence that explains what the drill is about was being deleted by
     the player's first attempt to play it, with no way back short of
     "how to play". Every prompt now goes through here, and puzzle 1 keeps
     its gloss underneath whatever just happened. */
  var TEACH = ' (the faint flat line is the horizon — your own eye level.' +
    ' edges that are parallel in real life appear to meet at one spot on it,' +
    ' and that spot is the vanishing point.)';
  function say(msg) {
    hint.textContent = msg + (idx === 0 ? TEACH : '');
  }

  function doNewRound() {
    /* "new round" during the last reveal or recap: the round *was*
       completed, so report it before resetting — completed rounds
       always reach ArtDaily.report exactly once. */
    if (phase === 'reveal' && results.length === PUZZLES_PER_ROUND) finishRound();
    round += 1;
    idx = 0;
    results = [];
    recap = null;
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

  function startDot(c, x, y) {
    ctx.fillStyle = c.ink;
    dot(x, y, 8);
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.85; /* the grab affordance has to read: AA on both papers */
    ring(x, y, 14);
    ctx.globalAlpha = 1;
  }

  function drawPolyline(pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  function draw() {
    var c = inks();
    ctx.clearRect(0, 0, W, H);
    if (!puzzle) {
      if (recap) drawRecap(c);
      return;
    }

    /* The horizon carries the whole drill ("the point always sits ON it"),
       so it stays subordinate to the 3px ink edges but never below AA. */
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.85;
    line(0, puzzle.hy, W, puzzle.hy);
    ctx.globalAlpha = 1;

    ctx.lineCap = 'round';
    var i, s;
    if (puzzle.type === 'A') {
      /* the two given receding edges, with grabbable inner tip-dots */
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 3;
      for (i = 0; i < puzzle.segs.length; i++) {
        s = puzzle.segs[i];
        line(s.x1, s.y1, s.x2, s.y2);
      }
      if (phase === 'play') {
        for (i = 0; i < puzzle.segs.length; i++) startDot(c, puzzle.segs[i].x1, puzzle.segs[i].y1);
      }
      /* live stroke — visible for A: the target point is hidden, so
         seeing your own extension gives nothing away */
      if (phase === 'play' && stroke && stroke.length > 1) {
        ctx.strokeStyle = c.ink;
        ctx.lineWidth = 2.5;
        drawPolyline(stroke);
      }
    } else {
      /* visible VP: accent ring on the horizon (big enough for thumbs) */
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 3;
      ring(puzzle.vpX, puzzle.vpY, 10);
      ctx.fillStyle = c.accent;
      dot(puzzle.vpX, puzzle.vpY, 3);
      /* bold start dot P with a grab halo */
      startDot(c, puzzle.pX, puzzle.pY);
      /* blind stroke: only the fingertip shows while drawing — the
         ink appears on release, so the drill tests aim, not tracing */
      if (phase === 'play' && stroke && stroke.length > 0) {
        ctx.fillStyle = c.ink;
        dot(stroke[stroke.length - 1].x, stroke[stroke.length - 1].y, 3.5);
      }
    }

    /* keyboard guide edge */
    if (phase === 'play' && kbAim) {
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      var th = kbAim.deg * Math.PI / 180;
      line(kbAim.x, kbAim.y, kbAim.x + Math.cos(th) * KB_LEN * W, kbAim.y + Math.sin(th) * KB_LEN * W);
      ctx.setLineDash([]);
    }

    if (reveal) drawReveal(c);
  }

  /* pick the score-flash spot furthest from the action so the number
     never overprints the VP or the reveal lines */
  function flashPos(avoid) {
    var cands = [
      { x: W * 0.18, y: 34 }, { x: W * 0.82, y: 34 },
      { x: W * 0.18, y: H - 16 }, { x: W * 0.82, y: H - 16 }
    ];
    var best = cands[0], bestD = -1, i, j, d, m;
    for (i = 0; i < cands.length; i++) {
      m = Infinity;
      for (j = 0; j < avoid.length; j++) {
        d = Math.hypot(cands[i].x - avoid[j].x, cands[i].y - avoid[j].y);
        if (d < m) m = d;
      }
      if (m > bestD) { bestD = m; best = cands[i]; }
    }
    return best;
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

    /* the player's stroke */
    var avoid = [{ x: puzzle.vpX, y: puzzle.vpY }];
    if (reveal.points && reveal.points.length > 1) {
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 2.5;
      ctx.globalAlpha = 0.9;
      drawPolyline(reveal.points);
      ctx.globalAlpha = 1;
      avoid.push(reveal.points[0]);
      avoid.push(reveal.points[reveal.points.length - 1]);
    }
    /* type A: the gap that was actually scored — a hairline from the true
       point out to the nearest spot on the line you drew. This is the
       "passed 31px from the point" in the sentence, made visible. */
    if (reveal.foot) {
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.75;
      ctx.setLineDash([3, 3]);
      line(puzzle.vpX, puzzle.vpY, reveal.foot.x, reveal.foot.y);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      avoid.push(reveal.foot);
    }
    /* type A: × where the drawn line actually crossed the horizon — only
       when the crossing is genuinely on the sheet. It used to be clamped
       to the frame edge, which on a shallow ray (where the crossing can
       land thousands of px away) planted a confident × on a spot the line
       never went near. The perpendicular hairline above carries the
       lesson in that case, and the sentence still names the side. */
    if (reveal.missX !== null && reveal.missX !== undefined && isFinite(reveal.missX)) {
      var cx = puzzle.vpX + reveal.missX;
      if (cx >= 10 && cx <= W - 10) {
        ctx.strokeStyle = c.ink;
        ctx.lineWidth = 2.5;
        line(cx - 6, puzzle.vpY - 6, cx + 6, puzzle.vpY + 6);
        line(cx - 6, puzzle.vpY + 6, cx + 6, puzzle.vpY - 6);
        avoid.push({ x: cx, y: puzzle.vpY });
      }
    }

    /* score flash, placed away from the action */
    var pos = flashPos(avoid);
    ctx.fillStyle = c.accent;
    ctx.font = '900 30px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(String(reveal.score), pos.x, pos.y);
    ctx.restore();
  }

  /* End-of-round recap: the six scores and the hunt/aim split stay on
     the sheet until the next round starts. */
  function drawRecap(c) {
    var mono = 'ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = c.muted;
    ctx.font = '600 14px ' + mono;
    ctx.fillText('round ' + recap.round + ' — six puzzles', W / 2, H * 0.18);
    ctx.fillStyle = c.accent;
    ctx.font = '900 ' + Math.round(Math.max(30, Math.min(46, W * 0.09))) + 'px ' + mono;
    ctx.fillText(String(recap.mean), W / 2, H * 0.38);
    ctx.fillStyle = c.ink;
    ctx.font = '600 15px ' + mono;
    if (recap.hunt.length > 0) {
      ctx.fillText('hunt the point   ' + recap.hunt.join(' · ') + '   → ' + recap.huntMean, W / 2, H * 0.56);
    }
    if (recap.aim.length > 0) {
      ctx.fillText('aim the edge     ' + recap.aim.join(' · ') + '   → ' + recap.aimMean, W / 2, H * 0.68);
    }
    ctx.fillStyle = c.muted;
    ctx.font = '600 13px ' + mono;
    ctx.fillText('press “new round” to hunt again', W / 2, H * 0.86);
  }

  /* ===== input ===== */

  /* getBoundingClientRect() is a layout read, and this used to run once
     per pointer sample. The sheet cannot move under a live stroke without
     a scroll or a resize, and the hint line above it only re-wraps
     between puzzles, so measure once per gesture and drop the
     measurement on scroll or resize. */
  var canvasRect = null;
  function dropRect() { canvasRect = null; }
  window.addEventListener('scroll', dropRect, true);

  function pointerPos(ev) {
    var r = canvasRect || (canvasRect = canvas.getBoundingClientRect());
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  var lastPenAt = 0;
  var lastLift = null;   /* { x, y, at } — where the previous stroke ended */
  var pending = null;    /* samples carried over from a lifted stroke */

  canvas.addEventListener('pointerdown', function (ev) {
    /* palm rejection: a pen always beats a palm that landed first */
    if (ev.pointerType === 'pen') lastPenAt = Date.now();
    else if (ev.pointerType === 'touch' && Date.now() - lastPenAt < 500) return;
    /* reveals are player-paced: a tap moves on */
    if (phase === 'reveal') {
      ev.preventDefault();
      advanceReveal();
      return;
    }
    if (phase !== 'play' || !puzzle || stroke) return;
    ev.preventDefault();
    dropRect();                  /* a fresh gesture re-measures the sheet */
    var p = pointerPos(ev), i, s, d;
    var grabR = ArtDaily.startRadius(GRAB_RADIUS);

    /* A press that lands near where the last one lifted, soon after, is
       the same stroke carrying on — a trackpad running out of pad, not a
       new attempt. No snapping and no anchor test on a resume. */
    var resuming = !!(pending && lastLift &&
      Date.now() - lastLift.at <= RESUME_MS &&
      Math.hypot(p.x - lastLift.x, p.y - lastLift.y) <= RESUME_PX);

    if (!resuming) {
      pending = null;
      if (puzzle.type === 'A') {
        /* Grab the nearest inner tip-dot, snapping rather than refusing.
           The candidate is held locally and only becomes grabTip once
           the grab succeeds: clearing grabTip up front left a keyboard
           guide edge (kbAim) anchored to nothing, and the next Enter
           threw on grabTip.x inside commitStroke — forever, since kbAim
           survived the refusal too. */
        var tip = null;
        var bestD = grabR * GRAB_SNAP;
        for (i = 0; i < puzzle.segs.length; i++) {
          s = puzzle.segs[i];
          d = Math.hypot(p.x - s.x1, p.y - s.y1);
          if (d <= bestD) { bestD = d; tip = { x: s.x1, y: s.y1 }; }
        }
        if (!tip) {
          say('start on the dot at the end of one of the two edges, then keep that same line going.');
          return;
        }
        grabTip = tip;
        if (bestD > grabR) {
          /* outside the dot but inside the snap ring: put the first
             sample ON the dot instead of throwing the stroke away */
          p = { x: grabTip.x, y: grabTip.y };
        }
      } else {
        d = Math.hypot(p.x - puzzle.pX, p.y - puzzle.pY);
        if (d > grabR * GRAB_SNAP) {
          say('start on the bold dot, then drag toward the ringed point.');
          return;
        }
        if (d > grabR) p = { x: puzzle.pX, y: puzzle.pY };
      }
    }
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    stroke = resuming ? pending.concat([p]) : [p];
    pending = null;
    strokeId = ev.pointerId;
    kbAim = null;
    draw();
  });

  /* SAMPLING FIDELITY ON A FAST STROKE. One pointermove is one sample,
     but the digitizer under it reports at 120–240Hz and the browser hands
     over only what it could deliver in time. Pull the line quickly — which
     is exactly what a confident stroke IS, and what this drill asks for —
     and most of it never reaches the fit: a whole sweep can arrive as five
     or six points, a short one as two, which is the difference between a
     scored mark and "that mark was too short to read an angle from".
     Ask for the merged samples. The 3px spacing filter still stands, so
     the point count is bounded by the stroke's own length and a slow patch
     cannot outvote the rest of the line in the least-squares fit. */
  var SAMPLE_MIN_PX = 3;
  function pushSamples(ev, arr) {
    var list = null, added = false;
    try { list = ev.getCoalescedEvents ? ev.getCoalescedEvents() : null; } catch (e) { list = null; }
    if (!list || !list.length) list = [ev];
    for (var i = 0; i < list.length; i++) {
      var p = pointerPos(list[i]);
      if (!isFinite(p.x) || !isFinite(p.y)) continue;
      var last = arr[arr.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= SAMPLE_MIN_PX) {
        arr.push(p);
        added = true;
      }
    }
    return added;
  }

  canvas.addEventListener('pointermove', function (ev) {
    if (!stroke || ev.pointerId !== strokeId || phase !== 'play') return;
    ev.preventDefault();
    if (pushSamples(ev, stroke)) requestDraw();
  });

  function onStrokeUp(ev) {
    if (!stroke || ev.pointerId !== strokeId || phase !== 'play') return;
    ev.preventDefault();
    var pts = stroke;
    stroke = null;
    strokeId = null;
    /* The release position is the one sample that never went through
       pushSamples, so it is also the one that was never checked. A
       non-finite coordinate here makes every sum in fitLine NaN and the mark
       comes back "too short to read an angle from" — a refusal aimed at a
       player whose stroke was fine. Fall back to where the stroke already
       was; the release adds at most the last three pixels of it. */
    var end = pointerPos(ev);
    if (!isFinite(end.x) || !isFinite(end.y)) {
      /* a fresh object, never the last sample itself — scalePuzzle walks
         these arrays and would rescale a shared one twice */
      var back = pts[pts.length - 1];
      end = back ? { x: back.x, y: back.y } : null;
    }
    if (end) {
      pts.push(end);
      lastLift = { x: end.x, y: end.y, at: Date.now() };
    }
    commitStroke(pts);
  }

  function onStrokeCancel(ev) {
    /* an interrupted drag is abandoned, never scored — but only the pointer
       that owns the stroke may abandon it, or a stray second finger being
       cancelled would wipe the drag in progress */
    if (ev.pointerId !== strokeId) return;
    stroke = null;
    strokeId = null;
    draw();
  }

  canvas.addEventListener('pointerup', onStrokeUp);
  canvas.addEventListener('pointercancel', onStrokeCancel);
  /* A release the canvas never sees left `stroke` set for the rest of
     the round — and pointerdown returns early while one is in flight,
     so the sheet accepted no more ink until "new round". Both the
     off-window release and iOS, which drops the capture with
     lostpointercapture and never sends pointerup. A lost capture has no
     honest end position, so it abandons the stroke rather than score
     one; after a real pointerup strokeId is already null and these are
     no-ops. */
  window.addEventListener('pointerup', onStrokeUp);
  window.addEventListener('pointercancel', onStrokeCancel);
  canvas.addEventListener('lostpointercapture', onStrokeCancel);

  function commitStroke(pts) {
    /* A type-A mark is scored against the tip it grew from; with no
       anchor there is nothing to score. Unreachable now that a refused
       grab leaves grabTip alone, but commitStroke is the keyboard's
       entry point too and must never be able to throw. */
    if (puzzle.type === 'A' && !grabTip) {
      say('start on the dot at the end of one of the two edges, then keep that same line going.');
      draw();
      return;
    }
    var span = Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y);
    var ease = ArtDaily.ease(1);
    var r = null;
    if (span >= MIN_STROKE) {
      r = puzzle.type === 'A'
        ? scoreVpStroke(pts, grabTip.x, grabTip.y, puzzle.vpX, puzzle.vpY, W, ease)
        : scoreEdgeStroke(pts, puzzle.pX, puzzle.pY, puzzle.vpX, puzzle.vpY, ease);
    }
    if (r === null) {
      /* NOT SCORED — say what happened and why, and hold the samples so
         picking up where you lifted continues this stroke rather than
         starting a bad short one. A short mark on a trackpad usually
         means the pad ran out, not that the player did. */
      pending = pts;
      say('that mark was too short to read an angle from — nothing scored.' +
        ' press again where you lifted (within a second) and keep pulling the same line.');
      draw();
      return;
    }
    pending = null;
    settlePuzzle(r, pts);
  }

  /* keyboard play on the focused canvas: arrows aim a guide edge
     (shift = fine), Enter commits it; Enter/space advances a reveal */
  canvas.addEventListener('keydown', function (ev) {
    if (phase === 'reveal' && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault();
      advanceReveal();
      return;
    }
    if (phase !== 'play' || !puzzle) return;
    var arrows = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
    if (ev.key in arrows) {
      ev.preventDefault();
      if (!kbAim) {
        var ox, oy;
        if (puzzle.type === 'A') {
          grabTip = { x: puzzle.segs[0].x1, y: puzzle.segs[0].y1 };
          ox = grabTip.x; oy = grabTip.y;
        } else {
          ox = puzzle.pX; oy = puzzle.pY;
        }
        /* start horizontal toward the VP's side — never the answer */
        kbAim = { x: ox, y: oy, deg: puzzle.vpX >= ox ? 0 : 180 };
      }
      kbAim.deg += arrows[ev.key] * (ev.shiftKey ? 0.5 : 2);
      /* a held arrow auto-repeats faster than the screen refreshes */
      requestDraw();
    } else if (ev.key === 'Enter' && kbAim) {
      ev.preventDefault();
      var th = kbAim.deg * Math.PI / 180;
      commitStroke([
        { x: kbAim.x, y: kbAim.y },
        { x: kbAim.x + Math.cos(th) * KB_LEN * W, y: kbAim.y + Math.sin(th) * KB_LEN * W }
      ]);
      kbAim = null;
    } else if (ev.key === 'Escape' && kbAim) {
      ev.preventDefault();
      kbAim = null;
      draw();
    }
  });

  /* ===== score bookkeeping ===== */

  /* The reveal has to quote the miss the SCORE used. Half of a type-A mark
     is the perpendicular distance from the vanishing point to the drawn
     line, but the sentence quoted the horizon crossing instead — and on a
     shallow ray those two disagree by a factor of three or four. A player
     could read "180px left of the point" next to a 78 and conclude the
     number was invented. Lead with the scored distance; the crossing side
     is kept, because "you went past it on the left" is the fix. */
  function detailFor(type, r) {
    if (type === 'A') {
      if (!isFinite(r.perpMiss)) return 'could not read a line from that mark';
      var d = Math.round(r.perpMiss);
      if (d <= 2) return 'straight through the point';
      return 'passed ' + d + 'px from the point' +
        (r.missX === null || r.missX === undefined ? ''
          : ', crossing the horizon ' + (r.missX > 0 ? 'right' : 'left') + ' of it');
    }
    var out = (isFinite(r.angErr) ? r.angErr.toFixed(1) : '?') + '° off';
    /* `!== null` alone printed "NaN px low" for an undefined or non-finite
       crossing — the reveal must never quote a number it does not have. */
    if (typeof r.missY === 'number' && isFinite(r.missY)) {
      out += ', aimed ' + Math.round(Math.abs(r.missY)) + 'px ' + (r.missY < 0 ? 'high' : 'low');
    }
    return out;
  }

  function feedbackLine(s, detail) {
    var word = s >= 90 ? 'nailed it' : s >= 70 ? 'close' : s >= 40 ? 'drifting' : 'wide of the mark';
    return word + ' — ' + s + ' (' + detail + ').';
  }

  /* Mean of what has been scored so far. Three of the six sibling drills
     already keep the HUD alive this way; this one left the "score" field
     reading "–" for all six puzzles, so a beginner's only answer to "how
     am I doing" was the score flashed on the sheet for one puzzle and
     then painted over. */
  /* scoreVpStroke / scoreEdgeStroke can only hand this finite 0–100 values
     (they return null rather than a broken number), but this mean is what
     reaches ArtDaily.report — and from there the permanent personal best —
     as well as the HUD after every puzzle, and it had no sanitizing layer
     at all: one bad entry would print the literal text "NaN" and store it
     as a best no round could ever beat. Clamped as well as
     finiteness-checked, the way the sibling drills' means already are,
     because a finite "3e+307 / 100" is no better on the HUD than a NaN.
     The identity on every value this drill has ever produced. */
  function meanScore(list) {
    if (!list.length) return 0;
    var s = 0, i, v;
    for (i = 0; i < list.length; i++) {
      v = list[i] ? list[i].score : 0;
      s += (typeof v === 'number' && isFinite(v)) ? Math.max(0, Math.min(100, v)) : 0;
    }
    return s / list.length;
  }

  function settlePuzzle(r, pts) {
    results.push({ type: puzzle.type, score: r.score });
    hudScore.textContent = String(Math.round(meanScore(results)));
    reveal = {
      score: Math.round(r.score),
      points: pts,
      missX: puzzle.type === 'A' ? r.missX : null,
      foot: puzzle.type === 'A' ? (r.foot || null) : null
    };
    phase = 'reveal';
    /* THE FIRST REVEAL HAS TO SAY WHAT THE NEW MARKS ARE. Puzzle 1's
       reveal drops a ringed dot, two dashed rays and a hairline onto a
       sheet that has never carried any of them, and the sentence beside it
       talked only about pixels — so the one picture that shows a beginner
       where the point actually was arrived unnamed, and read as decoration
       around a grade. Every sibling drill names its reveal on sight ("the
       dashed ghost is the target pose", "the coloured line is the true
       1/2", "the coloured line and rings are the real answer"); this one
       now does too, once, on the screen where the marks are new. */
    var marks = '';
    if (idx === 0) {
      marks = puzzle.type === 'A'
        ? ' the ringed dot on the horizon is where those two edges really meet' +
          (reveal.foot && isFinite(r.perpMiss) && r.perpMiss > 3
            ? '; the hairline is the gap your line left.' : '.')
        : ' the dashed line is the edge you were aiming for.';
    }
    hint.textContent = feedbackLine(reveal.score, detailFor(puzzle.type, r)) + marks
      + (results.length < PUZZLES_PER_ROUND ? ' tap for the next puzzle.' : ' tap to finish the round.');
    draw();
  }

  function advanceReveal() {
    if (phase !== 'reveal') return;
    idx += 1;
    if (idx < PUZZLES_PER_ROUND) nextPuzzle();
    else finishRound();
  }

  function finishRound() {
    phase = 'idle';
    puzzle = null;
    reveal = null;
    kbAim = null;
    grabTip = null;
    var hunt = [], aim = [], hSum = 0, aSum = 0, i, e;
    for (i = 0; i < results.length; i++) {
      e = results[i];
      if (e.type === 'A') { hunt.push(Math.round(e.score)); hSum += e.score; }
      else { aim.push(Math.round(e.score)); aSum += e.score; }
    }
    var res = ArtDaily.report(meanScore(results));
    recap = {
      round: round,
      mean: res.score,
      hunt: hunt,
      aim: aim,
      huntMean: hunt.length > 0 ? Math.round(hSum / hunt.length) : 0,
      aimMean: aim.length > 0 ? Math.round(aSum / aim.length) : 0
    };
    hudScore.textContent = String(res.score);
    hudBest.textContent = res.best === null ? '–' : String(res.best);
    hint.textContent = 'round done — press “new round” to hunt again.';
    showToast((res.isNewBest ? 'new best! ' : 'score ') + res.score + ' / 100', res.isNewBest);
    draw();
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

  /* "new round" mid-round would silently discard progress, so the
     first press arms a confirmation; a second press within 2.5s
     confirms. A fresh or finished round starts immediately. */
  var btnRound = document.getElementById('btnRound');
  var btnRoundHTML = btnRound.innerHTML;
  var confirmArmed = false, confirmTimer = null;

  function disarmConfirm() {
    confirmArmed = false;
    clearTimeout(confirmTimer);
    btnRound.innerHTML = btnRoundHTML;
  }

  function roundInProgress() {
    if (!puzzle) return false;
    if (results.length >= PUZZLES_PER_ROUND) return false; /* finished, just unreported */
    return idx > 0 || results.length > 0;
  }

  btnRound.addEventListener('click', function () {
    if (roundInProgress() && !confirmArmed) {
      confirmArmed = true;
      btnRound.textContent = 'discard round?';
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(disarmConfirm, 2500);
      return;
    }
    disarmConfirm();
    doNewRound();
  });

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
    if (grabTip) scalePoint(grabTip, f);
    if (kbAim) { kbAim.x *= f; kbAim.y *= f; }
    if (reveal && reveal.points) for (i = 0; i < reveal.points.length; i++) scalePoint(reveal.points[i], f);
    if (reveal && reveal.missX !== null && reveal.missX !== undefined) reveal.missX *= f;
    if (reveal && reveal.foot) scalePoint(reveal.foot, f);
    /* THE HELD-OVER STROKE LIVES IN PIXELS TOO. A mark too short to read is
       not thrown away: its samples are parked in `pending` and a press back
       near `lastLift` within RESUME_MS carries on the same stroke. Both were
       left at the old scale here, so a resize in that window — an orientation
       flip, a desktop window drag, an address bar on a narrow phone — spliced
       old-scale samples onto new-scale ones and fitted a line with a kink in
       it that the hand never made, then scored it. Rescaling them is the same
       uniform rescale everything else on the sheet just had. */
    for (i = 0; pending && i < pending.length; i++) scalePoint(pending[i], f);
    if (lastLift) { lastLift.x *= f; lastLift.y *= f; }
    stroke = null; /* abandon a mid-resize drag */
    strokeId = null;
  }

  window.addEventListener('resize', function () {
    dropRect();
    var oldW = W;
    /* fitCanvas is a no-op when the sheet did not really change, so a
       phone's address bar sliding away during an ordinary scroll no
       longer reallocates the backing store — nor, through scalePuzzle,
       abandons a stroke that is still being pulled. */
    if (!fitCanvas()) { draw(); return; }
    if (puzzle && oldW > 0 && W !== oldW) scalePuzzle(W / oldW);
    draw();
  });

  /* ===== boot ===== */
  fitCanvas();
  var best = ArtDaily.best();
  hudBest.textContent = best === null ? '–' : String(best);
  doNewRound();
})();
