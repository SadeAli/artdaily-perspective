# Vanishing Act — hunt vanishing points

A daily perspective drill: six quick puzzles that train both halves of
linear perspective, both drawn by hand. Odd puzzles ("hunt") show two
receding edges — press either edge's tip-dot and stroke the edge onward to
the hidden vanishing point, exactly how construction lines are extended in
practice. Even puzzles ("aim") show the vanishing point — press the start
dot and drag a receding edge into it, blind: the ink only appears on
release, so the drill tests aim rather than tracing. After every attempt
the true construction lines are revealed in accent with the raw error
("14px left of the point", "2.1° off, aimed 9px high"); reveals are
player-paced — tap or press Enter to move on.

Scoring is pure geometry, no time pressure. Hunt strokes score half on
angle off the true tip→VP ray (18° base tolerance, eased per hardware)
and half on how close their line passes to the point — measured
perpendicular to the line rather than along the horizon, because a
shallow ray amplifies a 1° wobble three or four times sideways, which is
geometry rather than skill (11% of canvas width, with a 42px floor, eased
per hardware). Aim strokes score on best-fit angle off the true edge,
folded to 0–90°. Both
are scaled by straightness (RMS wobble off the stroke's own best-fit
line), so a slow steered arc can't beat a confident straight stroke. The
round score is the mean of all six, shown on an end-of-round recap with a
hunt/aim split; puzzles get harder as the round goes on. Pressing "new
round" mid-round asks once before discarding progress. Full keyboard play:
focus the canvas, arrows rotate a guide edge (shift = fine), Enter
commits.

## What changed in the input-fairness pass

The stroke score is eased for the hardware in your hand and floored in
absolute pixels, and the crossing is now measured PERPENDICULAR to your
line rather than where it meets the horizon — a shallow ray amplified a
1° wobble into three or four times as much horizontal error, which is
geometry, not skill. Pressing near a start dot snaps onto it instead of
refusing the stroke, and a stroke that ran out of trackpad can be
continued: press again where you lifted, within a second, and the line
carries on rather than being scored as a bad short mark.

## Input fairness

Scores are only ever compared against your own history, so the drill
eases its tolerances for the hardware in your hand and says which one it
eased for (the "scoring for…" chip in the HUD). A pen keeps the strict
reference; a mouse or trackpad, which pivots at the wrist and cannot
creep, gets roughly double the room; a finger sits between. Start and
grab zones move the other way — a screenless tablet needs the *biggest*
targets, because the hand is out of sight. Relative tolerances carry an
absolute pixel floor so a phone is never held to a stricter standard
than a desktop for the same drill.

## Run it

No build step, no dependencies:

```sh
python3 -m http.server 8080
# then visit http://localhost:8080
```

Part of [Art Daily](https://artdaily.sadeali.com/) on the
[SadeAli](https://sadeali.com/) network — protocol and drill-design rules
live in the artdaily repo's `GAME_GUIDE.md`.
