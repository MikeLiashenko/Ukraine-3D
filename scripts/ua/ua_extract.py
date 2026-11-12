"""All of Ukraine from the Geofabrik extract: one pass, every feature the 3D viewer uses, sorted into 0.2 degree bins.

  python ua_extract.py ../../data_ua/ukraine-latest.osm.pbf ../../data_ua/bins

Output (pickle streams, coordinates int32 in 1e-7 degrees, [lon, lat] interleaved):
  bins/b_<ix>_<iy>.pkl   features whose first point falls in the bin (ix = floor(lon*5), iy = floor(lat*5))
  bins/big.pkl           features wider than one bin (big forests, reservoirs, long rivers)
  bins/admin.pkl         administrative areas (levels 4..10), place areas and place nodes
Record: (kind, id, tags, rings) where kind is 'a' (area: rings = [outer, inner...] per polygon, list of polygons),
'l' (line: rings = [pts]), 'n' (node: rings = [[lon, lat]]).
"""
import os, sys, time, pickle
import numpy as np
import osmium

SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
BIN = 5          # bins per degree

B_KEYS = ('building', 'building:part', 'building:levels', 'building:min_level', 'height', 'min_height', 'roof:shape', 'roof:height',
          'roof:levels', 'building:colour', 'colour', 'building:material', 'roof:colour', 'addr:street', 'addr:housenumber', 'addr:place',
          'man_made', 'tower:type', 'name', 'name:uk', 'amenity', 'shop', 'tourism', 'historic')
A_KEYS = ('natural', 'water', 'waterway', 'landuse', 'leisure', 'amenity', 'parking', 'place', 'highway', 'area', 'layer', 'location',
          'indoor', 'sport', 'surface', 'aeroway', 'area:highway', 'name', 'name:uk', 'building', 'building:part', 'man_made', 'tower:type', 'height')
L_KEYS = ('highway', 'lanes', 'width', 'service', 'surface', 'oneway', 'footway', 'bridge', 'tunnel', 'covered', 'area', 'name', 'name:uk',
          'railway', 'barrier', 'natural', 'waterway', 'layer', 'ref', 'intermittent')
ADM_KEYS = ('boundary', 'admin_level', 'name', 'name:uk', 'name:en', 'place', 'population', 'koatuu', 'katotth', 'official_status')

AREA_TEST = (('landuse', None), ('natural', ('water', 'wood', 'scrub', 'grassland', 'wetland', 'sand', 'beach', 'bare_rock', 'heath')),
             ('waterway', ('riverbank', 'dock')), ('water', None), ('leisure', ('park', 'garden', 'pitch', 'playground', 'stadium', 'track')),
             ('amenity', ('parking', 'school', 'kindergarten', 'fuel', 'marketplace', 'grave_yard', 'university', 'college', 'hospital')),
             ('highway', ('pedestrian',)), ('place', ('square',)), ('aeroway', ('aerodrome', 'apron', 'runway', 'taxiway')), ('area:highway', None),
             ('man_made', ('tower', 'chimney', 'water_tower', 'mast', 'bridge', 'pier')))
LINE_HW = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'pedestrian',
           'footway', 'path', 'steps', 'track', 'cycleway', 'bridleway', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link',
           'tertiary_link', 'road'}


def keep(tags, keys): return {k: tags[k] for k in keys if k in tags}


def is_area(t):
    if 'building' in t and t['building'] not in ('no', 'roof'): return True
    if 'building:part' in t and t['building:part'] != 'no': return True
    for k, vs in AREA_TEST:
        v = t.get(k)
        if v is not None and (vs is None or v in vs): return True
    return False


class Sink:
    def __init__(self):
        self.buf = {}; self.n = 0; self.files = {}
    def put(self, key, rec):
        self.buf.setdefault(key, []).append(rec); self.n = max(self.n, 0) + 1
        if self.n >= 400000: self.flush()
    def flush(self):
        for key, lst in self.buf.items():
            with open(os.path.join(OUT, key + '.pkl'), 'ab') as f: pickle.dump(lst, f, protocol=5)
        self.buf = {}; self.n = 0


sink = Sink()
for f in os.listdir(OUT):
    if f.endswith('.pkl'): os.remove(os.path.join(OUT, f))


def place(rec, rings):
    pts = rings[0][0] if rec[0] == 'a' else rings[0]
    lo, la = pts[0::2], pts[1::2]
    if (lo.max() - lo.min()) > 1e7 / BIN or (la.max() - la.min()) > 1e7 / BIN: sink.put('big', rec); return
    sink.put('b_%d_%d' % (int(pts[0] // (1e7 / BIN)), int(pts[1] // (1e7 / BIN))), rec)


def ring_arr(r):
    a = np.fromiter((v for n in r for v in (n.location.x, n.location.y)), np.int32)
    return a


t0 = time.time(); cnt = {}
fp = osmium.FileProcessor(SRC).with_locations('flex_mem').with_areas()
for o in fp:
    t = o.tags
    if o.is_area():
        if not len(t): continue
        td = dict(t)
        adm = td.get('boundary') == 'administrative' or ('place' in td and td.get('place') != 'square')
        if not adm and not is_area(td): continue
        try:
            polys = []
            for outer in o.outer_rings():
                rr = [ring_arr(outer)] + [ring_arr(inner) for inner in o.inner_rings(outer)]
                polys.append(rr)
        except osmium.InvalidLocationError:
            continue
        if not polys: continue
        oid = o.orig_id(); kind = 'w' if o.from_way() else 'r'
        if adm:
            sink.put('admin', ('a', (kind, oid), keep(td, ADM_KEYS), polys)); cnt['adm'] = cnt.get('adm', 0) + 1
            if not is_area(td): continue
        rec = ('a', (kind, oid), keep(td, B_KEYS if ('building' in td or 'building:part' in td) else A_KEYS), polys)
        place(rec, polys); cnt['area'] = cnt.get('area', 0) + 1
    elif o.is_way():
        if not len(t): continue
        hw = t.get('highway'); rw = t.get('railway'); br = t.get('barrier'); nat = t.get('natural'); ww = t.get('waterway')
        if not ((hw in LINE_HW) or rw in ('rail', 'tram', 'light_rail', 'narrow_gauge', 'subway') or br in ('fence', 'wall')
                or nat == 'tree_row' or ww in ('river', 'stream', 'canal', 'ditch', 'drain')
                or t.get('man_made') == 'bridge' or t.get('power') == 'line'): continue
        if t.get('area') == 'yes' and hw != 'pedestrian': continue
        try: pts = np.fromiter((v for n in o.nodes for v in (n.location.x, n.location.y)), np.int32)
        except osmium.InvalidLocationError: continue
        if len(pts) < 4: continue
        rec = ('l', o.id, keep(dict(t), L_KEYS + ('power',)), [pts])
        place(rec, [pts]); cnt['line'] = cnt.get('line', 0) + 1
    elif o.is_node():
        if not len(t): continue
        if 'place' in t and 'name' in t:
            sink.put('admin', ('n', o.id, keep(dict(t), ADM_KEYS), [np.array([o.location.x, o.location.y], np.int32)])); cnt['place'] = cnt.get('place', 0) + 1
        nat = t.get('natural'); mm = t.get('man_made')
        if nat == 'tree' or mm in ('tower', 'mast', 'chimney', 'water_tower'):
            pts = np.array([o.location.x, o.location.y], np.int32)
            place(('n', o.id, keep(dict(t), ('natural', 'height', 'man_made', 'tower:type', 'name')), [pts]), [pts]); cnt['node'] = cnt.get('node', 0) + 1
    if sink.n == 0 and cnt:
        print(cnt, f'{time.time() - t0:.0f}s', flush=True); sink.n = -1
sink.flush()
print('done', cnt, f'{time.time() - t0:.0f}s', flush=True)
