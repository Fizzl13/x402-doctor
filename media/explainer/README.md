# Explainer video

A ~75-second narrated explainer of x402 Doctor, produced entirely by
[`explainer-video.yml`](../../.github/workflows/explainer-video.yml):

1. `tts.py` reads each line of `script.json` with Kokoro (open-weight neural TTS).
2. `record.js` drives Chromium through the **live** pages (the red `/demo/broken`
   diagnosis, the green Ichimoku one, the pre-payment check with its real verdict,
   `/trust`), timed to the voice, with burned-in captions and title cards.
3. `build.py` places each voice line where its scene starts and encodes
   `x402-doctor-explainer.mp4` (1920×1080, H.264/AAC), an `.srt` and `poster.jpg`.

Run it: Actions → "Explainer video" → Run workflow (optionally pick a voice).

The same pipeline makes the ~75-second **paid-fix update** from `fix.json`
(pick it as the workflow's script): the broken demo, the "Get the fix" card,
the real fixes for that demo, and an agent buying them over x402. It publishes
to the `fix-video` branch as `x402-doctor-fix.mp4`. The recorder has no wallet,
so the payment step shows the page's own statuses; the fixes on screen are
the real engine output for `/demo/broken`.
Edit the narration in `script.json`; the timing follows the voice automatically.

Local dry run without a voice model (silent narration of the right length):
`python tts.py --engine silent && node record.js && python build.py`
(prefix each with `SCRIPT=fix.json` for the update video).
