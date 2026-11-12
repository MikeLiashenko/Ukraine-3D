"""Assemble the hub page: hub_tpl.html + shared head of index_v4.html + oblast page URLs (data_ua/urls.json)."""
import os, sys, json, time
HERE = os.path.dirname(os.path.abspath(__file__)); S = os.path.dirname(HERE); ROOT = os.path.dirname(S)
old = open(os.path.join(S, 'index_v4.html'), encoding='utf-8').read().split('\n')
head = '\n'.join(old[:130]).replace('<title>Салтівка · 603</title>', '<title>Україна 3D</title>')
t = open(os.path.join(HERE, 'hub_tpl.html'), encoding='utf-8').read()
up = os.path.join(ROOT, 'data_ua', 'urls.json')
urls = json.load(open(up, encoding='utf-8')) if os.path.exists(up) else {}
t = t.replace('@@HEAD@@', head).replace('@@URLS@@', json.dumps(urls)).replace('@@VER@@', time.strftime('%y%m%d%H%M'))
assert '@@' not in t
open(os.path.join(ROOT, 'web_ua', 'hub', 'index.html'), 'w', encoding='utf-8', newline='\n').write(t)
print('hub index.html', len(t), 'urls', len(urls))
