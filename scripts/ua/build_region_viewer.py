"""Assemble the oblast viewer: viewer_region_tpl.html (+ @@KEEP a-b@@ line ranges of viewer_city_tpl.html) + shared blocks of index_v4.html.

  python build_region_viewer.py <out_dir> [hub_url]
"""
import sys, re, time, os
HERE = os.path.dirname(os.path.abspath(__file__)); S = os.path.dirname(HERE)
out_dir = sys.argv[1]; hub = sys.argv[2] if len(sys.argv) > 2 else '../hub/'
city = open(os.path.join(S, 'viewer_city_tpl.html'), encoding='utf-8').read().split('\n')
old = open(os.path.join(S, 'index_v4.html'), encoding='utf-8').read().split('\n')
L = lambda a, b: '\n'.join(old[a - 1:b])
t = open(os.path.join(HERE, 'viewer_region_tpl.html'), encoding='utf-8').read()
t = re.sub(r'@@KEEP (\d+)-(\d+)@@', lambda m: '\n'.join(city[int(m.group(1)) - 1:int(m.group(2))]), t)
head = L(1, 130).replace('<title>Салтівка · 603</title>', '<title>Україна 3D</title>')
blocks = dict(HEAD=head, SRGB=L(342, 385), SURF=L(308, 329).rstrip()[:-1], GND=L(398, 455), PATCH=L(458, 466), WALL=L(479, 579), WIN=L(591, 609),
              RESTFRAG=L(621, 631), CAR=L(744, 753), SUN=L(811, 832))
for k, v in blocks.items():
    t = t.replace('@@%s@@' % k, v)
t = t.replace('@@VER@@', time.strftime('%y%m%d%H%M')).replace('@@HUB@@', hub)
assert '@@' not in t, t[t.index('@@') - 200:t.index('@@') + 100]
a = "  scene.fog.color.setRGB(0.78 - warm * 0.05, 0.82 - warm * 0.12, 0.86 - warm * 0.22);"
assert a in t; t = t.replace(a, a + '\n  fogFromSky();')
a = "  refreshList(); invalidate();\n}\nfunction status()"
assert a in t
t = t.replace(a, "  refreshList(); invalidate(); layoutLeft();\n}\nfunction layoutLeft() {\n  if (innerWidth > 640) $('districts').style.top = `${Math.round($('brand').getBoundingClientRect().bottom + 10)}px`; else $('districts').style.top = '';\n}\naddEventListener('resize', layoutLeft);\nfunction status()")
a = "  $('cOsm').textContent = `way ${b.id}`;"
assert a in t; t = t.replace(a, "  $('cOsm').textContent = b.id < 0 ? `relation ${-b.id}` : `way ${b.id}`;")
# detailed tiles' ground: the grass base takes the oblast land cover (fields, forest, scrub...) instead of uniform lawn green
a = "    sh.uniforms.uGS = { value: new THREE.Vector2(gs[0], gs[1]) };"
assert t.count(a) == 1; t = t.replace(a, a + "\n    sh.uniforms.uLC = { value: lcTex }; sh.uniforms.uLCr = lcrU; sh.uniforms.uLCs = lcsU;")
a = "uniform sampler2D uMask; uniform vec2 uG0; uniform vec2 uGS; varying vec3 vGP;\\n' + SRGB)"
assert t.count(a) == 1; t = t.replace(a, a[:-1] + " + LC_GLSL)")
a = "      vec3 c = mix(mix(gr, dt, dA), hd, hA);"
assert t.count(a) == 1
t = t.replace(a, """      vec4 lcb = lcBlend(p); vec3 lb = toLin(lcb.rgb); float lw = lcb.a;      // (mapped forest polygons sit in the lawn channel too: lawns don't override the land cover here)
      gr = mix(gr, lb * (0.9 + 0.2 * vnoise(p * 5.0) * mid + 0.16 * fine * (hash12(floor(p * 28.0)) - 0.5)), lw);
""" + a)
a = "'diffuseColor.rgb = mix(c, toLin(vec3(0.40, 0.45, 0.25)) * (0.92 + 0.12 * mk.g), smoothstep(0.6, 3.5, px) * (1.0 - 0.6 * hA));'"
assert t.count(a) == 1
t = t.replace(a, "'diffuseColor.rgb = mix(c, mix(toLin(vec3(0.40, 0.45, 0.25)), lb, lw) * (0.92 + 0.12 * mk.g), smoothstep(0.6, 3.5, px) * (1.0 - 0.6 * hA));'")
os.makedirs(out_dir, exist_ok=True)
open(os.path.join(out_dir, 'index.html'), 'w', encoding='utf-8', newline='\n').write(t)
print('index.html', len(t))
