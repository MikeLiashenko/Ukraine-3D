import sys
ROOT = sys.argv[1]
e = open(ROOT + '/vendor_dl/earcut_body.js', encoding='utf-8').read()
g = open(ROOT + '/scripts/gen_src.js', encoding='utf-8').read()
hdr = '// earcut 2.2.4 (c) Mapbox, ISC License - https://github.com/mapbox/earcut\n'
src = hdr + 'const earcut = (() => {\n' + e + '\nreturn earcut;\n})();\n' + g
open(ROOT + '/web/gen.js', 'w', encoding='utf-8', newline='\n').write(src)
print('gen.js', len(src))
