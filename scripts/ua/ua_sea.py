"""Paint the sea into an already built oblast's land cover (lc.png): wherever the DEM is 0 m.

  python ua_sea.py <slug> [...]
"""
import os, sys, json
import numpy as np
from PIL import Image
from ua_region import Proj, dem_sampler, grid_heights, LCI
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sample = dem_sampler()
for s in sys.argv[1:]:
    D = os.path.join(ROOT, 'web_ua', s); R = json.load(open(os.path.join(D, 'region.json'), encoding='utf-8'))
    Pj = Proj(*R['origin']); L = R['lc']
    im = Image.open(os.path.join(D, L['file'])); a = np.array(im); pal = im.getpalette()
    h, w = a.shape
    hl = grid_heights(Pj, sample, L['x0'], L['y1'] - (h - 1) * L['d'], L['d'], w, h, raw=True)[::-1]
    before = int((a == LCI['water']).sum()); a[hl < 0.02] = LCI['water']
    out = Image.fromarray(a, 'P'); out.putpalette(pal); out.save(os.path.join(D, L['file']), optimize=True)
    print(s, 'water px', before, '->', int((a == LCI['water']).sum()), 'of', a.size)
