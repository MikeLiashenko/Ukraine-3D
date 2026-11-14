"""The coastline (natural=coastline ways) from the Geofabrik extract -> data_ua/coast.pkl: list of int32 [lon, lat, ...] arrays (1e-7 deg).

  python ua_coast.py ../../data_ua/ukraine-latest.osm.pbf
"""
import os, sys, time, pickle
import numpy as np
import osmium
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
t0 = time.time(); out = []
fp = osmium.FileProcessor(sys.argv[1], osmium.osm.NODE | osmium.osm.WAY).with_locations('flex_mem').with_filter(osmium.filter.TagFilter(('natural', 'coastline')))
for w in fp:
    if not w.is_way(): continue
    pts = []
    for n in w.nodes:
        if n.location.valid(): pts += [round(n.location.lon * 1e7), round(n.location.lat * 1e7)]
    if len(pts) >= 4: out.append(np.array(pts, np.int32))
pickle.dump(out, open(os.path.join(ROOT, 'data_ua', 'coast.pkl'), 'wb'), protocol=5)
print('coastline ways', len(out), 'points', sum(len(a) // 2 for a in out), f'{time.time() - t0:.0f}s')
