"""One oblast of Ukraine -> data for the region 3D viewer (same tile format as Kharkiv, generated in the browser by gen.js).

  python ua_region.py <slug> [--dry]          # slug from oblasts.json (see ua_admin.py)

Output web_ua/<slug>/:
  region.json        meta: origin, tile grid, packs, tiles, raions, hromadas, settlements, quarters, borders
  p/<pi>.bin.wasm    pack of 10x10 tiles (12 km): gzip'ed tile blobs, the pack's overview (ctx), addresses, fine relief (50 m)
  dem.bin.wasm       coarse relief over the oblast (400 m)
  lc.png             land cover (100 m, one class per pixel, palette index)
"""
import os, sys, json, math, gzip, pickle, struct, time, random, glob
import numpy as np
from PIL import Image, ImageDraw
import shapely
from shapely.geometry import Polygon, MultiPolygon, LineString, box
from shapely.ops import unary_union
from concurrent.futures import ProcessPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
DU = os.path.join(ROOT, 'data_ua'); BINS = os.path.join(DU, 'bins'); OUTR = os.path.join(ROOT, 'web_ua')
R = 6378137.0
T = 1200.0; Q = 0.05; PK = 10; MARG = 40.0; BIN = 5
CQ = 0.25         # overview coordinate unit (pack-centred, +-8 km)


# ------------------------------------------------------------------ small geometry helpers (same rules as city_prep.py)
def area(p): return 0.5 * sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1] for i in range(len(p)))
def ccw(p): return p if area(p) > 0 else p[::-1]
def cw(p): return p if area(p) < 0 else p[::-1]
def centroid(poly): return (sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly))
def bbox(pts):
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)
def inside(pt, poly):
    x, y = pt; c = False
    for i in range(len(poly)):
        x1, y1 = poly[i]; x2, y2 = poly[(i + 1) % len(poly)]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1: c = not c
    return c
def dp(pts, eps, closed=True):
    if len(pts) < 4: return pts
    ls = shapely.simplify(LineString(list(pts) + ([pts[0]] if closed else [])), eps, preserve_topology=False)
    out = [tuple(c) for c in ls.coords]
    if closed and len(out) > 1 and out[0] == out[-1]: out = out[:-1]
    return out if len(out) >= (3 if closed else 2) else pts


def read_pkl(path):
    out = []
    if not os.path.exists(path): return out
    with open(path, 'rb') as f:
        while True:
            try: out += pickle.load(f)
            except EOFError: break
    return out


class Proj:
    def __init__(self, lat0, lon0):
        self.lat0, self.lon0 = lat0, lon0; self.K = math.cos(math.radians(lat0))
        self.my0 = math.log(math.tan(math.pi / 4 + math.radians(lat0) / 2))
    def arr(self, a):
        """int32 1e-7 deg [lon, lat, ...] -> list of (x, y)"""
        lon = a[0::2] * 1e-7; lat = a[1::2] * 1e-7
        x = R * self.K * np.radians(lon - self.lon0)
        y = R * self.K * (np.log(np.tan(np.pi / 4 + np.radians(lat) / 2)) - self.my0)
        return list(zip(np.round(x, 2).tolist(), np.round(y, 2).tolist()))
    def xy(self, lat, lon):
        return (R * self.K * math.radians(lon - self.lon0), R * self.K * (math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) - self.my0))
    def inv(self, x, y):
        return (math.degrees(2 * math.atan(math.exp(y / (R * self.K) + self.my0)) - math.pi / 2), self.lon0 + math.degrees(x / (R * self.K)))


def ring_of(a, P):
    pts = P.arr(a)
    if len(pts) > 1 and pts[0] == pts[-1]: pts = pts[:-1]
    return pts


# ------------------------------------------------------------------ OSM records -> features (rules from city_prep.features)
def num(v):
    try: return float(str(v).replace(',', '.').split()[0])
    except (TypeError, ValueError, IndexError): return None
HOUSES = ('house', 'detached', 'semidetached_house', 'terrace')
def floor_h_of(kind):
    if kind in ('apartments', 'dormitory', 'garage', 'garages'): return 2.8
    if kind in HOUSES: return 3.0
    return 3.4
def est_levels(kind, a):
    if kind == 'apartments': return 9 if a > 700 else 5
    if kind in ('garage', 'garages', 'service', 'shed', 'kiosk', 'hut', 'cabin', 'greenhouse', 'toilets', 'transformer_tower', 'barn', 'farm_auxiliary', 'sty', 'stable', 'cowshed'): return 1
    if kind in ('school', 'kindergarten'): return 3 if kind == 'school' else 2
    if kind in HOUSES: return 1 if a < 160 else 2
    if kind in ('church', 'cathedral', 'chapel'): return 2
    if kind == 'yes' and a < 220: return 1
    return 2 if a > 600 else 1
MATERIAL = {'brick': '#9a5a44', 'concrete': '#b9b7b1', 'glass': '#7f97a6', 'block': '#c4bfb4', 'plaster': '#d8cfbd', 'plastered': '#d8cfbd',
            'metal': '#9ea3a6', 'wood': '#8a6a4a', 'cement_block': '#b4b0a8', 'metal_plates': '#9ea3a6', 'steel': '#9ea3a6', 'stone': '#c9c0ad'}
def colour_of(t): return t.get('building:colour') or t.get('colour') or MATERIAL.get(t.get('building:material', ''), '')
def tower_kind(t):
    mm = t.get('man_made'); tt = t.get('tower:type', '')
    if mm not in ('tower', 'chimney', 'water_tower', 'mast'): return None
    return 'chimney' if mm == 'chimney' else 'cooling_tower' if tt == 'cooling' else 'water_tower' if mm == 'water_tower' else 'tv_tower' if tt in ('communication', 'radio', 'transmission') else 'tower'
TOWER_H = {'chimney': 40, 'cooling_tower': 60, 'water_tower': 22, 'tv_tower': 60, 'tower': 15}
WIDTH = {'motorway': 22, 'trunk': 22, 'trunk_link': 7, 'primary': 20, 'primary_link': 7, 'secondary': 14, 'secondary_link': 7, 'motorway_link': 7,
         'tertiary': 10, 'tertiary_link': 6, 'unclassified': 7, 'residential': 6.5, 'living_street': 5, 'service': 4.5, 'road': 6,
         'pedestrian': 5, 'footway': 2.2, 'path': 1.5, 'steps': 2.5, 'track': 3, 'cycleway': 2, 'bridleway': 2}
KMAP = {'motorway': 'primary', 'trunk': 'primary', 'trunk_link': 'primary_link', 'motorway_link': 'primary_link', 'tertiary_link': 'secondary_link',
        'bridleway': 'path', 'road': 'unclassified'}
AREA = {('landuse', 'garages'): 'hard', ('landuse', 'retail'): 'hard', ('landuse', 'commercial'): 'hard', ('landuse', 'industrial'): 'hard',
        ('amenity', 'fuel'): 'hard', ('amenity', 'marketplace'): 'hard', ('landuse', 'railway'): 'hard', ('landuse', 'construction'): 'dirt',
        ('leisure', 'garden'): 'garden', ('natural', 'wood'): 'wood', ('landuse', 'forest'): 'wood', ('natural', 'scrub'): 'scrub',
        ('landuse', 'grass'): 'lawn', ('landuse', 'village_green'): 'lawn', ('natural', 'grassland'): 'meadow', ('landuse', 'meadow'): 'meadow',
        ('leisure', 'park'): 'park', ('landuse', 'recreation_ground'): 'park', ('area:highway', 'traffic_island'): 'island',
        ('landuse', 'allotments'): 'garden', ('landuse', 'cemetery'): 'cemetery', ('amenity', 'grave_yard'): 'cemetery',
        ('landuse', 'farmland'): 'field', ('landuse', 'orchard'): 'orchard', ('landuse', 'vineyard'): 'orchard', ('landuse', 'residential'): 'resid',
        ('leisure', 'stadium'): 'hard', ('amenity', 'school'): 'school', ('amenity', 'kindergarten'): 'school',
        ('aeroway', 'aerodrome'): 'field', ('natural', 'wetland'): 'meadow', ('natural', 'sand'): 'dirt', ('natural', 'beach'): 'dirt',
        ('landuse', 'brownfield'): 'dirt', ('landuse', 'quarry'): 'dirt', ('landuse', 'landfill'): 'dirt', ('landuse', 'farmyard'): 'hard',
        ('natural', 'heath'): 'meadow', ('landuse', 'plant_nursery'): 'garden', ('natural', 'bare_rock'): 'dirt'}
WATER_LINE = {'river': 14.0, 'canal': 8.0, 'stream': 3.0, 'ditch': 1.6, 'drain': 1.6}


def is_water(t): return t.get('natural') == 'water' or t.get('waterway') in ('riverbank', 'dock') or t.get('water') in ('pond', 'lake', 'river', 'reservoir', 'oxbow', 'canal', 'basin') or t.get('landuse') in ('reservoir', 'basin')
def above(t): return not str(t.get('layer', '0')).strip().startswith('-') and t.get('location') not in ('underground', 'indoor') and t.get('indoor') in (None, 'no')


def features(recs, P, rnd_seed=1):
    F = {k: [] for k in ('buildings', 'roads', 'tram', 'paved', 'water', 'pitches', 'playgrounds', 'areas', 'fences', 'osm_trees', 'tree_rows', 'waterlines')}
    B, parts = [], []
    def rec(t, oid, outer, holes, kind, h, zb, lv, lv_tag, fh, parent=None, rh=0.0):
        pt = parent or {}
        return dict(id=oid, kind=kind or 'yes', outer=ccw(outer), holes=[cw(x) for x in holes if len(x) >= 3], h=round(h, 1), zb=round(zb, 1),
                    rh=round(rh, 1), levels=lv, levels_tag=lv_tag, floor_h=fh,
                    street=t.get('addr:street', '') or t.get('addr:place', '') or pt.get('street', ''), name=t.get('addr:housenumber', '') or pt.get('name', ''),
                    roof_shape=t.get('roof:shape', ''), colour=colour_of(t) or pt.get('colour', ''),
                    roof_colour=t.get('roof:colour', '') or pt.get('roof_colour', ''), area=abs(area(outer)), pid=pt.get('id'))
    for kind_, oid, t, geo in recs:
        if kind_ == 'a':
            oid = oid[1] if oid[0] == 'w' else -oid[1]          # relations negative
            polys = [[ring_of(r, P) for r in poly] for poly in geo]
            bld = 'building' in t and t.get('building') not in ('roof', 'no') and 'building:part' not in t
            part = t.get('building:part') not in (None, 'no')
            for poly in polys:
                outer, holes = poly[0], [h for h in poly[1:] if len(h) >= 3]
                if len(outer) < 3: continue
                if bld:
                    a = abs(area(outer))
                    if a < 4: continue
                    kind = t.get('building'); tk = tower_kind(t)
                    if tk and (num(t.get('height')) or 0) > 12:
                        B.append(rec(t, oid, outer, [], tk, num(t.get('height')), 0.0, 1, None, 3.0)); continue
                    lv = num(t.get('building:levels')); lv_tag = lv
                    if not lv: lv = est_levels(kind, a)
                    lv = max(1.0, min(lv, 60.0)); fh = floor_h_of(kind)
                    h = num(t.get('height'))
                    if h is None: h = lv * fh + (1.2 if lv >= 3 else 0.4)
                    B.append(rec(t, oid, outer, holes, kind, max(2.2, min(h, 300.0)), 0.0, lv, lv_tag, fh))
                elif part:
                    if abs(area(outer)) >= 2: parts.append((t, oid, outer, holes))
                elif t.get('man_made') in ('tower', 'chimney', 'water_tower', 'mast') and 'building' not in t:
                    tk = tower_kind(t); h = num(t.get('height')) or TOWER_H[tk]
                    if abs(area(outer)) >= 1: B.append(rec(t, oid, outer, [], tk, h, 0.0, 1, None, 3.0))
                else:
                    d = dict(outer=ccw(outer), holes=[cw(h) for h in holes], id=oid)
                    if is_water(t): F['water'].append(d)
                    elif above(t) and (t.get('amenity') == 'parking' and t.get('parking') not in ('underground', 'multi-storey') or t.get('highway') == 'pedestrian' or t.get('place') == 'square'):
                        F['paved'].append(dict(d, sq=int(t.get('amenity') != 'parking')))
                    elif above(t) and t.get('leisure') == 'pitch': F['pitches'].append(dict(d, sport=t.get('sport', ''), surface=t.get('surface', '')))
                    elif above(t) and t.get('leisure') == 'playground': F['playgrounds'].append(d)
                    for (k_, v_), ak in AREA.items():
                        if t.get(k_) == v_: F['areas'].append(dict(outer=d['outer'], holes=d['holes'], kind=ak)); break
        elif kind_ == 'l':
            pts = P.arr(geo[0])
            if len(pts) < 2: continue
            hw = t.get('highway')
            if hw in WIDTH and t.get('area') != 'yes':
                wd = WIDTH[hw]
                if 'lanes' in t and hw in ('primary', 'secondary', 'tertiary', 'residential', 'trunk', 'motorway'):
                    v = num(t['lanes'])
                    if v: wd = max(wd * 0.6, v * 3.4 + 1)
                if 'width' in t:
                    v = num(t['width'])
                    if v: wd = max(1.0, min(40.0, v))
                if hw == 'service' and t.get('service') in ('parking_aisle', 'driveway'): wd = 4.0
                F['roads'].append(dict(pts=pts, width=wd, kind=KMAP.get(hw, hw), surface=t.get('surface', 'asphalt' if hw not in ('path', 'track') else 'ground'),
                                       oneway=t.get('oneway') == 'yes', lanes=t.get('lanes'), crossing=t.get('footway') == 'crossing',
                                       bridge=t.get('bridge'), tunnel=t.get('tunnel') or (t.get('covered') == 'yes' and 'tunnel'), id=oid))
            rw = t.get('railway')
            if rw in ('tram', 'rail', 'light_rail', 'narrow_gauge') and t.get('tunnel') not in ('yes', 'building_passage'):
                F['tram'].append(dict(pts=pts, rail=rw != 'tram'))
            if t.get('barrier') in ('fence', 'wall'): F['fences'].append(dict(pts=pts, kind=t['barrier']))
            if t.get('natural') == 'tree_row': F['tree_rows'].append(pts)
            ww = t.get('waterway')
            if ww in WATER_LINE and t.get('tunnel') in (None, 'no') and t.get('intermittent') != 'yes':
                F['waterlines'].append(dict(pts=pts, w=WATER_LINE[ww], kind=ww, name=t.get('name:uk') or t.get('name', '')))
        else:
            x, y = P.arr(geo[0])[0]
            if t.get('natural') == 'tree':
                F['osm_trees'].append((x, y, num(t.get('height')) or random.Random(oid).uniform(9, 15)))
    # building parts (Simple 3D Buildings)
    grid = {}
    for bi, b in enumerate(B):
        x0, y0, x1, y1 = bbox(b['outer'])
        for gi in range(int(x0 // 200), int(x1 // 200) + 1):
            for gj in range(int(y0 // 200), int(y1 // 200) + 1): grid.setdefault((gi, gj), []).append(bi)
    cover, kids = {}, {}
    for pi, (t, oid, outer, holes) in enumerate(parts):
        c = centroid(outer); best = None
        for bi in grid.get((int(c[0] // 200), int(c[1] // 200)), ()):
            b = B[bi]
            if inside(c, b['outer']) and (best is None or b['area'] < B[best]['area']): best = bi
        if best is not None: cover[best] = cover.get(best, 0) + abs(area(outer)); kids.setdefault(best, []).append(pi)
    drop = {bi for bi, a in cover.items() if a >= 0.4 * B[bi]['area']}
    owner_of = {pi: bi for bi, l in kids.items() for pi in l}
    for pi, (t, oid, outer, holes) in enumerate(parts):
        bi = owner_of.get(pi); par = B[bi] if bi is not None else None
        kept = bi is not None and bi not in drop
        kind = (par or {}).get('kind') or (t.get('building:part') if t.get('building:part') not in ('yes', None) else 'yes')
        fh = floor_h_of(kind)
        lv = num(t.get('building:levels')); minlv = num(t.get('building:min_level')) or 0.0
        h = num(t.get('height')); zb = num(t.get('min_height'))
        if zb is None: zb = minlv * fh
        if h is None: h = lv * fh + (0.6 if lv and lv >= 3 else 0.2) if lv else (par['h'] if par else zb + 3.0)
        rh = num(t.get('roof:height')) or (num(t.get('roof:levels')) or 0) * fh
        if kept:
            if h <= par['h'] + 1.0: continue
            zb = max(zb, par['h'] - 0.05)
        if h <= zb + 0.4 or h > 300: continue
        nl = max(1.0, (lv - minlv) if lv else round((h - zb) / fh))
        B.append(rec(t, oid, outer, holes, kind, h, zb, nl, lv, fh, parent=par, rh=rh))
    F['buildings'] = [b for bi, b in enumerate(B) if bi not in drop]
    return F


# ------------------------------------------------------------------ per tile packing
class Pack:
    def __init__(self): self.blobs, self.header, self.size = [], {}, 0
    def add(self, name, arr):
        arr = np.ascontiguousarray(arr); pad = (-self.size) % 8
        if pad: self.blobs.append(b'\0' * pad); self.size += pad
        self.header[name] = dict(offset=self.size, count=int(arr.size), dtype=str(arr.dtype))
        b = arr.tobytes(); self.blobs.append(b); self.size += len(b)
    def bytes(self):
        hj = json.dumps(self.header, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        hj += b' ' * ((-len(hj) - 4) % 8)
        return gzip.compress(struct.pack('<I', len(hj)) + hj + b''.join(self.blobs), 9)


def i16(a): return np.clip(np.array(a, np.int64), -32767, 32767).astype(np.int16)
def pack_rings(P, name, polys, ox, oy, q=Q):
    v, rs, ps = [], [], []
    for poly in polys:
        ps.append(len(rs))
        for ring in [poly['outer']] + list(poly.get('holes', [])):
            rs.append(len(v) // 2)
            for p in ring: v += [round((p[0] - ox) / q), round((p[1] - oy) / q)]
    ps.append(len(rs)); rs.append(len(v) // 2)
    P.add(name + '_v', i16(v)); P.add(name + '_r', np.array(rs, np.uint32)); P.add(name + '_p', np.array(ps, np.uint32))
def pack_lines(P, name, lines, ox, oy):
    v, ls = [], []
    for pts in lines:
        ls.append(len(v) // 2)
        for p in pts: v += [round((p[0] - ox) / Q), round((p[1] - oy) / Q)]
    ls.append(len(v) // 2)
    P.add(name + '_v', i16(v)); P.add(name + '_l', np.array(ls, np.uint32))


def build_tile(job):
    k, bb, S = job
    x0, y0, x1, y1 = bb; ox, oy = (x0 + x1) / 2, (y0 + y1) / 2
    P = Pack(); H = P.header; Bs = S['buildings']
    pack_rings(P, 'b', Bs, ox, oy)
    H['b'] = dict(id=[b['id'] for b in Bs], kind=[b['kind'] for b in Bs], h=[b['h'] for b in Bs], lv=[b['levels'] for b in Bs],
                  lt=[b['levels_tag'] for b in Bs], fh=[b['floor_h'] for b in Bs], st=[b['street'] for b in Bs], num=[b['name'] for b in Bs],
                  rs=[b['roof_shape'] for b in Bs], col=[b['colour'] for b in Bs], rcol=[b['roof_colour'] for b in Bs],
                  zb=[b.get('zb', 0) for b in Bs], rh=[b.get('rh', 0) for b in Bs])
    pack_rings(P, 'o', [dict(outer=b['outer']) for b in S['obstacles']], ox, oy)
    Rd = S['roads']
    pack_lines(P, 'r', [r['pts'] for r in Rd], ox, oy)
    H['r'] = dict(kind=[r['kind'] for r in Rd], w=[r['width'] for r in Rd], surf=[r['surface'] for r in Rd], ow=[int(r['oneway']) for r in Rd],
                  lanes=[r['lanes'] for r in Rd], cr=[int(bool(r['crossing'])) for r in Rd], br=[r['bridge'] or '' for r in Rd],
                  tu=[r['tunnel'] or '' for r in Rd], id=[r['id'] for r in Rd])
    pack_lines(P, 't', [t['pts'] for t in S['tram']], ox, oy); H['t'] = dict(rail=[int(t['rail']) for t in S['tram']])
    pack_lines(P, 'f', [f['pts'] for f in S['fences']], ox, oy); H['f'] = dict(kind=[f['kind'] for f in S['fences']])
    for nm in ('paved', 'water', 'pitches', 'playgrounds', 'areas'): pack_rings(P, nm, S[nm], ox, oy)
    H['paved'] = dict(sq=[p.get('sq', 0) for p in S['paved']])
    H['pitches'] = dict(sport=[p['sport'] for p in S['pitches']], surf=[p['surface'] for p in S['pitches']], id=[p['id'] for p in S['pitches']])
    H['playgrounds'] = dict(id=[p['id'] for p in S['playgrounds']])
    H['areas'] = dict(kind=[a['kind'] for a in S['areas']])
    # trees: only mapped ones and tree rows; the rest is grown in the browser from land use (gen.js treeField)
    tr = list(S['trees_osm'])
    for r in S['rows']:
        for p0, p1 in zip(r, r[1:]):
            L = math.dist(p0, p1); n = max(1, int(L / 7))
            for j in range(n):
                x, y = p0[0] + (p1[0] - p0[0]) * (j + 0.5) / n, p0[1] + (p1[1] - p0[1]) * (j + 0.5) / n
                if x0 <= x < x1 and y0 <= y < y1: tr.append((x, y, 9 + (hash((round(x), round(y))) % 600) / 100))
    P.add('tree_v', i16([v for t in tr for v in (round((t[0] - ox) / Q), round((t[1] - oy) / Q))]))
    P.add('tree_h', np.array([min(255, round(t[2] * 10)) for t in tr], np.uint8))
    P.add('tree_s', np.array([(hash((round(t[0] * 7), round(t[1] * 3))) & 0xFFFF) for t in tr], np.uint16))
    P.add('cells', i16([round((x0 - ox) / Q), round((y0 - oy) / Q), round((x1 - ox) / Q), round((y1 - oy) / Q)]))
    H['off'] = [ox, oy]; H['bbox'] = [x0, y0, x1, y1]; H['k'] = k; H['bid0'] = S['bid0']; H['Q'] = Q; H['grow'] = 1
    return k, P.bytes()


def obb_rect(o):
    best = None
    for a_ in range(len(o)):
        p0, p1 = o[a_], o[(a_ + 1) % len(o)]; L = math.dist(p0, p1)
        if L < 0.5: continue
        ax = ((p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L)
        us = [p[0] * ax[0] + p[1] * ax[1] for p in o]; vs = [-p[0] * ax[1] + p[1] * ax[0] for p in o]
        ar = (max(us) - min(us)) * (max(vs) - min(vs))
        if best is None or ar < best[0]: best = (ar, ax, min(us), max(us), min(vs), max(vs))
    if not best: return o
    _, ax, u0, u1, v0, v1 = best
    return [(ax[0] * u - ax[1] * v, ax[1] * u + ax[0] * v) for u, v in ((u0, v0), (u1, v0), (u1, v1), (u0, v1))]


def build_ctx(pc, items, roads_far, water_far):
    """overview of one pack: simplified footprints (b_t = global tile index), main roads, water; coordinates around the pack centre"""
    ox, oy = pc; P = Pack()
    bv, br, bp, bh, blv, bk, bs, btile, bz, bc, brc = [], [], [], [], [], [], [], [], [], [], []
    cols, cidx, kinds, kidx = [''], {'': 0}, [], {}
    for k, b in items:
        o = b['outer']
        if b['area'] < 300 and len(o) > 4: o = obb_rect(o)
        elif len(o) > 8: o = dp(o, 0.8)
        if len(o) < 3: continue
        o = ccw(o)
        bp.append(len(br)); br.append(len(bv) // 2)
        for p in o: bv += [round((p[0] - ox) / CQ), round((p[1] - oy) / CQ)]
        bh.append(min(65535, round(b['h'] * 10))); blv.append(min(255, round(b['levels'] * 2)))
        if b['kind'] not in kidx: kidx[b['kind']] = len(kinds); kinds.append(b['kind'])
        bk.append(kidx[b['kind']]); bs.append(b['id'] & 0xFFFFFFFF); btile.append(k); bz.append(min(65535, round(b.get('zb', 0) * 10)))
        for key_, arr_ in (('colour', bc), ('roof_colour', brc)):
            cv = (b.get(key_) or '').strip().lower()
            if cv not in cidx: cidx[cv] = len(cols); cols.append(cv)
            arr_.append(cidx[cv])
    bp.append(len(br)); br.append(len(bv) // 2)
    rv, rl, rw, rt = [], [], [], []
    for k, rd in roads_far:
        pts = dp(rd['pts'], 1.0, closed=False)
        rl.append(len(rv) // 2)
        for p in pts: rv += [round((p[0] - ox) / CQ), round((p[1] - oy) / CQ)]
        rw.append(min(255, round(rd['width'] * 4))); rt.append(k)
    rl.append(len(rv) // 2)
    wv, wr, wp, wt = [], [], [], []
    for k, w in water_far:
        wp.append(len(wr))
        for ring in [w['outer']] + w['holes']:
            ring = dp(ring, 2.0)
            if len(ring) < 3: continue
            wr.append(len(wv) // 2)
            for p in ring: wv += [round((p[0] - ox) / CQ), round((p[1] - oy) / CQ)]
        wt.append(k)
    wp.append(len(wr)); wr.append(len(wv) // 2)
    P.add('b_v', i16(bv)); P.add('b_r', np.array(br, np.uint32)); P.add('b_p', np.array(bp, np.uint32))
    P.add('b_h', np.array(bh, np.uint16)); P.add('b_lv', np.array(blv, np.uint8)); P.add('b_k', np.array(bk, np.uint16))
    P.add('b_s', np.array(bs, np.uint32)); P.add('b_t', np.array(btile, np.int32).astype(np.uint32))
    P.add('b_z', np.array(bz, np.uint16)); P.add('b_c', np.array(bc, np.uint16)); P.add('b_rc', np.array(brc, np.uint16))
    P.add('r_v', i16(rv)); P.add('r_l', np.array(rl, np.uint32)); P.add('r_w', np.array(rw, np.uint8)); P.add('r_t', np.array(rt, np.int32).astype(np.uint32))
    P.add('w_v', i16(wv)); P.add('w_r', np.array(wr, np.uint32)); P.add('w_p', np.array(wp, np.uint32)); P.add('w_t', np.array(wt, np.int32).astype(np.uint32))
    P.add('t_v', i16([])); P.add('t_h', np.array([], np.uint8)); P.add('t_t', np.array([], np.uint32))
    P.header['kinds'] = kinds; P.header['cols'] = cols; P.header['Q'] = CQ; P.header['pc'] = [ox, oy]
    return P.bytes(), len(bh)


# ------------------------------------------------------------------ relief
DEMZ = 11
def dem_sampler():
    cache = {}
    N = 2 ** DEMZ
    def tile(tx, ty):
        a = cache.get((tx, ty))
        if a is None:
            p = os.path.join(DU, 'dem11', f'{tx}_{ty}.png')
            if os.path.exists(p) and os.path.getsize(p) > 0:
                im = np.asarray(Image.open(p).convert('RGB')).astype(np.float32)
                a = im[..., 0] * 256 + im[..., 1] + im[..., 2] / 256 - 32768
                a[a < -100] = -100          # no-data / deep sea: still below sea level
            else: a = np.zeros((256, 256), np.float32)
            cache[(tx, ty)] = a
        return a
    def sample(lat, lon):
        """lat, lon arrays (same shape) -> heights, bilinear in tile pixel space"""
        fx = (lon + 180) / 360 * N * 256 - 0.5
        fy = (1 - np.log(np.tan(np.radians(lat)) + 1 / np.cos(np.radians(lat))) / np.pi) / 2 * N * 256 - 0.5
        i0 = np.floor(fx).astype(np.int64); j0 = np.floor(fy).astype(np.int64); u = fx - i0; v = fy - j0
        out = np.zeros(lat.shape, np.float32)
        def px(i, j):
            r = np.zeros(i.shape, np.float32)
            tx, ty = i // 256, j // 256
            for key in set(zip(tx.ravel().tolist(), ty.ravel().tolist())):
                m = (tx == key[0]) & (ty == key[1])
                r[m] = tile(*key)[j[m] - key[1] * 256, i[m] - key[0] * 256]
            return r
        a, b, c, d = px(i0, j0), px(i0 + 1, j0), px(i0, j0 + 1), px(i0 + 1, j0 + 1)
        return (a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v)
    return sample


def grid_heights(Pj, sample, x0, y0, dx, nx, ny, raw=False):
    """heights on a grid (rows = y upward); the sea surface is flat at 0 unless raw"""
    xs = x0 + np.arange(nx) * dx; ys = y0 + np.arange(ny) * dx
    lon = Pj.lon0 + np.degrees(xs / (R * Pj.K))
    lat = np.degrees(2 * np.arctan(np.exp(ys / (R * Pj.K) + Pj.my0)) - np.pi / 2)
    LON, LAT = np.meshgrid(lon, lat)
    h = sample(LAT, LON)
    return h if raw else np.maximum(h, 0)


# ------------------------------------------------------------------ land cover (100 m), palette index per pixel
LC = ['field', 'meadow', 'wood', 'scrub', 'water', 'resid', 'hard', 'park', 'garden', 'cemetery', 'dirt', 'orchard', 'wetland', 'outside']
LCI = {k: i for i, k in enumerate(LC)}
LC_ORDER = [('resid', 'resid'), ('school', 'resid'), ('hard', 'hard'), ('dirt', 'dirt'), ('field', 'field'), ('meadow', 'meadow'), ('lawn', 'meadow'),
            ('park', 'park'), ('garden', 'garden'), ('orchard', 'orchard'), ('scrub', 'scrub'), ('cemetery', 'cemetery'), ('wood', 'wood')]


def main():
    slug = sys.argv[1]; dry = '--dry' in sys.argv
    t0 = time.time()
    OB = json.load(open(os.path.join(DU, 'oblasts.json'), encoding='utf-8'))
    ob = next(o for o in OB if o['slug'] == slug)
    adm = pickle.load(open(os.path.join(DU, 'admin_sel.pkl'), 'rb'))
    lat0, lon0 = ob['origin']; Pj = Proj(lat0, lon0)
    opoly = unary_union([Polygon(Pj.arr(p[0]), [Pj.arr(h) for h in p[1:] if len(h) >= 8]).buffer(0) for p in adm['oblast'][slug]])
    ox0, oy0, ox1, oy1 = opoly.bounds
    print(slug, ob['name'], 'bounds km', round((ox1 - ox0) / 1000), round((oy1 - oy0) / 1000), flush=True)
    # bins over the oblast's lon/lat box (+1 bin)
    (la0, lo0), (la1, lo1) = Pj.inv(ox0, oy0), Pj.inv(ox1, oy1)
    keys = [(i, j) for i in range(int(lo0 * BIN) - 1, int(lo1 * BIN) + 2) for j in range(int(la0 * BIN) - 1, int(la1 * BIN) + 2)]
    recs = []
    for i, j in keys: recs += read_pkl(os.path.join(BINS, f'b_{i}_{j}.pkl'))
    big = read_pkl(os.path.join(BINS, 'big.pkl'))
    print('records', len(recs), 'big', len(big), f'{time.time() - t0:.0f}s', flush=True)
    # keep records whose first point is inside the oblast (+300 m so border villages stay whole); big ones by bbox overlap
    obuf = opoly.buffer(300)
    def first(r): g = r[3][0][0] if r[0] == 'a' else r[3][0]; return g[0] * 1e-7, g[1] * 1e-7
    fl = np.array([first(r) for r in recs]) if recs else np.zeros((0, 2))
    xy = np.array([Pj.xy(la, lo) for lo, la in fl]) if len(fl) else np.zeros((0, 2))
    ins = shapely.contains_xy(obuf, xy[:, 0], xy[:, 1]) if len(xy) else []
    recs = [r for r, m in zip(recs, ins) if m]
    for r in big:
        g = r[3][0][0] if r[0] == 'a' else r[3][0]
        lo, la = g[0::2] * 1e-7, g[1::2] * 1e-7
        if lo.max() < lo0 - 0.05 or lo.min() > lo1 + 0.05 or la.max() < la0 - 0.05 or la.min() > la1 + 0.05: continue
        recs.append(r)
    print('in oblast', len(recs), f'{time.time() - t0:.0f}s', flush=True)
    F = features(recs, Pj); del recs
    print({k: len(v) for k, v in F.items()}, f'{time.time() - t0:.0f}s', flush=True)
    # buildings outside the oblast (the 300 m margin) are dropped by centroid; lines / areas stay (clipped to tiles)
    F['buildings'] = [b for b in F['buildings'] if opoly.contains(shapely.Point(centroid(b['outer'])))]
    # river / stream lines -> thin water polygons
    for wl in F['waterlines']:
        try: g = LineString(wl['pts']).buffer(wl['w'] / 2, cap_style='flat', quad_segs=2)
        except Exception: continue
        for pg in (g.geoms if isinstance(g, MultiPolygon) else [g]):
            if pg.is_empty or pg.area < 4: continue
            F['water'].append(dict(outer=ccw([tuple(c) for c in pg.exterior.coords][:-1]), holes=[cw([tuple(c) for c in i.coords][:-1]) for i in pg.interiors], id=0, line=1))

    # ---- tile grid aligned to 1.2 km over the oblast; active tiles: buildings and their 1-tile ring, inside the oblast (+1 km)
    gx0, gy0 = math.floor(ox0 / T) * T, math.floor(oy0 / T) * T
    gnx, gny = int(math.ceil((ox1 - gx0) / T)), int(math.ceil((oy1 - gy0) / T))
    occ = np.zeros((gny, gnx), bool)
    for b in F['buildings']:
        c = centroid(b['outer']); i, j = int((c[0] - gx0) // T), int((c[1] - gy0) // T)
        if 0 <= i < gnx and 0 <= j < gny: occ[j, i] = True
    act = occ.copy()
    act[1:, :] |= occ[:-1, :]; act[:-1, :] |= occ[1:, :]; act[:, 1:] |= occ[:, :-1]; act[:, :-1] |= occ[:, 1:]
    act[1:, 1:] |= occ[:-1, :-1]; act[:-1, :-1] |= occ[1:, 1:]; act[1:, :-1] |= occ[:-1, 1:]; act[:-1, 1:] |= occ[1:, :-1]
    ob1 = opoly.buffer(1000); shapely.prepare(ob1)
    tiles = []
    for j in range(gny):
        for i in range(gnx):
            if act[j, i] and ob1.intersects(box(gx0 + i * T, gy0 + j * T, gx0 + (i + 1) * T, gy0 + (j + 1) * T)): tiles.append((i, j))
    # order tiles by pack so each pack's tiles are contiguous
    tiles.sort(key=lambda t: ((t[1] // PK) * 10000 + t[0] // PK, t[1], t[0]))
    tindex = {t: k for k, t in enumerate(tiles)}
    print('grid', gnx, gny, 'tiles', len(tiles), 'of', gnx * gny, f'{time.time() - t0:.0f}s', flush=True)
    if dry: return
    per = [dict(buildings=[], roads=[], tram=[], fences=[], paved=[], water=[], pitches=[], playgrounds=[], areas=[], trees_osm=[], rows=[],
                obstacles=[]) for _ in tiles]
    tb = lambda k: (gx0 + tiles[k][0] * T, gy0 + tiles[k][1] * T, gx0 + (tiles[k][0] + 1) * T, gy0 + (tiles[k][1] + 1) * T)
    def tile_of(x, y): return tindex.get((int((x - gx0) // T), int((y - gy0) // T)), -1)
    def tiles_near(bb, m):
        for i in range(int((bb[0] - m - gx0) // T), int((bb[2] + m - gx0) // T) + 1):
            for j in range(int((bb[1] - m - gy0) // T), int((bb[3] + m - gy0) // T) + 1):
                k = tindex.get((i, j))
                if k is not None: yield k
    for b in F['buildings']:
        o = tile_of(*centroid(b['outer']))
        for k in tiles_near(bbox(b['outer']), MARG):
            (per[k]['buildings'] if o == k else per[k]['obstacles']).append(b)
    for kind in ('paved', 'pitches', 'playgrounds'):
        for a in F[kind]:
            o = tile_of(*centroid(a['outer']))
            if o >= 0: per[o][kind].append(a)
    # areas and water: clipped into every tile they cross (shapely)
    for kind in ('water', 'areas'):
        for a in F[kind]:
            bb = bbox(a['outer']); ks = list(tiles_near(bb, 0))
            if not ks: continue
            try: pg = Polygon(a['outer'], a['holes']).buffer(0)
            except Exception: continue
            if pg.is_empty: continue
            whole = None
            for k in ks:
                x0, y0, x1, y1 = tb(k)
                if bb[0] >= x0 - 2 and bb[1] >= y0 - 2 and bb[2] <= x1 + 2 and bb[3] <= y1 + 2:
                    per[k][kind].append(a); continue
                c = shapely.clip_by_rect(pg, x0 - 2, y0 - 2, x1 + 2, y1 + 2)
                for g in (c.geoms if hasattr(c, 'geoms') else [c]):
                    if g.geom_type != 'Polygon' or g.area < 1: continue
                    o = [tuple(p) for p in g.exterior.coords][:-1]
                    hs = [[tuple(p) for p in i.coords][:-1] for i in g.interiors]
                    per[k][kind].append(dict(a, outer=ccw(o), holes=[cw(h) for h in hs if len(h) >= 3]))
    def split_line(pts, step=10.0):
        dense = [tuple(pts[0])]
        for a, b in zip(pts, pts[1:]):
            L = math.dist(a, b); n = max(1, int(L // step))
            for kk in range(1, n + 1): dense.append((a[0] + (b[0] - a[0]) * kk / n, a[1] + (b[1] - a[1]) * kk / n))
        runs = []
        for a, b in zip(dense, dense[1:]):
            o = tile_of((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
            if runs and runs[-1][0] == o: runs[-1][1].append(b)
            else: runs.append((o, [a, b]))
        orig = {tuple(p) for p in pts}
        return [(o, [r[0]] + [p for p in r[1:-1] if tuple(p) in orig] + [r[-1]]) for o, r in runs]
    far_roads = []      # main roads for the overview (also across inactive countryside)
    for rd in F['roads']:
        for o, pts in split_line(rd['pts']):
            if o >= 0: per[o]['roads'].append(dict(rd, pts=pts))
            if rd['kind'] in ('primary', 'secondary', 'tertiary', 'unclassified', 'primary_link') and not rd.get('tunnel') and len(pts) >= 2:
                far_roads.append((o, dict(rd, pts=pts)))
    for tr in F['tram']:
        for o, pts in split_line(tr['pts']):
            if o >= 0: per[o]['tram'].append(dict(tr, pts=pts))
    for f in F['fences']:
        for o, pts in split_line(f['pts']):
            if o >= 0: per[o]['fences'].append(dict(f, pts=pts))
    for t in F['osm_trees']:
        o = tile_of(t[0], t[1])
        if o >= 0: per[o]['trees_osm'].append(t)
    for r in F['tree_rows']:
        for k in tiles_near(bbox(r), 0): per[k]['rows'].append(r)
    print('assigned', f'{time.time() - t0:.0f}s', flush=True)

    out = os.path.join(OUTR, slug); os.makedirs(os.path.join(out, 'p'), exist_ok=True)
    for f in glob.glob(os.path.join(out, 'p', '*')): os.remove(f)
    bid = 0; jobs = []
    for k in range(len(tiles)):
        per[k]['bid0'] = bid; bid += len(per[k]['buildings'])
        jobs.append((k, tb(k), per[k]))
    blobs = {}
    with ProcessPoolExecutor(16) as ex:
        for k, b in ex.map(build_tile, jobs, chunksize=16): blobs[k] = b
    print('tiles built', len(blobs), round(sum(map(len, blobs.values())) / 1e6, 1), 'MB', f'{time.time() - t0:.0f}s', flush=True)

    # ---- relief: coarse 400 m over the oblast box (+3 km), fine 50 m per pack (+1 cell)
    sample = dem_sampler()
    DX = 400.0; cx0, cy0 = math.floor((ox0 - 3000) / DX) * DX, math.floor((oy0 - 3000) / DX) * DX
    cnx, cny = int((ox1 + 3000 - cx0) / DX) + 2, int((oy1 + 3000 - cy0) / DX) + 2
    hc = grid_heights(Pj, sample, cx0, cy0, DX, cnx, cny)
    ref = float(grid_heights(Pj, sample, 0, 0, 1, 1, 1)[0, 0])
    edge = np.concatenate([hc[0], hc[-1], hc[:, 0], hc[:, -1]]); base = float(edge.mean())
    xs_ = cx0 + np.arange(cnx) * DX; ys_ = cy0 + np.arange(cny) * DX         # taper the outer 3 km to the edge mean (the flat frame beyond)
    dd = np.minimum(np.minimum(xs_ - cx0, cx0 + (cnx - 1) * DX - xs_)[None, :], np.minimum(ys_ - cy0, cy0 + (cny - 1) * DX - ys_)[:, None])
    w = np.clip(dd / 3000, 0, 1); w = w * w * (3 - 2 * w); hc = base + (hc - base) * w
    hc -= ref
    open(os.path.join(out, 'dem.bin.wasm'), 'wb').write(gzip.compress(np.array([cx0, cy0, DX, cnx, cny, ref, base - ref, 0], np.float32).tobytes()
                                                                       + np.round(hc).astype(np.int16).tobytes(), 9))
    FD = 50.0; FN = int(PK * T / FD) + 1

    # ---- packs: tiles + overview + addresses + fine relief
    packs = {}
    for k, (i, j) in enumerate(tiles): packs.setdefault((i // PK, j // PK), []).append(k)
    pmeta, tmeta = [], [None] * len(tiles)
    far_by_pack = {}
    for o, rd in far_roads:
        c = rd['pts'][len(rd['pts']) // 2]; pk_ = (int((c[0] - gx0) // T) // PK, int((c[1] - gy0) // T) // PK)
        far_by_pack.setdefault(pk_, []).append((o if o >= 0 else len(tiles), rd))
    for pk_ in far_by_pack:
        packs.setdefault(pk_, [])
    nb_ctx = 0
    for pi, (key, ks) in enumerate(sorted(packs.items(), key=lambda kv: (kv[0][1], kv[0][0]))):
        px0, py0 = gx0 + key[0] * PK * T, gy0 + key[1] * PK * T
        pc = (px0 + PK * T / 2, py0 + PK * T / 2)
        parts, off = [], 0
        for k in ks:
            b = blobs[k]; tmeta[k] = dict(ij=list(tiles[k]), bid0=per[k]['bid0'], n=len(per[k]['buildings']), p=pi, o=off, l=len(b))
            parts.append(b); off += len(b)
        items = [(k, b) for k in ks for b in per[k]['buildings']]
        water_far = [(k, w) for k in ks for w in per[k]['water'] if not w.get('line') and abs(area(w['outer'])) > 400]
        cb, nb = build_ctx(pc, items, far_by_pack.get(key, []), water_far); nb_ctx += nb
        parts.append(cb); ctx = [off, len(cb)]; off += len(cb)
        addr, seen = [], set()
        for k in ks:
            for li, b in enumerate(per[k]['buildings']):
                if not b['name']: continue
                if b.get('pid'):
                    if b['pid'] in seen: continue
                    seen.add(b['pid'])
                c = centroid(b['outer']); addr.append([b['street'], b['name'], round(c[0]), round(c[1]), k, li])
        ab = gzip.compress(json.dumps(addr, ensure_ascii=False, separators=(',', ':')).encode('utf-8'), 9)
        parts.append(ab); ad = [off, len(ab)]; off += len(ab)
        hf = grid_heights(Pj, sample, px0, py0, FD, FN, FN) - ref
        db = gzip.compress(np.array([px0, py0, FD, FN, FN, 0, 0, 0], np.float32).tobytes() + np.round(hf * 10).astype(np.int16).tobytes(), 9)
        parts.append(db); dm = [off, len(db)]; off += len(db)
        fn = f'p/{pi}.bin.wasm'
        open(os.path.join(out, fn), 'wb').write(b''.join(parts))
        pmeta.append(dict(ij=list(key), file=fn, size=off, ctx=ctx, addr=ad, dem=dm, n=len(items)))
    print('packs', len(pmeta), 'max MB', round(max(p['size'] for p in pmeta) / 1e6, 2), 'total MB', round(sum(p['size'] for p in pmeta) / 1e6, 1),
          f'{time.time() - t0:.0f}s', flush=True)

    # ---- land cover 100 m
    LD = 100.0; lnx, lny = int((ox1 - ox0) / LD) + 1, int((oy1 - oy0) / LD) + 1
    im = Image.new('P', (lnx, lny), LCI['field']); dr = ImageDraw.Draw(im)
    px = lambda p: ((p[0] - ox0) / LD, (oy1 - p[1]) / LD)
    for kind, lc in LC_ORDER:
        for a in F['areas']:
            if a['kind'] == kind and len(a['outer']) >= 3:
                dr.polygon([px(p) for p in a['outer']], fill=LCI[lc])
    for w in F['water']:
        o = w['outer']
        if len(o) < 3: continue
        per = sum(math.dist(o[i], o[i - 1]) for i in range(len(o)))
        if 2 * abs(area(o)) / max(per, 1) < 40: continue      # streams, ditches, small rivers (mean width 2A/P < 40 m): at 100 m pixels they'd paint wide blue bands
        dr.polygon([px(p) for p in o], fill=LCI['water'])
    # outside the oblast
    mask = Image.new('L', (lnx, lny), 0); dm_ = ImageDraw.Draw(mask)
    for g in (opoly.geoms if hasattr(opoly, 'geoms') else [opoly]):
        dm_.polygon([px(p) for p in g.exterior.coords], fill=255)
    a = np.array(im); a[np.asarray(mask) == 0] = LCI['outside']
    # the sea (no polygons in OSM, only a coastline; the oblast border runs out into territorial waters): wherever the relief is below sea level
    hl = grid_heights(Pj, sample, ox0, oy1 - (lny - 1) * LD, LD, lnx, lny, raw=True)[::-1]
    a[hl < 0.02] = LCI['water']          # the DEM is exactly 0 over the sea (no depths)
    im = Image.fromarray(a, 'P'); im.putpalette(sum([[i * 16, i * 16, i * 16] for i in range(16)], []))
    im.save(os.path.join(out, 'lc.png'), optimize=True)

    # ---- names: raions, hromadas, settlements, quarters
    def to_rings(polys, tol):
        rr = []
        for poly in polys:
            r = Pj.arr(np.array(poly, np.int32))
            if len(r) > 2 and r[0] == r[-1]: r = r[:-1]
            r = dp(r, tol)
            if len(r) >= 3 and abs(area(r)) > 1e4: rr.append([[round(p[0]), round(p[1])] for p in r])
        return rr
    def sel(items):
        out_ = []
        for it in items:
            x, y = Pj.xy(*it['c'])
            if opoly.contains(shapely.Point(x, y)): out_.append(dict(it, x=round(x), y=round(y)))
        return out_
    raions = [dict(name=r['name'], x=r['x'], y=r['y'], rings=to_rings(r['rings'], 60)) for r in sel(adm['raions'])]
    hroms = [dict(name=r['name'], x=r['x'], y=r['y'], rings=to_rings(r['rings'], 40)) for r in sel(adm['hromadas'])]
    sets = []
    for s in sel(adm['settlements']):
        d = dict(name=s['name'], kind=s['kind'], pop=s.get('pop', 0), x=s['x'], y=s['y'])
        if s.get('rings'): d['rings'] = to_rings(s['rings'], 15)
        sets.append(d)
    quarters = [dict(name=q['name'], kind=q['kind'], x=q['x'], y=q['y']) for q in sel(adm['quarters'])]
    border = [[[round(p[0]), round(p[1])] for p in dp([tuple(c) for c in g.exterior.coords][:-1], 50)] for g in (opoly.geoms if hasattr(opoly, 'geoms') else [opoly])]
    meta = dict(slug=slug, name=ob['name'], origin=[lat0, lon0], T=T, Q=Q, PK=PK, grid=[gx0, gy0, gnx, gny], bounds=[ox0, oy0, ox1, oy1],
                tiles=tmeta, packs=pmeta, dem=dict(file='dem.bin.wasm'), lc=dict(file='lc.png', x0=ox0, y1=oy1, d=LD, w=lnx, h=lny, classes=LC),
                border=border, raions=raions, hromadas=hroms, settlements=sets, quarters=quarters,
                stats=dict(buildings=bid, tiles=len(tiles), ctx=nb_ctx))
    json.dump(meta, open(os.path.join(out, 'region.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    tot = sum(os.path.getsize(f) for f in glob.glob(os.path.join(out, '**', '*'), recursive=True) if os.path.isfile(f))
    print('done', slug, 'buildings', bid, 'tiles', len(tiles), 'packs', len(pmeta), 'files', len(pmeta) + 3, 'total MB', round(tot / 1e6, 1), f'{time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
