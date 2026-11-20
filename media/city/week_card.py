# The weekly Trust City card: today's still with a caption bar, and the post text that goes with it.
#   python3 week_card.py atlas.json sellers.json still.png trust-city-week.jpg post.txt
# The numbers are today's verdicts from the atlas (day_totals: [go, caution, no_go, unreachable] per day, oldest
# first), compared with the same day a week ago. ffmpeg draws the caption (fonts-inter).
import json, subprocess, sys
from datetime import date

atlas_path, sellers_path, still, out_jpg, out_txt = sys.argv[1:6]
atlas = json.load(open(atlas_path))
days, totals = atlas["days"], atlas["day_totals"]
today = totals[-1]
week_ago = totals[-8] if len(totals) >= 8 else None
sellers = len(json.load(open(sellers_path)))  # the towers in the picture (build_sellers.py)
paid = sum(today)
red = today[2]
day = date.fromisoformat(days[-1])
label = f"{day.day} {day.strftime('%b %Y')}"

def change(now, before):
    if before is None:
        return ""
    d = now - before
    return " (same as last week)" if d == 0 else f" ({'+' if d > 0 else '−'}{abs(d):,} since last week)"

FONT = "/usr/share/fonts/opentype/inter"
def esc(s):  # drawtext text escaping
    return s.replace("\\", "\\\\").replace(":", "\\:").replace("'", "’").replace("%", "\\%")

title = esc(f"x402 Trust City · week of {label}")
sub = esc(f"{sellers:,} sellers · {paid:,} paid endpoints · {red:,} a careful agent won't pay")
vf = (
    "scale=1920:1080,"
    "drawbox=x=0:y=ih-220:w=iw:h=220:color=0x020708@0.62:t=fill,"
    f"drawtext=fontfile={FONT}/Inter-SemiBold.otf:text='{title}':fontcolor=0xe8f5f0:fontsize=56:x=72:y=h-180,"
    f"drawtext=fontfile={FONT}/Inter-Regular.otf:text='{sub}':fontcolor=0xa8b5b2:fontsize=33:x=72:y=h-96,"
    f"drawtext=fontfile={FONT}/Inter-Medium.otf:text='x402-doctor.fizzl.eu/trust/city':fontcolor=0x61f5c3:fontsize=30:x=w-tw-72:y=h-96"
)
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", still, "-vf", vf, "-q:v", "3", out_jpg], check=True)

post = (
    f"The x402 Trust City, week of {label}.\n\n"
    f"{sellers:,} sellers of paid APIs for AI agents, one tower each, lit by today's verdicts.\n"
    f"{paid:,} paid endpoints; {red:,} of them a careful agent won't pay{change(red, week_ago[2] if week_ago else None)}.\n\n"
    "Explore it in 3D: https://x402-doctor.fizzl.eu/trust/city\n"
)
open(out_txt, "w").write(post)
print(post)
