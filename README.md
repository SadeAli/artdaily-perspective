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
angle off the true tip→VP ray (14° tolerance) and half on where their line
crosses the horizon vs the true point (12% of canvas width tolerance). Aim
strokes score on best-fit angle off the true edge, folded to 0–90°. Both
are scaled by straightness (RMS wobble off the stroke's own best-fit
line), so a slow steered arc can't beat a confident straight stroke. The
round score is the mean of all six, shown on an end-of-round recap with a
hunt/aim split; puzzles get harder as the round goes on. Pressing "new
round" mid-round asks once before discarding progress. Full keyboard play:
focus the canvas, arrows rotate a guide edge (shift = fine), Enter
commits.

## Run it

No build step, no dependencies:

```sh
python3 -m http.server 8080
# then visit http://localhost:8080
```

Part of [Art Daily](https://artdaily.sadeali.com/) on the
[SadeAli](https://sadeali.com/) network — protocol and drill-design rules
live in the artdaily repo's `GAME_GUIDE.md`.
