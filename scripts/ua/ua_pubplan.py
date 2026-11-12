"""Publish batches per oblast: [[published path, source path relative to C:/Saltivka], ...] in <= 60 MB / <= 250-file groups.

  python ua_pubplan.py            # -> data_ua/pubplan.json + a summary
"""
import os, json
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
W = os.path.join(ROOT, 'web_ua')
SHARED = ['common.json', 'common.bin.wasm', 'leaves.png', 'gen.js']
OB = json.load(open(os.path.join(ROOT, 'data_ua', 'oblasts.json'), encoding='utf-8'))
plan, tot = {}, 0
for o in OB:
    s = o['slug']; d = os.path.join(W, s)
    if not os.path.exists(os.path.join(d, 'region.json')): print('missing', s); continue
    files = [(f, f'web_ua/{f}') for f in SHARED] + [(f, f'web_ua/{s}/{f}') for f in ('region.json', 'dem.bin.wasm', 'lc.png')]
    files += [(f'b/{f}', f'web_ua/{s}/b/{f}') for f in sorted(os.listdir(os.path.join(d, 'b')))]
    batches, cur, size = [], [], 0
    for pub, src in files:
        n = os.path.getsize(os.path.join(ROOT, src))
        if cur and (size + n > 60e6 or len(cur) >= 250): batches.append(cur); cur, size = [], 0
        cur.append([pub, src]); size += n
    if cur: batches.append(cur)
    mb = sum(os.path.getsize(os.path.join(ROOT, src)) for _, src in files) / 1e6; tot += mb
    plan[s] = dict(name=o['name'], batches=batches, mb=round(mb, 1), files=len(files))
    print(f"{s:18} {len(files):4} files {mb:7.1f} MB  {len(batches)} publish(es)")
json.dump(plan, open(os.path.join(ROOT, 'data_ua', 'pubplan.json'), 'w', encoding='utf-8'), ensure_ascii=False)
print('total MB', round(tot), 'publishes', sum(len(p['batches']) for p in plan.values()))
