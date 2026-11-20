# Trust City (Blender)

The x402 Trust Index as a night city in Blender 4.5 LTS: one tower per seller, as tall as its paid endpoints
(log scale), its windows coloured by today's verdicts (go, caution, don't pay, unreachable). The same scene as the
video on fizzl.eu; `/trust/city` is the interactive three.js version.

- `build_sellers.py atlas.json sellers.json`: today's sellers from the free `/api/trust/atlas`.
- `city_hd.py -- --still 150 --out still.png`: one 1920x1080 frame (about 4 min on 4 CPU cores, 64 samples);
  without `--still` it renders the 10 s orbit (240 frames; use `--gpu` on a machine with one).
- `week_card.py atlas.json sellers.json still.png card.jpg post.txt`: caption bar and the week's post text.

`.github/workflows/trust-city-week.yml` runs all three every Monday at 07:17 UTC and keeps the result as an
artifact. Blender 4.5 only: the compositor code is written for it (5.x changed the API).
