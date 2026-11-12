"""Administrative structure of Ukraine from bins/admin.pkl -> data_ua/oblasts.json + data_ua/admin_sel.pkl

oblasts.json: [{slug, name, origin [lat, lon], bbox [lon0, lat0, lon1, lat1], pop}]
admin_sel.pkl: {oblast: {slug: polys}, raions: [...], hromadas: [...], settlements: [...], quarters: [...], country: polys}
  polys = list of [outer, inner...] int32 arrays (1e-7 deg, lon/lat interleaved); items carry c = (lat, lon) label point and rings (outer arrays)
"""
import os, sys, json, pickle, collections, re
import numpy as np
import shapely
from shapely.geometry import Polygon, Point
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
DU = os.path.join(ROOT, 'data_ua')
recs = []
with open(os.path.join(DU, 'bins', 'admin.pkl'), 'rb') as f:
    while True:
        try: recs += pickle.load(f)
        except EOFError: break
print('admin records', len(recs))

def nm(t): return (t.get('name:uk') or t.get('name') or '').strip()
def geom(polys):
    out = []
    for poly in polys:
        o = poly[0].reshape(-1, 2) * 1e-7
        if len(o) < 4: continue
        hs = [h.reshape(-1, 2) * 1e-7 for h in poly[1:] if len(h) >= 8]
        try: g = Polygon(o, hs).buffer(0)
        except Exception: continue
        if not g.is_empty: out.append(g)
    return unary_union(out) if out else None

areas = [r for r in recs if r[0] == 'a']; nodes = [r for r in recs if r[0] == 'n']
lv = collections.Counter(r[2].get('admin_level') for r in areas if r[2].get('boundary') == 'administrative')
print('admin levels', sorted(lv.items(), key=lambda kv: str(kv[0])))
for L in ('2', '4', '5', '6', '7', '8', '9', '10'):
    ex = [nm(r[2]) for r in areas if r[2].get('boundary') == 'administrative' and r[2].get('admin_level') == L][:8]
    print(' ', L, ex)

country = None
for r in areas:
    t = r[2]
    if t.get('admin_level') == '2' and (t.get('name:en') == 'Ukraine' or nm(t) == 'Україна'):
        country = geom(r[3]); cpolys = r[3]; break
print('country', country is not None, country.area if country else 0)

TR = dict(zip('абвгґдеєжзиіїйклмнопрстуфхцчшщьюя', ['a', 'b', 'v', 'h', 'g', 'd', 'e', 'ie', 'zh', 'z', 'y', 'i', 'i', 'i', 'k', 'l', 'm', 'n', 'o', 'p', 'r', 's', 't', 'u', 'f', 'kh', 'ts', 'ch', 'sh', 'shch', '', 'iu', 'ia']))
def slug(s):
    s = s.lower().replace('область', '').replace('автономна республіка', '').replace('місто', '').strip()
    return re.sub(r'[^a-z0-9]+', '-', ''.join(TR.get(c, c) for c in s)).strip('-')

obl = []
for r in areas:
    t = r[2]
    if t.get('boundary') != 'administrative' or t.get('admin_level') != '4': continue
    g = geom(r[3])
    if g is None: continue
    rp = g.representative_point()
    if country is not None and not country.contains(rp): continue
    n_ = nm(t)
    if not n_ or n_ == 'Республіка Крим' or any(o['name'] == n_ for o in obl): continue      # unnamed pieces, the occupiers' duplicate of Crimea
    obl.append(dict(name=n_, g=g, polys=r[3], en=t.get('name:en', '')))
obl.sort(key=lambda o: o['name'])
print('oblasts', len(obl), [o['name'] for o in obl])

def items(level=None, places=None):
    out = []
    for r in areas:
        t = r[2]
        if level and not (t.get('boundary') == 'administrative' and t.get('admin_level') == level): continue
        g = geom(r[3])
        if g is None: continue
        rp = g.representative_point()
        out.append(dict(name=nm(t), c=(rp.y, rp.x), rings=[p[0] for p in r[3]], g=g, tags=t))
    return out
raions = items('6'); hroms = items('7')
print('raions', len(raions), 'hromadas', len(hroms))

# settlements: place nodes; boundary = a place / admin area with the same name containing the node (smallest)
KINDS = ('city', 'town', 'village', 'hamlet', 'isolated_dwelling')
QK = ('suburb', 'quarter', 'neighbourhood', 'borough')
bnd = collections.defaultdict(list)
for r in areas:
    t = r[2]; n_ = nm(t)
    if not n_: continue
    if t.get('place') in KINDS or (t.get('boundary') == 'administrative' and t.get('admin_level') in ('8', '9')):
        bnd[n_.lower()].append(r)
sets, quarters = [], []
gcache = {}
def sgeom(r):
    k = id(r)
    if k not in gcache: gcache[k] = geom(r[3])
    return gcache[k]
for r in nodes:
    t = r[2]; pk = t.get('place'); n_ = nm(t)
    if not n_: continue
    lon, lat = r[3][0][0] * 1e-7, r[3][0][1] * 1e-7
    if country is not None and not country.contains(Point(lon, lat)): continue
    if pk in KINDS:
        try: pop = int(re.sub(r'[^\d]', '', t.get('population', '')) or 0)
        except ValueError: pop = 0
        best = None
        for b in bnd.get(n_.lower(), []):
            g = sgeom(b)
            if g is not None and g.contains(Point(lon, lat)) and g.area < 0.6 and (best is None or g.area < sgeom(best).area): best = b
        sets.append(dict(name=n_, kind=pk, pop=pop, c=(lat, lon), rings=[p[0] for p in best[3]] if best else None))
    elif pk in QK:
        quarters.append(dict(name=n_, kind=pk, c=(lat, lon)))
print('settlements', len(sets), collections.Counter(s['kind'] for s in sets), 'with boundary', sum(1 for s in sets if s['rings']), 'quarters', len(quarters))

OB, sel = [], dict(oblast={}, raions=[], hromadas=[], settlements=[], quarters=[], country=cpolys if country is not None else None)
used = set()
for o in obl:
    s = slug(o['name']) or slug(o['en'])
    while s in used: s += '-2'
    used.add(s)
    lon0, lat0, lon1, lat1 = o['g'].bounds
    pop = sum(x['pop'] for x in sets if o['g'].contains(Point(x['c'][1], x['c'][0])))
    OB.append(dict(slug=s, name=o['name'], origin=[round((lat0 + lat1) / 2, 5), round((lon0 + lon1) / 2, 5)], bbox=[lon0, lat0, lon1, lat1], pop=pop, en=o['en']))
    sel['oblast'][s] = o['polys']
for k, src in (('raions', raions), ('hromadas', hroms)):
    sel[k] = [dict(name=x['name'], c=x['c'], rings=x['rings']) for x in src]
sel['settlements'] = sets; sel['quarters'] = quarters
json.dump(OB, open(os.path.join(DU, 'oblasts.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
pickle.dump(sel, open(os.path.join(DU, 'admin_sel.pkl'), 'wb'), protocol=5)
for o in OB: print(o['slug'], o['name'], o['pop'])
