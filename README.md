# Vanishing Act — hunt vanishing points

A daily perspective drill: six quick puzzles that train both halves of
linear perspective. Odd puzzles show two receding edges — tap the hidden
vanishing point where their extensions meet. Even puzzles show the
vanishing point — press the start dot and drag a receding edge into it.
After every attempt the true construction lines are revealed in accent so
you see exactly how far off you were.

Scoring is pure geometry, no time pressure: tap distance to the true point
(as a fraction of canvas width) or your stroke's angle off the true edge
(best-fit line, folded to 0–90°). The round score is the mean of all six;
puzzles get harder as the round goes on.

## Run it

No build step, no dependencies:

```sh
python3 -m http.server 8080
# then visit http://localhost:8080
```

Part of [Art Daily](https://artdaily.sadeali.com/) on the
[SadeAli](https://sadeali.com/) network — protocol and drill-design rules
live in the artdaily repo's `GAME_GUIDE.md`.
