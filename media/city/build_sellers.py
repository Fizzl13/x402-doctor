# Today's Trust Index as sellers.json for city_hd.py: [[site, [go, caution, no_go, unreachable]], ...], biggest first.
# Reads the free atlas (x402-doctor /api/trust/atlas): each endpoint's history ends with today's verdict
# (g/c/n/x, '-' = not scanned today); sellers with more endpoints than the atlas lists have exact daily counts
# in seller_days.   python3 build_sellers.py atlas.json sellers.json
import json, sys
src, dst = sys.argv[1], sys.argv[2]
atlas = json.load(open(src))
names = [s[0] for s in atlas["sellers"]]
counts = {}
for e in atlas["endpoints"]:
    i, hist = e[0], e[1]
    k = "gcnx".find(hist[-1])
    if k >= 0:
        counts.setdefault(i, [0, 0, 0, 0])[k] += 1
for i, days in atlas.get("seller_days", []):
    counts[i] = list(days[-1])
rows = [[names[i], c] for i, c in counts.items() if sum(c) > 0]
rows.sort(key=lambda r: (-sum(r[1]), r[0]))
json.dump(rows, open(dst, "w"))
tot = [sum(r[1][k] for r in rows) for k in range(4)]
print(f"{len(rows)} sellers, {sum(tot)} endpoints, go {tot[0]} caution {tot[1]} no_go {tot[2]} unreachable {tot[3]}")
