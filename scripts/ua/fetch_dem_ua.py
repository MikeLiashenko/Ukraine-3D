"""Terrarium z11 tiles (~50 m) for the Ukraine bounding box -> data_ua/dem11 (cached)."""
import os, math, sys, urllib.request, concurrent.futures as cf
OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
Z = 11; N = 2 ** Z
def tx(lon): return int((lon + 180) / 360 * N)
def ty(lat): return int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * N)
need = [(x, y) for x in range(tx(22.0), tx(40.3) + 1) for y in range(ty(52.45), ty(44.3) + 1)]
print('tiles', len(need), flush=True)
def get(t):
    x, y = t; p = os.path.join(OUT, f'{x}_{y}.png')
    if os.path.exists(p) and os.path.getsize(p) > 0: return 0
    for a in range(5):
        try:
            d = urllib.request.urlopen(urllib.request.Request(f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{x}/{y}.png', headers={'User-Agent': 'terrain-fetch/1.0'}), timeout=40).read()
            open(p, 'wb').write(d); return len(d)
        except Exception as e: err = e
    print('fail', t, err, flush=True); return 0
tot = 0
with cf.ThreadPoolExecutor(16) as ex:
    for i, n in enumerate(ex.map(get, need)):
        tot += n
        if i % 1000 == 0: print(i, round(tot / 1e6), 'MB', flush=True)
print('done', round(tot / 1e6), 'MB')
