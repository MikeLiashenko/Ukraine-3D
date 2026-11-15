"""Detailed 3D models of the WarAlarm targets for the follow view (Blender, headless), exported as GLB.

  blender -b -P build_models.py -- <out_dir> [preview_dir] [name,name,...]

Every model is built from lofted cross-sections and NACA wing sections in metres at real proportions.
Local frame while building: x right, f forward (nose), z up; Blender gets (x, -f, z), so the glTF / three.js
model has its nose along +Z and up along +Y. Conventions the viewer relies on:
  objects named prop*   spin about their own Z (the flight axis): a pusher propeller
  objects named propv*  spin about their own Y (vertical): quadcopter rotors
  material named glow   engine exhaust, made emissive in the viewer
"""
import bpy, bmesh, math, os, sys

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
PREV = argv[1] if len(argv) > 1 and argv[1] != '-' else None
ONLY = argv[2].split(',') if len(argv) > 2 else None
os.makedirs(OUT, exist_ok=True)
D = math.radians


def srgb(h):
    c = [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]


MATS = {}


def M(name, hexc, rough=0.55, metal=0.0, emit=None):
    if name in MATS: return MATS[name]
    m = bpy.data.materials.new(name)
    try: m.use_nodes = True
    except Exception: pass
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*srgb(hexc), 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if emit is not None:
        b.inputs['Emission Color'].default_value = (*srgb(emit), 1)
        b.inputs['Emission Strength'].default_value = 6.0
    MATS[name] = m
    return m


def obj(name, verts, faces, mat, origin=(0, 0, 0), sharp=38, smooth=True):
    ox, of, oz = origin
    me = bpy.data.meshes.new(name)
    me.from_pydata([(x - ox, -(f - of), z - oz) for (x, f, z) in verts], [], faces)
    me.validate(); me.update()
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me); bm.free()
    me.materials.append(mat)
    for p in me.polygons: p.use_smooth = smooth
    if smooth and sharp: me.set_sharp_from_angle(angle=D(sharp))
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
    ob.location = (ox, -of, oz)
    return ob


# ---- cross-sections: sec(axial, half-width, top, bottom, centre u, centre v, superellipse exponent)
def sec(a, w, ht=None, hb=None, cx=0.0, cz=0.0, n=2.0):
    ht = w if ht is None else ht
    return (a, w, ht, hb if hb is not None else ht, cx, cz, n)


def ring(s, N, poly):
    a, w, ht, hb, cx, cz, n = s
    pts = []
    for i in range(N):
        if poly: u, v = poly[i]
        else:
            t = 2 * math.pi * i / N; c, sn = math.cos(t), math.sin(t); e = 2.0 / n
            u, v = math.copysign(abs(c) ** e, c), math.copysign(abs(sn) ** e, sn)
        pts.append((cx + w * u, cz + (ht if v > 0 else hb) * v))
    return pts


def to3(ax, a, u, v):
    return (u, a, v) if ax == 'f' else (u, v, a) if ax == 'z' else (a, u, v)


def loft(name, mat, secs, N=28, poly=None, ax='f', cap0=True, cap1=True, sharp=38, xf=None, collect=None):
    """A body of revolution-ish shape through cross-sections; w=0 makes a pointed tip."""
    if poly: N = len(poly)
    verts, faces, rings = [], [], []
    for s in secs:
        if s[1] <= 0: verts.append(to3(ax, s[0], s[4], s[5])); rings.append([len(verts) - 1]); continue
        r0 = len(verts)
        for (u, v) in ring(s, N, poly): verts.append(to3(ax, s[0], u, v))
        rings.append(list(range(r0, r0 + N)))
    for A, B in zip(rings, rings[1:]):
        if len(A) == 1 and len(B) == 1: continue
        if len(A) == 1: faces += [(A[0], B[i], B[(i + 1) % N]) for i in range(N)]
        elif len(B) == 1: faces += [(A[i], B[0], A[(i + 1) % N]) for i in range(N)]
        else: faces += [(A[i], A[(i + 1) % N], B[(i + 1) % N], B[i]) for i in range(N)]
    if cap0 and len(rings[0]) > 1: faces.append(tuple(rings[0]))
    if cap1 and len(rings[-1]) > 1: faces.append(tuple(reversed(rings[-1])))
    if xf: verts = [xf(p) for p in verts]
    o = obj(name, verts, faces, mat, sharp=sharp)
    return o


def naca(q, t):
    return max(0.0, 5 * t * (0.2969 * math.sqrt(q) - 0.1260 * q - 0.3516 * q * q + 0.2843 * q ** 3 - 0.1036 * q ** 4))


def add(a, b, k=1.0): return (a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k)


def wing(name, mat, st, U=(1, 0, 0), F=(0, 1, 0), Nn=(0, 0, 1), O=(0, 0, 0), K=12, mirror=False, sharp=34, xf=None, origin=(0, 0, 0)):
    """A lifting surface through airfoil stations (span s, leading edge along F, chord, thickness ratio, twist°)."""
    qs = [(1 - math.cos(math.pi * i / K)) / 2 for i in range(K + 1)]
    loop = [(q, 1) for q in qs] + [(q, -1) for q in reversed(qs[1:-1])]
    verts, faces = [], []

    def shell(sx):
        rings = []
        for (s, le, c, tr, tw) in st:
            r0 = len(verts); ca, sa = math.cos(D(tw)), math.sin(D(tw))
            for (q, sg) in loop:
                dx, dy = q * c - 0.25 * c, sg * naca(q, tr) * c
                rx, ry = dx * ca - dy * sa + 0.25 * c, dx * sa + dy * ca
                p = add(add(add(O, U, s), F, le - rx), Nn, ry)
                p = (p[0] * sx, p[1], p[2])
                verts.append(xf(p) if xf else p)
            rings.append(r0)
        L = len(loop)
        for A, B in zip(rings, rings[1:]):
            faces.extend((A + i, A + (i + 1) % L, B + (i + 1) % L, B + i) for i in range(L))
        faces.append(tuple(rings[0] + i for i in range(L)))
        faces.append(tuple(rings[-1] + i for i in reversed(range(L))))
    shell(1)
    if mirror: shell(-1)
    return obj(name, verts, faces, mat, origin=origin, sharp=sharp)


def rotz(a):          # yaw: turns +f toward +x
    c, s = math.cos(D(a)), math.sin(D(a))
    return lambda p: (p[0] * c + p[1] * s, -p[0] * s + p[1] * c, p[2])


def move(dx, df, dz): return lambda p: (p[0] + dx, p[1] + df, p[2] + dz)


def chain(*fs):
    def g(p):
        for f in fs: p = f(p)
        return p
    return g


def join(objs, name):
    objs = [o for o in objs if o]
    if len(objs) > 1:
        with bpy.context.temp_override(active_object=objs[0], selected_editable_objects=objs, selected_objects=objs):
            bpy.ops.object.join()
    objs[0].name = name; objs[0].data.name = name
    return objs[0]


def interp(prof, f):  # radius of a [(f, r)] profile (descending f)
    for (f0, r0), (f1, r1) in zip(prof, prof[1:]):
        if f1 <= f <= f0: return r0 + (r1 - r0) * (f0 - f) / (f0 - f1) if f0 != f1 else r0
    return prof[-1][1]


def bands(name, mat, prof, at, k=1.012, w=0.012, ht=1.0, hb=1.0, n=2.0, poly=None, cz=0.0, N=28):
    out = []
    for i, f in enumerate(at):
        r = interp(prof, f) * k
        out.append(loft(f'{name}{i}', mat, [sec(f + w, r, r * ht, r * hb, cz=cz, n=n), sec(f - w, r, r * ht, r * hb, cz=cz, n=n)], N=N, poly=poly))
    return out


def body_of(name, mat, prof, ht=1.0, hb=1.0, n=2.0, cz=0.0, N=28, poly=None, cap=True, sharp=38):
    return loft(name, mat, [sec(f, r, r * ht, r * hb, cz=cz, n=n) for f, r in prof], N=N, poly=poly, cap0=cap, cap1=cap, sharp=sharp)


def disc(name, mat, f0, f1, r, cx=0.0, cz=0.0, N=24, r1=None):
    return loft(name, mat, [sec(f0, r, cx=cx, cz=cz), sec(f1, r if r1 is None else r1, cx=cx, cz=cz)], N=N)


def xfins(name, mat, st, O=(0, 0, 0), angles=(45, 135, 225, 315)):
    out = []
    for i, a in enumerate(angles):
        c, s = math.cos(D(a)), math.sin(D(a))
        out.append(wing(f'{name}{i}', mat, st, U=(c, 0, s), F=(0, 1, 0), Nn=(-s, 0, c), O=O))
    return out


# =========================================================================== models
def shahed(jet=False):
    body = M('body', 0x1f2225 if jet else 0x3b4046, 0.62, 0.05)
    elev = M('elevon', 0x2a2d31 if jet else 0x4a5057, 0.6, 0.05)
    dark = M('dark', 0x141517, 0.5, 0.2)
    seam = M('seam', 0x111214, 0.6)
    P = []
    if jet:
        prof = [(1.75, 0), (1.735, .05), (1.70, .10), (1.62, .16), (1.50, .205), (1.32, .24), (1.05, .262), (0.6, .27), (-0.2, .268), (-0.8, .255),
                (-1.15, .235), (-1.40, .20), (-1.58, .15), (-1.70, .08)]
    else:
        prof = [(1.75, 0), (1.735, .05), (1.70, .10), (1.62, .16), (1.50, .205), (1.32, .24), (1.05, .262), (0.6, .27), (-0.2, .268), (-0.8, .255),
                (-1.15, .235), (-1.35, .215), (-1.36, .205), (-1.50, .17), (-1.58, .13), (-1.62, .10)]
    P.append(body_of('fus', body, prof, 0.95, 0.9, 2.2, N=32))
    P += bands('band', seam, prof, [1.06, 0.15, -0.95], ht=0.95, hb=0.9, n=2.2, w=0.008, N=32)
    # cropped delta, blended into the fuselage; straight trailing edge
    P.append(wing('wing', body, [(0.0, 0.55, 2.0, .10, 0), (0.26, 0.42, 1.87, .095, 0), (0.8, -0.384, 1.066, .085, 0), (1.2, -0.98, 0.47, .08, 0),
                                 (1.25, -1.02, 0.43, .08, 0)], O=(0, 0, -0.03), mirror=True, K=14))
    P.append(wing('elevons', elev, [(0.42, -1.29, 0.18, .22, 0), (1.16, -1.29, 0.18, .22, 0)], O=(0, 0, -0.03), mirror=True))
    # tip fins, mostly above the wing
    P.append(wing('tipfins', body, [(-0.17, -1.12, 0.36, .08, 0), (0.0, -1.02, 0.44, .08, 0), (0.12, -1.06, 0.42, .08, 0), (0.46, -1.30, 0.2, .07, 0)],
                  U=(0, 0, 1), F=(0, 1, 0), Nn=(1, 0, 0), O=(1.25, 0, -0.03), mirror=True))
    # satellite-navigation antenna (CRPA puck) on the back, a small blade antenna under the belly
    P.append(loft('crpa', dark, [sec(0.23, .075, cz=0.45), sec(0.275, .075, cz=0.45), sec(0.29, .06, cz=0.45), sec(0.293, 0, cz=0.45)], ax='z'))
    P.append(wing('blade', dark, [(0.0, -0.2, 0.12, .12, 0), (0.12, -0.25, 0.06, .1, 0)], U=(0, 0, -1), F=(0, 1, 0), Nn=(1, 0, 0), O=(0, 0, -0.22)))
    if jet:
        eng = M('engine', 0x2d3034, 0.45, 0.45)
        nac = [(-0.12, .105), (-0.18, .125), (-0.35, .135), (-1.35, .135), (-1.68, .12), (-1.86, .105)]
        P.append(body_of('nacelle', eng, nac, cz=0.34, N=28))
        P.append(disc('intake', dark, -0.14, -0.115, .1, cz=0.34))
        P.append(disc('nozzle', dark, -1.84, -1.95, .108, cz=0.34, r1=.1))
        P.append(disc('exhaust', M('glow', 0xff7a2a, 0.5, 0.0, emit=0xff6a1a), -1.93, -1.958, .082, cz=0.34))
        P += bands('nband', seam, nac, [-0.45, -1.25], cz=0.34, w=0.01)
    else:
        P.append(body_of('muffler', dark, [(-1.2, .028), (-1.62, .026)], cz=-0.2, N=12))
        for sx in (1, -1):           # cylinder-head cooling scoops
            P.append(loft(f'scoop{sx}', dark, [sec(-0.95, 0, cx=0.15 * sx, cz=0.2), sec(-1.05, .045, .035, .01, cx=0.15 * sx, cz=0.2, n=3),
                                               sec(-1.28, .045, .035, .01, cx=0.15 * sx, cz=0.19, n=3)], N=16))
    root = join(P, 'shahed_jet' if jet else 'shahed')
    if not jet:                       # two-blade pusher propeller with a spinner
        prop = M('prop', 0x2a241f, 0.45, 0.0)
        hub = (0, -1.675, 0); B = []
        B.append(loft('spinner', dark, [sec(-1.60, .09), sec(-1.66, .085), sec(-1.71, .062), sec(-1.75, .032), sec(-1.768, 0)], N=24))
        for a in (0, 180):
            c, s = math.cos(D(a)), math.sin(D(a))
            B.append(wing(f'blade{a}', prop, [(0.05, 0.03, 0.06, .2, -40), (0.12, .04, .075, .14, -32), (0.22, .035, .07, .11, -24), (0.32, .028, .055, .1, -18),
                                              (0.38, .018, .035, .1, -14)], U=(c, 0, s), F=(-s, 0, c), Nn=(0, 1, 0), O=hub))
        pr = join(B, 'prop')
        set_origin(pr, hub)
    return root


def set_origin(ob, p):
    """Move an object's origin to local-frame point p (x, f, z), keeping the geometry in place."""
    x, f, z = p; bx, by, bz = x, -f, z
    me = ob.data
    for v in me.vertices: v.co.x += ob.location.x - bx; v.co.y += ob.location.y - by; v.co.z += ob.location.z - bz
    ob.location = (bx, by, bz)


KH_POLY = [(1.0, -0.05), (0.86, 0.5), (0.5, 0.88), (0.0, 1.0), (-0.5, 0.88), (-0.86, 0.5), (-1.0, -0.05), (-0.82, -0.68), (-0.42, -1.0), (0.0, -1.0), (0.42, -1.0), (0.82, -0.68)]


def kh101():
    body = M('body', 0xc4c8cc, 0.5, 0.1)
    nose = M('nose', 0x5e646a, 0.45, 0.1)
    dark = M('dark', 0x16181a, 0.5, 0.2)
    seam = M('seam', 0x7d8287, 0.55)
    metal = M('metal', 0x3a3b3d, 0.4, 0.6)
    P = []
    nprof = [(3.72, 0), (3.62, .07), (3.4, .16), (3.05, .25), (2.6, .32)]
    bprof = [(2.6, .32), (2.05, .36), (1.4, .37), (-2.9, .37), (-3.3, .34), (-3.6, .28), (-3.72, .24)]
    P.append(body_of('nose', nose, nprof, 0.95, 0.85, poly=KH_POLY, sharp=24))
    P.append(body_of('fus', body, bprof, 0.95, 0.85, poly=KH_POLY, sharp=24))
    P += bands('band', seam, nprof + bprof[1:], [2.6, 0.95, -1.1, -2.75], ht=0.95, hb=0.85, poly=KH_POLY, w=0.01)
    P.append(wing('wing', body, [(0.2, 0.55, 0.5, .1, 0), (0.35, 0.52, 0.48, .1, 0), (1.55, 0.12, 0.32, .09, 0)], O=(0, 0, -0.22), mirror=True))
    c8, s8 = math.cos(D(-8)), math.sin(D(-8))
    P.append(wing('htail', body, [(0.2, -2.85, 0.75, .08, 0), (0.3, -2.9, 0.72, .08, 0), (0.95, -3.4, 0.35, .07, 0)], U=(c8, 0, s8), Nn=(-s8, 0, c8),
                  O=(0, 0, -0.05), mirror=True))
    P.append(wing('vtail', body, [(0.25, -2.85, 0.8, .08, 0), (0.32, -2.9, 0.76, .08, 0), (0.85, -3.35, 0.38, .07, 0)], U=(0, 0, 1), Nn=(1, 0, 0)))
    # turbofan in a pod on a ventral pylon
    pod = [(-1.55, .12), (-1.65, .16), (-2.0, .175), (-3.0, .17), (-3.35, .14), (-3.5, .12)]
    P.append(body_of('pod', body, pod, cz=-0.56))
    P.append(disc('intake', dark, -1.53, -1.56, .115, cz=-0.56))
    P.append(disc('nozzle', metal, -3.45, -3.57, .125, cz=-0.56, r1=.108))
    P.append(disc('exhaust', M('glow', 0xff8a3a, 0.5, 0.0, emit=0xff5a10), -3.56, -3.575, .085, cz=-0.56))
    P.append(wing('pylon', body, [(0.0, -1.75, 1.3, .12, 0), (0.2, -1.85, 1.15, .12, 0)], U=(0, 0, -1), Nn=(1, 0, 0), O=(0, 0, -0.25)))
    P += bands('podband', seam, pod, [-2.3], cz=-0.56)
    # radar altimeter window and an aerial under the nose
    P.append(loft('altim', dark, [sec(1.2, .09, .02, .02, cz=-0.31, n=4), sec(0.95, .09, .02, .02, cz=-0.31, n=4)], N=16))
    return join(P, 'kh101')


def banderol():
    body = M('body', 0x59625e, 0.55, 0.1)
    dark = M('dark', 0x16181a, 0.5, 0.2)
    glass = M('glass', 0x10161c, 0.08, 0.3)
    seam = M('seam', 0x3c423f, 0.6)
    metal = M('metal', 0x3a3b3d, 0.4, 0.6)
    P = []
    prof = [(1.55, .045), (1.48, .075), (1.32, .115), (1.1, .145), (0.85, .155), (-1.3, .155), (-1.48, .135), (-1.58, .11)]
    P.append(loft('seeker', glass, [sec(1.6, 0), sec(1.59, .025), sec(1.57, .038), sec(1.55, .045)], N=24))
    P.append(body_of('fus', body, prof, N=28))
    P += bands('band', seam, prof, [1.32, 0.55, -0.6], w=0.008)
    P.append(wing('wing', body, [(0.0, 0.32, 0.26, .1, 0), (0.95, 0.26, 0.2, .08, 0)], O=(0, 0, 0.165), mirror=True))
    P.append(loft('saddle', body, [sec(0.42, 0.0, cz=0.15), sec(0.36, .05, .03, .01, cz=0.15, n=4), sec(0.04, .05, .03, .01, cz=0.15, n=4),
                                   sec(-0.02, 0.0, cz=0.15)], N=16))
    P += xfins('fin', body, [(0.12, -1.22, 0.34, .07, 0), (0.34, -1.38, 0.2, .06, 0)])
    P.append(loft('scoop', body, [sec(-0.2, .06, .045, .045, cz=-0.16), sec(-0.3, .075, .05, .05, cz=-0.17), sec(-1.1, .07, .045, .045, cz=-0.16),
                                  sec(-1.25, 0.0, cz=-0.15)], N=20))
    P.append(disc('intake', dark, -0.19, -0.21, .056, cz=-0.16, r1=.056))
    P.append(disc('nozzle', metal, -1.56, -1.62, .085, r1=.075))
    P.append(disc('exhaust', M('glow', 0xff8a3a, 0.5, 0.0, emit=0xff5a10), -1.615, -1.628, .06))
    return join(P, 'banderol')


def iskander():
    body = M('body', 0x56603f, 0.62, 0.05)
    nose = M('nose', 0x9ba0a3, 0.5, 0.1)
    fin = M('fin', 0x3d4433, 0.55, 0.1)
    seam = M('seam', 0x2a2f22, 0.6)
    metal = M('metal', 0x2c2d2f, 0.42, 0.65)
    P = []
    nprof = [(3.65, 0), (3.64, .03), (3.58, .07), (3.4, .13), (3.1, .2), (2.7, .27), (2.25, .33), (1.8, .385), (1.4, .43)]
    bprof = [(1.4, .43), (0.9, .455), (0.4, .46), (-3.0, .46), (-3.25, .45), (-3.5, .43), (-3.62, .41)]
    P.append(body_of('nose', nose, nprof, N=36))
    P.append(body_of('fus', body, bprof, N=36))
    P += bands('band', seam, nprof + bprof[1:], [1.4, -0.6, -2.4], w=0.012, N=36)
    P.append(loft('raceway', fin, [sec(1.32, 0.0, cz=0.44), sec(1.25, .045, .03, .03, cz=0.455, n=4), sec(-2.45, .045, .03, .03, cz=0.455, n=4),
                                   sec(-2.52, 0.0, cz=0.44)], N=16))
    P += xfins('fin', fin, [(0.4, -2.6, 1.0, .06, 0), (0.45, -2.62, 0.98, .06, 0), (0.9, -3.08, 0.45, .05, 0)])
    for i, a in enumerate((45, 135, 225, 315)):     # actuator fairings at the fin roots
        c, s = math.cos(D(a)), math.sin(D(a))
        P.append(loft(f'act{i}', fin, [sec(-2.3, 0.0, cx=c * .44, cz=s * .44), sec(-2.45, .06, cx=c * .44, cz=s * .44), sec(-3.4, .06, cx=c * .44, cz=s * .44),
                                       sec(-3.5, .03, cx=c * .44, cz=s * .44)], N=14))
    P.append(loft('bell', metal, [sec(-3.58, .26), sec(-3.66, .275), sec(-3.80, .30)], N=32))
    P.append(disc('exhaust', M('glow', 0xffb35a, 0.5, 0.0, emit=0xff8a30), -3.795, -3.81, .27, N=32))
    return join(P, 'iskander')


def kab():
    bomb = M('bomb', 0x4b5536, 0.65, 0.05)
    kit = M('kit', 0x9aa0a2, 0.5, 0.15)
    fuse = M('fuse', 0x6d7072, 0.4, 0.5)
    strap = M('strap', 0x3d4144, 0.5, 0.3)
    yel = M('yellow', 0xc9a227, 0.55)
    P = []
    nprof = [(2.12, 0), (2.10, .045), (2.02, .10), (1.95, .12)]
    bprof = [(1.95, .12), (1.85, .145), (1.6, .18), (1.25, .198), (0.9, .2), (-0.7, .2), (-1.05, .188), (-1.35, .165)]
    P.append(body_of('fuse', fuse, nprof))
    P.append(body_of('bomb', bomb, bprof))
    P += bands('yband', yel, bprof, [1.45], w=0.035)
    P.append(body_of('tail', kit, [(-1.33, .168), (-1.6, .15), (-1.9, .125), (-2.05, .11)]))
    P += xfins('tfin', kit, [(0.1, -1.55, 0.5, .06, 0), (0.14, -1.56, 0.49, .06, 0), (0.42, -1.78, 0.28, .05, 0)])
    # the gliding kit: a saddle on top with long folding wings, held by two straps
    P.append(loft('saddle', kit, [sec(0.68, .06, .03, .03, cz=0.205, n=4), sec(0.6, .11, .07, .05, cz=0.22, n=4), sec(-0.55, .11, .07, .05, cz=0.22, n=4),
                                  sec(-0.65, .06, .03, .03, cz=0.205, n=4)], N=20))
    P.append(wing('wing', kit, [(0.08, 0.24, 0.27, .08, 0), (1.55, 0.10, 0.2, .07, 0)], O=(0, 0, 0.30), mirror=True))
    P.append(loft('hinge', strap, [sec(0.32, .05, .05, .05, cz=0.30), sec(-0.06, .05, .05, .05, cz=0.30)], N=16))
    P += bands('strap', strap, bprof, [0.45, -0.45], k=1.03, w=0.025)
    return join(P, 'kab')


def fpv():
    carbon = M('carbon', 0x1b1c1e, 0.35, 0.15)
    motor = M('motor', 0x2b2d30, 0.35, 0.7)
    mtop = M('mtop', 0xb32626, 0.4, 0.5)
    prop = M('prop', 0xe0661f, 0.4, 0.0)
    batt = M('battery', 0x151618, 0.5, 0.0)
    label = M('label', 0xe2b33a, 0.5, 0.0)
    war = M('warhead', 0x4f5a38, 0.6, 0.05)
    grey = M('grey', 0x77797b, 0.4, 0.5)
    glass = M('glass', 0x0d1218, 0.05, 0.3)
    P = []
    P.append(loft('plate', carbon, [sec(-0.07, .035, .003, .003, n=6), sec(0.08, .035, .003, .003, n=6)], N=24))
    P.append(loft('top', carbon, [sec(-0.055, .03, .002, .002, cz=0.03, n=6), sec(0.06, .03, .002, .002, cz=0.03, n=6)], N=24))
    pos = []
    for i, a in enumerate((45, 135, 225, 315)):
        P.append(loft(f'arm{i}', carbon, [sec(0.0, .012, .0035, .0035, n=6), sec(0.165, .012, .0035, .0035, n=6)], N=16, xf=rotz(a)))
        x, f = 0.165 * math.sin(D(a)), 0.165 * math.cos(D(a)); pos.append((x, f))
        P.append(loft(f'stator{i}', motor, [sec(-0.008, .016, cx=x, cz=f), sec(0.004, .018, cx=x, cz=f)], ax='z', N=20))
        P.append(loft(f'bell{i}', motor, [sec(0.004, .021, cx=x, cz=f), sec(0.024, .021, cx=x, cz=f)], ax='z', N=20))
        P.append(loft(f'mtop{i}', mtop, [sec(0.024, .021, cx=x, cz=f), sec(0.027, .019, cx=x, cz=f)], ax='z', N=20))
        for dx, df in ((0.012, 0.012), (-0.012, 0.012), (0.012, -0.012), (-0.012, -0.012)):
            P.append(loft(f'standoff{i}{dx}{df}', grey, [sec(0.003, .0025, cx=dx * 1.6, cz=df * 2.5), sec(0.028, .0025, cx=dx * 1.6, cz=df * 2.5)], ax='z', N=8)) if i == 0 else None
    P = [p for p in P if p]
    P.append(loft('battery', batt, [sec(-0.065, .024, .018, .018, cz=0.05, n=5), sec(0.065, .024, .018, .018, cz=0.05, n=5)], N=24))
    P.append(loft('label', label, [sec(-0.016, .0245, .0185, .0185, cz=0.05, n=5), sec(0.016, .0245, .0185, .0185, cz=0.05, n=5)], N=24))
    P.append(loft('strapb', M('strapc', 0x8a1d1d, 0.6), [sec(0.035, .0247, .0187, .0187, cz=0.05, n=5), sec(0.026, .0247, .0187, .0187, cz=0.05, n=5)], N=24))
    P.append(loft('cam', batt, [sec(0.068, .013, .013, .013, cz=0.014, n=5), sec(0.094, .013, .013, .013, cz=0.014, n=5)], N=20))
    P.append(loft('lens', glass, [sec(0.093, .008, cz=0.014), sec(0.103, .008, cz=0.014), sec(0.106, .0055, cz=0.014)], N=18))
    P.append(loft('ant', batt, [sec(0.03, .003, cx=0, cz=-0.068), sec(0.085, .003, cx=0, cz=-0.068), sec(0.087, .007, cx=0, cz=-0.068), sec(0.098, .007, cx=0, cz=-0.068),
                                sec(0.1, 0.0, cx=0, cz=-0.068)], ax='z', N=10))
    # PG-7 type shaped-charge warhead slung under the frame, nose forward
    wprof = [(0.33, .016), (0.29, .03), (0.24, .042), (0.19, .046), (0.06, .046), (0.03, .04), (0.0, .028), (-0.04, .02), (-0.17, .02), (-0.19, .024), (-0.2, .02)]
    P.append(loft('probe', grey, [sec(0.40, 0.0, cz=-0.05), sec(0.398, .006, cz=-0.05), sec(0.37, .009, cz=-0.05), sec(0.33, .013, cz=-0.05)], N=16))
    P.append(body_of('warhead', war, wprof, cz=-0.05, N=24))
    P += bands('tie', batt, wprof, [0.12, -0.08], k=1.07, w=0.004, cz=-0.05, N=24)
    root = join(P, 'fpv')
    for i, (x, f) in enumerate(pos):       # 7-inch three-blade props, alternate spin direction is not visible: all one way
        hub = (x, f, 0.032); B = [loft(f'hub{i}', motor, [sec(0.027, .008, cx=x, cz=f), sec(0.037, .006, cx=x, cz=f), sec(0.04, 0.0, cx=x, cz=f)], ax='z', N=14)]
        for b in (0, 120, 240):
            bb = b + i * 30; c, s = math.cos(D(bb)), math.sin(D(bb))
            B.append(wing(f'pb{i}{b}', prop, [(0.008, .008, .016, .12, -25), (0.035, .010, .022, .1, -20), (0.06, .009, .019, .09, -15), (0.088, .004, .009, .09, -11)],
                          U=(s, c, 0), F=(c, -s, 0), Nn=(0, 0, 1), O=hub, K=8))
        set_origin(join(B, f'propv{i}'), hub)
    return root


def su35():
    b1 = M('body', 0x8f9ca7, 0.5, 0.15)
    b2 = M('wing', 0x6f7c88, 0.5, 0.15)
    rad = M('radome', 0xb4b8b3, 0.45, 0.05)
    dark = M('dark', 0x16181a, 0.5, 0.2)
    metal = M('nozzle', 0x45403b, 0.38, 0.7)
    glass = M('glass', 0x16263a, 0.05, 0.35)
    mis = M('missile', 0xd8dad6, 0.45, 0.05)
    glow = M('glow', 0xff8a3a, 0.5, 0.0, emit=0xff5a10)
    P = []
    fw = [(10.95, 0, 0, 0, .35), (10.8, .12, .12, .12, .35), (10.4, .32, .32, .3, .36), (9.8, .5, .5, .45, .38), (9.0, .66, .66, .58, .4)]
    fb = [(9.0, .66, .66, .58, .4), (8.0, .78, .8, .66, .42), (7.0, .86, .9, .72, .42), (6.0, .92, .98, .76, .4), (5.0, .98, 1.0, .8, .38), (4.0, 1.05, 1.0, .82, .35),
          (3.0, 1.12, .95, .82, .32), (2.4, 1.15, .9, .8, .3)]
    P.append(loft('radome', rad, [sec(f, w, ht, hb, cz=cz, n=2.1) for f, w, ht, hb, cz in fw], N=32))
    P.append(loft('nose', b1, [sec(f, w, ht, hb, cz=cz, n=2.1) for f, w, ht, hb, cz in fb], N=32))
    cb = [(4.0, 1.0, .9, .7, .3), (2.5, 1.9, .8, .7, .25), (1.0, 2.3, .78, .72, .2), (-1.0, 2.4, .72, .72, .15), (-3.5, 2.35, .62, .7, .1), (-5.5, 2.1, .5, .65, .05),
          (-7.0, 1.7, .4, .55, 0), (-8.2, 1.0, .3, .4, 0), (-9.0, .5, .28, .3, 0), (-10.6, .32, .25, .25, .05), (-11.0, .16, .14, .14, .05)]
    P.append(loft('centre', b1, [sec(f, w, ht, hb, cz=cz, n=2.6) for f, w, ht, hb, cz in cb], N=40))
    sp = [(4.2, .3, .15, .1, 1.1), (3.4, .5, .3, .2, 1.08), (2.0, .55, .25, .2, .95), (-2.0, .5, .2, .2, .82), (-6.0, .4, .12, .2, .6), (-8.5, .2, .06, .1, .38)]
    P.append(loft('spine', b1, [sec(f, w, ht, hb, cz=cz, n=2.2) for f, w, ht, hb, cz in sp], N=24))
    P.append(loft('canopy', glass, [sec(8.0, 0.0, cz=1.12), sec(7.6, .3, .25, .1, cz=1.18), sec(6.8, .46, .48, .1, cz=1.25), sec(5.8, .5, .55, .1, cz=1.3),
                                    sec(4.8, .45, .42, .1, cz=1.3), sec(3.8, .3, .2, .1, cz=1.25), sec(3.2, 0.0, cz=1.2)], N=32))
    P.append(loft('frame', b1, [sec(6.84, .475, .495, .1, cz=1.25), sec(6.76, .475, .495, .1, cz=1.25)], N=32))
    P.append(loft('irst', glass, [sec(8.2, 0.0, cx=.22, cz=1.18), sec(8.12, .08, cx=.22, cz=1.18), sec(8.0, .12, cx=.22, cz=1.18), sec(7.85, .09, cx=.22, cz=1.18),
                                  sec(7.75, 0.0, cx=.22, cz=1.18)], N=16))
    P.append(loft('pitot', metal, [sec(11.9, 0.0, cz=.35), sec(11.85, .02, cz=.35), sec(10.9, .035, cz=.35), sec(10.8, .05, cz=.35)], N=10))
    for sx in (1, -1):
        cx = 1.3 * sx
        nac = [(3.3, .55, .5, .5, -.55, 6), (2.5, .6, .55, .6, -.6, 4), (0.5, .66, .6, .65, -.6, 2.5), (-3.0, .66, .62, .66, -.55, 2.2), (-7.5, .64, .62, .64, -.45, 2),
               (-9.0, .6, .6, .6, -.4, 2), (-9.5, .58, .58, .58, -.4, 2)]
        P.append(loft(f'nacelle{sx}', b1, [sec(f, w, ht, hb, cx=cx, cz=cz, n=n) for f, w, ht, hb, cz, n in nac], N=32))
        P.append(loft(f'intake{sx}', dark, [sec(3.33, .5, .45, .45, cx=cx, cz=-.55, n=6), sec(3.25, .5, .45, .45, cx=cx, cz=-.55, n=6)], N=32))
        P.append(loft(f'nozzle{sx}', metal, [sec(-9.42, .57, cx=cx, cz=-.4), sec(-9.9, .53, cx=cx, cz=-.4), sec(-10.3, .47, cx=cx, cz=-.4)], N=18, sharp=12))
        P.append(disc(f'ab{sx}', glow, -10.29, -10.31, .39, cx=cx, cz=-.4, N=18))
        P.append(loft(f'rail{sx}', dark, [sec(-2.5, .06, .06, .06, cx=7.62 * sx, cz=.05, n=4), sec(-5.0, .06, .06, .06, cx=7.62 * sx, cz=.05, n=4)], N=12))
        for s, f0 in ((3.4, -0.6), (5.3, -2.1)):          # missiles under the wings, on pylons
            mx = s * sx
            P.append(loft(f'msl{sx}{s}', mis, [sec(f0 + 1.8, 0.0, cx=mx, cz=-.5), sec(f0 + 1.5, .09, cx=mx, cz=-.5), sec(f0 + 1.0, .13, cx=mx, cz=-.5),
                                               sec(f0 - 1.6, .13, cx=mx, cz=-.5), sec(f0 - 1.8, .1, cx=mx, cz=-.5)], N=16))
            P += xfins(f'mf{sx}{s}', mis, [(0.08, f0 - 1.15, .5, .06, 0), (0.3, f0 - 1.4, .28, .06, 0)], O=(mx, 0, -.5))
            P.append(wing(f'pyl{sx}{s}', b2, [(0.0, f0 + 0.6, 1.6, .1, 0), (0.42, f0 + 0.5, 1.4, .1, 0)], U=(0, 0, -1), Nn=(1, 0, 0), O=(mx, 0, 0.02)))
    P.append(wing('wing', b2, [(1.6, 2.0, 5.6, .05, 0), (2.6, 1.2, 4.6, .05, 0), (7.4, -3.2, 1.5, .045, 0), (7.6, -3.38, 1.38, .045, 0)], O=(0, 0, 0.05), mirror=True, K=12))
    P.append(wing('lerx', b2, [(0.9, 6.0, 5.0, .03, 0), (2.6, 1.25, 0.8, .03, 0)], O=(0, 0, 0.15), mirror=True))
    P.append(wing('stab', b2, [(1.9, -6.9, 3.4, .045, 0), (2.3, -7.3, 3.0, .045, 0), (5.0, -9.6, 1.2, .04, 0)], O=(0, 0, -0.35), mirror=True))
    c4, s4 = math.cos(D(4)), math.sin(D(4))
    P.append(wing('fin', b2, [(0.0, -5.6, 4.0, .05, 0), (0.3, -5.9, 3.8, .05, 0), (3.6, -8.6, 1.5, .04, 0), (3.75, -8.8, 1.3, .04, 0)], U=(s4, 0, c4), Nn=(c4, 0, -s4),
                  O=(1.55, 0, 0.35), mirror=True))
    P.append(wing('finTip', dark, [(3.74, -8.75, 1.35, .045, 0), (3.85, -8.9, 1.2, .045, 0)], U=(s4, 0, c4), Nn=(c4, 0, -s4), O=(1.55, 0, 0.35), mirror=True))
    P.append(wing('ventral', b2, [(0.0, -6.2, 1.6, .05, 0), (0.9, -6.9, 1.0, .04, 0)], U=(0.26, 0, -0.97), Nn=(0.97, 0, 0.26), O=(1.5, 0, -0.95), mirror=True))
    return join(P, 'su35')


MODELS = {'shahed': lambda: shahed(False), 'geran3': lambda: shahed(True), 'kh101': kh101, 'banderol': banderol, 'iskander': iskander, 'kab': kab, 'fpv': fpv,
          'su35': su35}


# =========================================================================== export + preview
def preview(name):
    from mathutils import Vector
    sc = bpy.context.scene
    mn, mx = Vector((1e9,) * 3), Vector((-1e9,) * 3)
    for o in sc.objects:
        if o.type != 'MESH': continue
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c); mn = Vector(map(min, mn, w)); mx = Vector(map(max, mx, w))
    ctr, size = (mn + mx) / 2, max(mx - mn)
    world = bpy.data.worlds.new('w'); sc.world = world; world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.42, 0.52, 0.66, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.9
    ld = bpy.data.lights.new('sun', 'SUN'); ld.energy = 3.5; ld.angle = D(4)
    lo = bpy.data.objects.new('sun', ld); sc.collection.objects.link(lo); lo.rotation_euler = (D(40), D(10), D(-35))
    cd = bpy.data.cameras.new('cam'); cd.lens = 85; cd.clip_start = size * 0.01; cd.clip_end = size * 100
    cam = bpy.data.objects.new('cam', cd); sc.collection.objects.link(cam); sc.camera = cam
    aim = bpy.data.objects.new('aim', None); sc.collection.objects.link(aim); aim.location = ctr
    tc = cam.constraints.new('TRACK_TO'); tc.target = aim; tc.track_axis = 'TRACK_NEGATIVE_Z'; tc.up_axis = 'UP_Y'
    sc.render.engine = 'CYCLES'; sc.cycles.samples = 48; sc.cycles.use_denoising = True
    try:
        pr = bpy.context.preferences.addons['cycles'].preferences
        for t in ('OPTIX', 'CUDA', 'HIP', 'ONEAPI'):
            try:
                pr.compute_device_type = t; pr.get_devices()
                if any(dv.type == t for dv in pr.devices):
                    for dv in pr.devices: dv.use = dv.type == t
                    sc.cycles.device = 'GPU'; break
            except TypeError: pass
    except Exception as e: print('CPU render', e)
    sc.view_settings.view_transform = 'AgX'
    sc.render.resolution_x, sc.render.resolution_y = 960, 600
    d = size * 3.3
    for tag, dirv in (('a', (-0.75, -0.9, 0.55)), ('b', (0.55, 0.6, 0.85))):
        v = Vector(dirv).normalized(); cam.location = ctr + v * d
        sc.render.filepath = os.path.join(PREV, f'{name}_{tag}.png'); bpy.ops.render.render(write_still=True)


for name, build in MODELS.items():
    if ONLY and name not in ONLY: continue
    bpy.ops.wm.read_factory_settings(use_empty=True); MATS.clear()
    build()
    fp = os.path.join(OUT, name + '.glb')
    bpy.ops.export_scene.gltf(filepath=fp, export_format='GLB', export_apply=True, export_yup=True)
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in bpy.context.scene.objects if o.type == 'MESH')
    print(f'MODEL {name}: {os.path.getsize(fp) // 1024} KB, ~{tris} tris, objects {[o.name for o in bpy.context.scene.objects]}')
    if PREV:
        os.makedirs(PREV, exist_ok=True); preview(name)
print('DONE')
