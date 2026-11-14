"""The router page web_ua/go/: a point (?lat=&lon=, or a WarAlarm target ?id=) -> the oblast viewer that holds it.

  python build_go.py

Writes web_ua/go/oblasts.json (simplified oblast outlines in degrees + each oblast's published URL) and
web_ua/go/index.html. Every other query parameter is passed on, so ?id=...&lat=...&lon=...&cat=... opens the oblast
viewer in "follow" mode (see the follow block in viewer_region_tpl.html). The oblast viewers use oblasts.json too, to
hand a target over to the next oblast when it crosses the border.
"""
import json, math, os
from ua_region import Proj

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
hub = json.load(open(os.path.join(ROOT, 'web_ua', 'hub', 'hub.json'), encoding='utf-8'))
urls_p = os.path.join(ROOT, 'data_ua', 'urls.json')
urls = json.load(open(urls_p, encoding='utf-8')) if os.path.exists(urls_p) else {}
P = Proj(*hub['origin'])


def rdp(pts, tol):
    if len(pts) < 4: return pts
    a, b = pts[0], pts[-1]; dx, dy = b[0] - a[0], b[1] - a[1]; L = math.hypot(dx, dy) or 1e-9
    i, dm = 0, -1.0
    for k in range(1, len(pts) - 1):
        d = abs(dy * (pts[k][0] - a[0]) - dx * (pts[k][1] - a[1])) / L
        if d > dm: i, dm = k, d
    if dm <= tol: return [a, b]
    return rdp(pts[:i + 1], tol)[:-1] + rdp(pts[i:], tol)


out = []
for o in hub['oblasts']:
    rings = []
    for r in o['rings']:
        r = rdp([tuple(p) for p in r], 900)
        if len(r) < 4: continue
        rings.append([[round(lon, 3), round(lat, 3)] for lat, lon in (P.inv(x, y) for x, y in r)])
    ll = [p for r in rings for p in r]
    out.append(dict(slug=o['slug'], name=o['name'], url=urls.get(o['slug'], ''),
                    bbox=[min(p[0] for p in ll), min(p[1] for p in ll), max(p[0] for p in ll), max(p[1] for p in ll)], rings=rings))
# the cities with their own viewer first: Kyiv sits in a hole of Kyiv oblast, Sevastopol inside Crimea's outline
out.sort(key=lambda o: o['slug'] not in ('kyiv', 'sevastopol'))
d = os.path.join(ROOT, 'web_ua', 'go'); os.makedirs(d, exist_ok=True)
js = json.dumps(out, ensure_ascii=False, separators=(',', ':'))
open(os.path.join(d, 'oblasts.json'), 'w', encoding='utf-8', newline='\n').write(js)
html = open(os.path.join(HERE, 'go_tpl.html'), encoding='utf-8').read()
open(os.path.join(d, 'index.html'), 'w', encoding='utf-8', newline='\n').write(html)
print('go/oblasts.json', len(js), 'bytes,', sum(len(r) for o in out for r in o['rings']), 'points')
