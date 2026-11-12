"""The all-Ukraine map (hub): relief, land cover, rivers, main roads, oblast / raion borders, every settlement.

  python ua_hub.py            # -> web_ua/hub/{hub.json, dem.bin.wasm, lc.png}

Coordinates: local Mercator around the centre of Ukraine, metres (x east, y north), like the oblast viewers.
"""
import os, sys, json, math, gzip, pickle, glob, time
import numpy as np
from PIL import Image, ImageDraw
import shapely
from shapely.geometry import Polygon, LineString
from shapely.ops import unary_union
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ua_region import Proj, read_pkl, dem_sampler, grid_heights, dp, area, LC, LCI

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
DU = os.path.join(ROOT, 'data_ua'); OUT = os.path.join(ROOT, 'web_ua', 'hub'); os.makedirs(OUT, exist_ok=True)
t0 = time.time()
OB = json.load(open(os.path.join(DU, 'oblasts.json'), encoding='utf-8'))
adm = pickle.load(open(os.path.join(DU, 'admin_sel.pkl'), 'rb'))
lon0 = min(o['bbox'][0] for o in OB); lat0 = min(o['bbox'][1] for o in OB); lon1 = max(o['bbox'][2] for o in OB); lat1 = max(o['bbox'][3] for o in OB)
P = Proj(round((lat0 + lat1) / 2, 4), round((lon0 + lon1) / 2, 4))
x0, y0 = P.xy(lat0, lon0); x1, y1 = P.xy(lat1, lon1)
x0 -= 30000; y0 -= 30000; x1 += 30000; y1 += 30000
print('extent km', round((x1 - x0) / 1000), round((y1 - y0) / 1000), flush=True)

def polys_xy(polys):
    out = []
    for p in polys:
        o = P.arr(p[0]); hs = [P.arr(h) for h in p[1:] if len(h) >= 8]
        try: g = Polygon(o, hs).buffer(0)
        except Exception: continue
        if not g.is_empty: out.append(g)
    return unary_union(out) if out else None
def rings_of(g, tol):
    out = []
    for pg in (g.geoms if hasattr(g, 'geoms') else [g]):
        if pg.area < 4e6: continue
        r = dp([tuple(c) for c in pg.exterior.coords][:-1], tol)
        if len(r) >= 3: out.append([[round(a), round(b)] for a, b in r])
    return out

# ---- oblasts
country = polys_xy(adm['country']) if adm.get('country') is not None else None
obl = []
for o in OB:
    g = polys_xy(adm['oblast'][o['slug']])
    rp = g.representative_point()
    reg = os.path.join(ROOT, 'web_ua', o['slug'], 'region.json')
    st = json.load(open(reg, encoding='utf-8'))['stats'] if os.path.exists(reg) else {}
    obl.append(dict(slug=o['slug'], name=o['name'], x=round(rp.x), y=round(rp.y), rings=rings_of(g, 400), g=g, buildings=st.get('buildings', 0)))
print('oblasts', len(obl), f'{time.time() - t0:.0f}s', flush=True)
def obl_at(x, y):
    pt = shapely.Point(x, y)
    for i, o in enumerate(obl):
        if o['g'].contains(pt): return i
    return -1
raions = []
for r in adm['raions']:
    x, y = P.xy(*r['c']); oi = obl_at(x, y)
    if oi < 0: continue
    rr = []
    for ring in r['rings']:
        q = dp(P.arr(ring), 300)
        if len(q) >= 3 and abs(area(q)) > 2e7: rr.append([[round(a), round(b)] for a, b in q])
    raions.append(dict(name=r['name'], o=oi, x=round(x), y=round(y), rings=rr))
sets = []
KO = {'city': 0, 'town': 1, 'village': 2, 'hamlet': 3, 'isolated_dwelling': 4}
for s in adm['settlements']:
    x, y = P.xy(*s['c']); oi = obl_at(x, y)
    if oi < 0: continue
    sets.append([s['name'], KO[s['kind']], s['pop'], round(x), round(y), oi])
sets.sort(key=lambda s: (s[1], -s[2]))
print('raions', len(raions), 'settlements', len(sets), f'{time.time() - t0:.0f}s', flush=True)

# ---- land cover (500 m) + rivers, lakes, main roads from every bin
LD = 500.0; W, H = int((x1 - x0) / LD) + 1, int((y1 - y0) / LD) + 1
im = Image.new('P', (W, H), LCI['field']); dr = ImageDraw.Draw(im)
px = lambda p: ((p[0] - x0) / LD, (y1 - p[1]) / LD)
AMAP = {('landuse', 'forest'): 'wood', ('natural', 'wood'): 'wood', ('natural', 'scrub'): 'scrub', ('landuse', 'meadow'): 'meadow', ('natural', 'grassland'): 'meadow',
        ('natural', 'wetland'): 'wetland', ('landuse', 'residential'): 'resid', ('landuse', 'industrial'): 'hard', ('landuse', 'commercial'): 'hard',
        ('landuse', 'orchard'): 'orchard', ('landuse', 'vineyard'): 'orchard', ('natural', 'sand'): 'dirt', ('natural', 'beach'): 'dirt', ('landuse', 'quarry'): 'dirt'}
ORDER = ['resid', 'hard', 'dirt', 'meadow', 'wetland', 'orchard', 'scrub', 'wood']
layers = {k: [] for k in ORDER}; water = []; rivers = []; roads = []
RW = {'motorway': 3, 'trunk': 3, 'primary': 2, 'secondary': 1}
files = glob.glob(os.path.join(DU, 'bins', 'b_*.pkl')) + [os.path.join(DU, 'bins', 'big.pkl')]
for fi, f in enumerate(files):
    for kind, oid, t, geo in read_pkl(f):
        if kind == 'a':
            if 'building' in t or 'building:part' in t: continue
            cls = None
            for (k, v), c in AMAP.items():
                if t.get(k) == v: cls = c; break
            wat = t.get('natural') == 'water' or t.get('waterway') == 'riverbank' or t.get('landuse') == 'reservoir'
            if not cls and not wat: continue
            for poly in geo:
                o = poly[0]
                lo, la = o[0::2], o[1::2]
                if (lo.max() - lo.min()) * (la.max() - la.min()) < 2.5e9 * (0.3 if wat else 1): continue      # smaller than ~a few hectares: invisible at 500 m
                ring = P.arr(o[::2 * max(1, len(o) // 4000)] if len(o) > 8000 else o)
                (water if wat else layers[cls]).append([px(p) for p in ring])
        elif kind == 'l':
            ww = t.get('waterway'); hw = t.get('highway')
            if ww in ('river', 'canal'):
                pts = dp(P.arr(geo[0]), 120, closed=False)
                if len(pts) >= 2: rivers.append([pts, t.get('name:uk') or t.get('name', '')])
            elif hw in RW:
                pts = dp(P.arr(geo[0]), 150, closed=False)
                if len(pts) >= 2: roads.append([pts, RW[hw]])
    if fi % 200 == 0: print('bins', fi, len(files), f'{time.time() - t0:.0f}s', flush=True)
for cls in ORDER:
    for r in layers[cls]:
        if len(r) >= 3: dr.polygon(r, fill=LCI[cls])
for r in water:
    if len(r) >= 3: dr.polygon(r, fill=LCI['water'])
for pts, nm_ in rivers: dr.line([px(p) for p in pts], fill=LCI['water'], width=1)
mask = Image.new('L', (W, H), 0); dm = ImageDraw.Draw(mask)
for o in obl:
    for pg in (o['g'].geoms if hasattr(o['g'], 'geoms') else [o['g']]): dm.polygon([px(p) for p in pg.exterior.coords], fill=255)
a = np.array(im); a[np.asarray(mask) == 0] = LCI['outside']
im = Image.fromarray(a, 'P'); im.putpalette(sum([[i * 16, i * 16, i * 16] for i in range(16)], [])); im.save(os.path.join(OUT, 'lc.png'), optimize=True)
print('land cover', W, H, f'{time.time() - t0:.0f}s', flush=True)

# ---- relief 1 km (heights in metres above sea level)
sample = dem_sampler(); DX = 1000.0
nx, ny = int((x1 - x0) / DX) + 1, int((y1 - y0) / DX) + 1
h = grid_heights(P, sample, x0, y0, DX, nx, ny)
open(os.path.join(OUT, 'dem.bin.wasm'), 'wb').write(gzip.compress(np.array([x0, y0, DX, nx, ny, 0, 0, 0], np.float32).tobytes() + np.round(h).astype(np.int16).tobytes(), 9))

# ---- rivers: keep long named ones (joined by name), roads simplified
def flat(pts): return [v for p in pts for v in (round(p[0]), round(p[1]))]
riv = [[flat(pts), n] for pts, n in rivers if LineString(pts).length > 3000]
rd = [[flat(pts), k] for pts, k in roads]
hub = dict(origin=[P.lat0, P.lon0], extent=[x0, y0, x1, y1], lc=dict(file='lc.png', x0=x0, y1=y1, d=LD, w=W, h=H, classes=LC),
           oblasts=[{k: v for k, v in o.items() if k != 'g'} for o in obl], raions=raions, settlements=sets, rivers=riv, roads=rd,
           country=rings_of(country, 500) if country is not None else [])
json.dump(hub, open(os.path.join(OUT, 'hub.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('done', {f: os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT)}, f'{time.time() - t0:.0f}s')
