"""Merge neighbouring 12 km packs (2x2 blocks, at most ~12 MB per file) into bundle files to keep the artifact file count low.

  python ua_bundle.py <slug>     # web_ua/<slug>/p/*.bin.wasm -> web_ua/<slug>/b/*.bin.wasm, region.json packs get file=b/.., at=offset
"""
import os, sys, json, shutil, collections
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
D = os.path.join(ROOT, 'web_ua', sys.argv[1]); RJ = os.path.join(D, 'region.json')
R = json.load(open(RJ, encoding='utf-8'))
if any('at' in p for p in R['packs']): print('already bundled'); sys.exit()
LIM = 12 << 20
groups = collections.defaultdict(list)
for p in R['packs']: groups[(p['ij'][0] // 2, p['ij'][1] // 2)].append(p)
shutil.rmtree(os.path.join(D, 'b'), ignore_errors=True)      # a rebuilt oblast: the old bundles go
os.makedirs(os.path.join(D, 'b'), exist_ok=True)
nb = 0
for (bi, bj), ps in sorted(groups.items()):
    ps.sort(key=lambda p: (p['ij'][1], p['ij'][0]))
    cur, size, part = [], 0, 0
    chunks = []
    for p in ps:
        if cur and size + p['size'] > LIM: chunks.append(cur); cur, size = [], 0
        cur.append(p); size += p['size']
    if cur: chunks.append(cur)
    for ci, ch in enumerate(chunks):
        name = f'b/{bi}_{bj}' + (f'_{ci}' if len(chunks) > 1 else '') + '.bin.wasm'
        with open(os.path.join(D, name), 'wb') as f:
            at = 0
            for p in ch:
                data = open(os.path.join(D, p['file']), 'rb').read(); assert len(data) == p['size'], p['file']
                f.write(data); p['file'] = name; p['at'] = at; at += len(data)
        nb += 1
json.dump(R, open(RJ, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
shutil.rmtree(os.path.join(D, 'p'))
big = max(os.path.getsize(os.path.join(D, 'b', f)) for f in os.listdir(os.path.join(D, 'b')))
print(sys.argv[1], 'packs', len(R['packs']), '-> bundles', nb, 'largest MB', round(big / 1048576, 1))
