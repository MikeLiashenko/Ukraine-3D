// ---------------------------------------------------------------- follow a WarAlarm target over the real city
// Opened as <oblast>/?lat=&lon=[&id=&cat=&hdg=&alt=&label=&kmh=] (the go/ router picks the oblast). With an id the page
// reads the target from the WarAlarm live state (Firebase, state/threats ~7 KB every 15 s) and flies it the way the app
// does; inside the WarAlarm app the app itself pushes the exact position (window.WA.push({...}) / postMessage).
// A 3D model of the weapon flies at its altitude over the buildings, with its track, the way ahead and the ring of
// where it may be; the camera rides along (orbit around it freely). When it crosses into another oblast the page
// hands over to that oblast's viewer.
const WAF = (() => {
  const Q = new URLSearchParams(location.search);
  const num = (k) => { const v = parseFloat(Q.get(k)); return isFinite(v) ? v : null; };
  const LAT0 = num('lat'), LON0 = num('lon'), ID = Q.get('id') || '';
  if (LAT0 === null || LON0 === null) return { on: false };
  const DB = 'https://waralarm-c8c1f-default-rtdb.europe-west1.firebasedatabase.app';
  const GO = location.hostname.endsWith('github.io') ? 'https://mikeliashenko.github.io/Ukraine-3D/go/' : '../go/';
  const D2R = Math.PI / 180, RE = 6378137, [OLAT, OLON] = REG.origin, KO = Math.cos(OLAT * D2R), MY0 = Math.log(Math.tan(Math.PI / 4 + OLAT * D2R / 2));
  const xyOf = (lat, lon) => [RE * KO * (lon - OLON) * D2R, RE * KO * (Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2)) - MY0)];

  // ---- the target's motion: the app's model (motion.dart), without the alarm-zone limits
  const SPD = { shahed: 180, missile: 800, balist: 3000, kab: 600, fpv: 100, avia: 800, banderol: 400 };
  const kmB = (a1, o1, a2, o2) => { const dA = (a2 - a1) * D2R, dO = (o2 - o1) * D2R, h = Math.sin(dA / 2) ** 2 + Math.cos(a1 * D2R) * Math.cos(a2 * D2R) * Math.sin(dO / 2) ** 2; return 12742 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)); };
  const brg = (a1, o1, a2, o2) => { const y = Math.sin((o2 - o1) * D2R) * Math.cos(a2 * D2R), x = Math.cos(a1 * D2R) * Math.sin(a2 * D2R) - Math.sin(a1 * D2R) * Math.cos(a2 * D2R) * Math.cos((o2 - o1) * D2R); return (Math.atan2(y, x) / D2R + 360) % 360; };
  const moveKm = (lat, lon, b, km) => [lat + km * Math.cos(b * D2R) / 111, lon + km * Math.sin(b * D2R) / (111 * Math.cos(lat * D2R))];
  const routeKm = (r) => { let s = 0; for (let i = 1; i < r.length; i++) s += kmB(r[i - 1][0], r[i - 1][1], r[i][0], r[i][1]); return s; };
  function along(r, km) {
    for (let i = 1; i < r.length; i++) {
      const a = r[i - 1], b = r[i], seg = kmB(a[0], a[1], b[0], b[1]);
      if (km <= seg && seg > 0) { const f = km / seg; return { lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + (b[1] - a[1]) * f, hdg: brg(a[0], a[1], b[0], b[1]), i }; }
      km -= seg;
    }
    const a = r[r.length - 2], b = r[r.length - 1];
    return { lat: b[0], lon: b[1], hdg: brg(a[0], a[1], b[0], b[1]), i: r.length };
  }
  const hash = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
  function orbit(t, lat, lon, flownKm, now, quiet) {
    const r = Math.min(t.cat === 'fpv' ? 3 : 8, Math.max(0, flownKm)), ang = (hash(t.id || '') % 360 + now / 180000 * 360) % 360;
    const [a, o] = moveKm(lat, lon, ang, r);
    return { lat: a, lon: o, hdg: (ang + 90) % 360, quiet, orbit: true };
  }
  function motion(t, now) {
    const spd = (t.kmh > 0 ? t.kmh : SPD[t.cat] || 180) / 60, route = Array.isArray(t.route) ? t.route : [];
    const quiet = Math.max(0, now - (t.seen || now)) / 60000;
    if (t.launch && t.from) return { lat: t.from[0], lon: t.from[1], hdg: t.heading || 0, quiet, launch: true };
    if (t.from && t.to && t.t0 > 0 && (t.cat === 'balist' || t.cat === 'kab')) {
      const dist = Math.max(0.1, kmB(t.from[0], t.from[1], t.to[0], t.to[1])), p = Math.min(1, Math.max(0, spd * Math.max(0, now - t.t0) / 60000 / dist));
      return { lat: t.from[0] + (t.to[0] - t.from[0]) * p, lon: t.from[1] + (t.to[1] - t.from[1]) * p, hdg: brg(t.from[0], t.from[1], t.to[0], t.to[1]), p, distKm: dist, quiet, ahead: [t.to] };
    }
    if (t.areaKm > 0) { const ang = (now / 333) % 360, [a, o] = moveKm(t.lat, t.lon, ang, 15); return { lat: a, lon: o, hdg: (ang + 90) % 360, quiet }; }
    if (t.forecast && route.length >= 2) { const p = along(route, spd * 0.85 * quiet); return { ...p, quiet, ahead: route.slice(p.i) }; }
    if (t.orbit && !t.down) return orbit(t, t.lat, t.lon, spd * 0.85 * quiet, now, quiet);
    if (route.length >= 2 && !t.down) {
      const want = spd * 0.85 * Math.min(quiet, 20), total = routeKm(route);
      if (want >= total) return orbit(t, route[route.length - 1][0], route[route.length - 1][1], spd * 0.85 * quiet - total, now, quiet);
      const p = along(route, want), stopped = quiet >= 20;
      return { ...p, quiet, uncertKm: !stopped || quiet < 1.5 ? 0 : Math.min(80, spd * 0.4 * quiet), ahead: route.slice(p.i) };
    }
    let lat = t.lat, lon = t.lon;
    if (t.heading != null && t.hdgReal && !t.down) [lat, lon] = moveKm(lat, lon, t.heading, Math.min(30, spd * 0.7 * Math.min(quiet, 4)));
    return { lat, lon, hdg: t.heading || 0, quiet, uncertKm: t.down || quiet < 1.5 ? 0 : Math.min(80, spd * 0.5 * quiet) };
  }
  // height above the ground, m: what the channels said, else typical for the weapon; ballistic and КАБ along their arc
  function altOf(t, m) {
    if (t.cat === 'balist' && m.p != null) { const H = Math.min(60000, m.distKm * 250); return { alt: 4 * H * m.p * (1 - m.p), pitch: -Math.atan(4 * H * (1 - 2 * m.p) / (m.distKm * 1000)) }; }
    if (t.cat === 'kab' && m.p != null) return { alt: 9000 * (1 - m.p), pitch: Math.atan(9000 / (m.distKm * 1000)) };
    if (t.down) return { alt: 0, pitch: 0.5 };
    if (t.alt > 0) return { alt: Math.min(12000, Math.max(20, t.alt)), pitch: t.altNote === 'знижується' ? 0.12 : t.altNote === 'набирає висоту' ? -0.12 : 0 };
    const jet = /реактив/i.test(t.label || '');
    return { alt: t.cat === 'shahed' ? (jet ? 1200 : 350) : ({ missile: 90, fpv: 50, avia: 6000, banderol: 150 })[t.cat] || 300, pitch: 0 };
  }

  // ---- 3D models, metres, nose along +Z, up +Y
  const COL = { shahed: 0xff5a36, missile: 0xff2d55, balist: 0xff3b30, kab: 0xffb020, fpv: 0x2dd4bf, banderol: 0xff6ec7, avia: 0x6aa7ff, other: 0xff5a36 };
  const LEN = { shahed: 3.5, missile: 7, balist: 7.3, kab: 4, fpv: 1.2, banderol: 3.2, avia: 23, other: 3 };
  const mat = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, metalness: 0.25, fog: false, ...o });
  const along_z = (g) => g.rotateX(Math.PI / 2);
  function mesh(geo, m, x = 0, y = 0, z = 0) { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); return o; }
  function planform(pts, thick, m) {           // a flat wing from [x, z] points (z forward)
    const s = new THREE.Shape(); pts.forEach(([x, z], i) => (i ? s.lineTo(x, z) : s.moveTo(x, z)));
    const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false }); g.rotateX(Math.PI / 2); g.translate(0, thick / 2, 0);
    return new THREE.Mesh(g, m);
  }
  function body(r, len, m, nose = 0.6) {       // fuselage along Z with a pointed nose
    const g = new THREE.Group();
    g.add(mesh(along_z(new THREE.CylinderGeometry(r, r, len, 16)), m));
    g.add(mesh(along_z(new THREE.ConeGeometry(r, len * nose * 0.25, 16)), m, 0, 0, len / 2 + len * nose * 0.125));
    return g;
  }
  function fins(n, r, z, h, len, m, rot0 = Math.PI / 4) {
    const g = new THREE.Group();
    for (let k = 0; k < n; k++) { const f = mesh(new THREE.BoxGeometry(0.04, h, len), m); const a = rot0 + k * 2 * Math.PI / n; f.position.set(Math.cos(a) * (r + h / 2), Math.sin(a) * (r + h / 2), z); f.rotation.z = a - Math.PI / 2; g.add(f); }
    return g;
  }
  function model(cat, jet) {
    const g = new THREE.Group();
    if (cat === 'shahed') {
      const m = mat(jet ? 0x30343a : 0x4a5056), d = mat(0x24272b);
      g.add(planform([[0, 1.3], [1.25, -1.2], [1.25, -1.6], [0.25, -1.45], [-0.25, -1.45], [-1.25, -1.6], [-1.25, -1.2]], 0.12, m));
      g.add(body(0.2, 2.9, m, 0.5));
      for (const s of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(0.05, 0.62, 0.42), d, s * 1.25, 0.12, -1.38));
      if (jet) { g.add(mesh(along_z(new THREE.CylinderGeometry(0.22, 0.26, 1.3, 14)), d, 0, 0.34, -1.1)); g.add(mesh(along_z(new THREE.CylinderGeometry(0.2, 0.05, 0.6, 12)), mat(0xff8a3d, { emissive: 0xff6a1a, emissiveIntensity: 2 }), 0, 0.34, -2.0)); }
      else { const p = mesh(along_z(new THREE.CylinderGeometry(0.62, 0.62, 0.02, 24)), new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.35, fog: false })); p.position.z = -1.6; p.userData.prop = true; g.add(p); }
    } else if (cat === 'missile' || cat === 'banderol') {
      const small = cat === 'banderol', L = small ? 2.6 : 6.2, m = mat(small ? 0x6a6f74 : 0xb9bec3), d = mat(0x3b3f44);
      g.add(body(small ? 0.18 : 0.3, L, m, 0.55));
      g.add(planform(small ? [[0, 0.7], [1.6, -0.5], [1.6, -0.8], [0, -0.2], [-1.6, -0.8], [-1.6, -0.5]] : [[0.25, 0.5], [1.7, -0.4], [1.7, -0.7], [0.25, -0.1], [-0.25, -0.1], [-1.7, -0.7], [-1.7, -0.4], [-0.25, 0.5]], 0.05, d));
      g.add(fins(3, small ? 0.18 : 0.3, -L / 2 + 0.3, 0.45, 0.5, d, Math.PI / 2));
      if (!small) g.add(mesh(along_z(new THREE.CylinderGeometry(0.17, 0.2, 1.1, 12)), d, 0, -0.38, -2.4));
    } else if (cat === 'balist') {
      const m = mat(0xdcdad0), d = mat(0x2e3236);
      g.add(body(0.46, 6.0, m, 0.75)); g.add(mesh(along_z(new THREE.CylinderGeometry(0.47, 0.47, 0.5, 18)), d, 0, 0, 1.6));
      g.add(fins(4, 0.46, -2.6, 0.55, 0.8, d));
      g.add(mesh(new THREE.ConeGeometry(0.5, 2.6, 14).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffb35a, transparent: true, opacity: 0.85, fog: false }), 0, 0, -4.3));
    } else if (cat === 'kab') {
      const m = mat(0x5a6448), d = mat(0x2f3527);
      g.add(body(0.25, 3.2, m, 0.6)); g.add(fins(4, 0.25, -1.45, 0.35, 0.45, d));
      const w = planform([[1.7, 0.25], [1.7, -0.05], [-1.7, -0.05], [-1.7, 0.25]], 0.04, d); w.position.y = 0.3; g.add(w);
    } else if (cat === 'fpv') {
      const m = mat(0x1d1f22), r = mat(0x3a3d40);
      for (const a of [Math.PI / 4, -Math.PI / 4]) { const arm = mesh(new THREE.BoxGeometry(0.05, 0.03, 0.7), m); arm.rotation.y = a; g.add(arm); }
      g.add(mesh(new THREE.BoxGeometry(0.14, 0.08, 0.22), m));
      for (const [x, z] of [[0.25, 0.25], [-0.25, 0.25], [0.25, -0.25], [-0.25, -0.25]]) { g.add(mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.06, 10), r, x, 0.04, z)); const p = mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.005, 18), new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.35, fog: false }), x, 0.08, z); g.add(p); }
      g.add(mesh(along_z(new THREE.CylinderGeometry(0.05, 0.05, 0.3, 10)), mat(0x5b6b3a), 0, -0.06, 0.12));
    } else if (cat === 'avia') {
      const m = mat(0x7d8a96), d = mat(0x4a545e);
      g.add(body(1.1, 18, m, 0.45));
      g.add(planform([[1.0, 3], [7.2, -3.6], [7.2, -4.6], [1.0, -4.2], [-1.0, -4.2], [-7.2, -4.6], [-7.2, -3.6], [-1.0, 3]], 0.25, d));
      g.add(planform([[1.0, -6.6], [4.0, -9.0], [4.0, -9.8], [-4.0, -9.8], [-4.0, -9.0], [-1.0, -6.6]], 0.15, d));
      for (const s of [-1, 1]) { const f = mesh(new THREE.BoxGeometry(0.18, 3.6, 3.0), d, s * 1.6, 2.2, -7.8); f.rotation.z = s * 0.12; g.add(f); }
      for (const s of [-1, 1]) g.add(mesh(along_z(new THREE.CylinderGeometry(0.45, 0.2, 1.2, 12)), mat(0xff8a3d, { emissive: 0xff6a1a, emissiveIntensity: 1.6 }), s * 0.6, -0.1, -9.6));
    } else g.add(mesh(new THREE.IcosahedronGeometry(1, 1), mat(0xff5a36, { emissive: 0xff3a1a, emissiveIntensity: 1 })));
    g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; } });
    return g;
  }
  function glowTex(c) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 128; const x = cv.getContext('2d'), col = new THREE.Color(c);
    const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64), rgb = `${(col.r * 255) | 0},${(col.g * 255) | 0},${(col.b * 255) | 0}`;
    gr.addColorStop(0, `rgba(${rgb},0.55)`); gr.addColorStop(0.25, `rgba(${rgb},0.3)`); gr.addColorStop(0.6, `rgba(${rgb},0.08)`); gr.addColorStop(1, `rgba(${rgb},0)`);
    x.fillStyle = gr; x.fillRect(0, 0, 128, 128); const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
  }

  // ---- scene objects
  // drawn as an overlay after the frame (post-processing included): the AO pass would smear dark halos around a model in the air
  const root = new THREE.Group(), fx = new THREE.Scene(); fx.add(root);
  { fx.add(new THREE.HemisphereLight(0xdfe8f5, 0x55604a, 1.2)); const l = new THREE.DirectionalLight(0xfff1df, 2.4); l.position.set(0.5, 1, 0.35); fx.add(l); }
  { const draw0 = draw; draw = () => { draw0(); const ac = renderer.autoClear; renderer.autoClear = false; renderer.clearDepth(); renderer.render(fx, camera); renderer.autoClear = ac; }; }
  let T = { id: ID, cat: Q.get('cat') || 'shahed', label: Q.get('label') || '', place: Q.get('place') || '', lat: LAT0, lon: LON0, heading: num('hdg'), hdgReal: num('hdg') !== null,
    kmh: num('kmh') || 0, alt: num('alt') || 0, seen: Date.now(), stage: '', stageLabel: '' };
  let cat = '', ship = null, glow = null, color = 0;
  function setCat(c, jet) {
    const key = `${c}|${jet}`; if (key === cat) return; cat = key;
    if (ship) root.remove(ship); if (glow) root.remove(glow);
    color = COL[c] || COL.other; ship = model(c, jet); root.add(ship);
    glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(color), blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, transparent: true, opacity: 0.7, fog: false }));
    glow.renderOrder = 60; root.add(glow);
    beam.material.color.set(color); ring.material.color.set(color); trail.material.color.set(color); ahead.material.color.set(color); unc.material.color.set(color);
  }
  const lineOf = (n, m) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); g.setDrawRange(0, 0); const l = new THREE.Line(g, m); l.frustumCulled = false; l.renderOrder = 55; return l; };
  const beam = lineOf(2, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55, fog: false, depthWrite: false }));
  const trail = lineOf(600, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9, fog: false, depthWrite: false }));
  const ahead = lineOf(64, new THREE.LineDashedMaterial({ transparent: true, opacity: 0.75, dashSize: 60, gapSize: 45, fog: false, depthWrite: false }));
  const unc = lineOf(97, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.6, fog: false, depthWrite: false }));
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.78, 1, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6, depthWrite: false, fog: false, side: THREE.DoubleSide }));
  ring.renderOrder = 54; root.add(beam, trail, ahead, unc, ring);

  // ---- UI: panel + label next to the model
  const css = document.createElement('style');
  css.textContent = `/* follow mode shows only the target: none of the site's own panels and place labels */
body.wa #districts, body.wa #brand, body.wa #search, body.wa #dock, body.wa #compass, body.wa #labels, body.wa #card, body.wa #prog { display: none !important; }
#waPanel { position: fixed; z-index: 30; left: max(16px, env(safe-area-inset-left, 0px)); top: calc(14px + env(safe-area-inset-top, 0px)); width: min(360px, calc(100vw - 32px)); padding: 10px 12px; display: grid; gap: 4px; box-sizing: border-box; }
#waPanel .wt { display: flex; align-items: center; gap: 8px; font-weight: 600; }
#waPanel .wt b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#waPanel .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--wa, #ff5a36); box-shadow: 0 0 0 0 var(--wa, #ff5a36); animation: waP 1.4s infinite; flex: none; }
#waPanel.gone .dot { animation: none; background: var(--muted); }
@keyframes waP { 0% { box-shadow: 0 0 0 0 rgba(255, 90, 54, .6); } 100% { box-shadow: 0 0 0 10px rgba(255, 90, 54, 0); } }
#waPanel small { color: var(--muted); font-size: 12px; }
#waInfo { font-size: 13px; }
#waPanel .wb { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
#waPanel .wb button { font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 999px; border: 1px solid var(--line, rgba(127,127,127,.35)); background: transparent; color: inherit; cursor: pointer; }
#waPanel .wb button.on { background: var(--wa, #ff5a36); border-color: transparent; color: #fff; }
#waLab { position: fixed; z-index: 25; pointer-events: none; transform: translate(-50%, calc(-100% - 18px)); padding: 3px 8px; border-radius: 8px; background: rgba(12, 14, 18, .72); color: #fff; font-size: 12px; line-height: 1.3; white-space: nowrap; text-align: center; }
#waLab b { color: var(--wa, #ff5a36); }
@media (max-width: 640px) { #waPanel { left: 8px; right: 8px; width: auto; padding: 8px 10px; } #waPanel .wb button { padding: 4px 8px; } }`;
  document.head.appendChild(css);
  const panel = document.createElement('div'); panel.id = 'waPanel'; panel.className = 'panel';
  panel.innerHTML = `<div class="wt"><span class="dot"></span><b id="waName">Ціль</b><small id="waStage"></small></div><div id="waInfo"></div><small id="waAge"></small>
<div class="wb"><button id="waCam" class="on">🎥 Камера за ціллю</button><button id="waSize">Реальний розмір</button><button id="waTop">Згори</button></div>`;
  document.body.appendChild(panel); document.body.classList.add('wa');
  const lab = document.createElement('div'); lab.id = 'waLab'; document.body.appendChild(lab);
  let camFollow = true, realSize = false, gone = false;
  const setCam = (v) => { camFollow = v; $('waCam').classList.toggle('on', v); $('waCam').textContent = v ? '🎥 Камера за ціллю' : '🎥 До цілі'; };
  $('waCam').addEventListener('click', () => { if (camFollow) { setCam(false); return; } setCam(true); snapCam(480); });
  $('waSize').addEventListener('click', () => { realSize = !realSize; $('waSize').classList.toggle('on', realSize); invalidate(); });
  $('waTop').addEventListener('click', () => { setCam(true); const t = controls.target; camera.position.set(t.x + 1, t.y + 2600, t.z + 600); invalidate(); });
  const CAT_UK = { shahed: 'Шахед', missile: 'Крилата ракета', balist: 'Балістика', kab: 'КАБ', fpv: 'FPV-дрон', avia: 'Авіація', banderol: 'Бандероль', other: 'Ціль' };
  const DIRS = ['Пн', 'ПнСх', 'Сх', 'ПдСх', 'Пд', 'ПдЗх', 'Зх', 'ПнЗх'];
  const fmtAlt = (a) => (a >= 1000 ? `~${(a / 1000).toFixed(1).replace('.0', '')} км` : `~${Math.round(a / 10) * 10} м`);

  // ---- data: pushes from the app, else the live state by id
  let mode = 'static', M = null, pushAt = 0, P = null;
  function push(o) {
    if (!o || !isFinite(o.lat) || !isFinite(o.lon)) { if (o && o.gone) setGone(o.gone === true ? 'Ціль зникла з радарів' : String(o.gone)); return; }
    mode = 'push'; P = o; pushAt = performance.now();
    T = { ...T, ...o, heading: o.hdg ?? T.heading, hdgReal: true };
    if (o.trail && !trailSeeded) seedTrail(o.trail);
    if (o.gone) setGone(o.gone === true ? 'Ціль зникла з радарів' : String(o.gone)); else if (gone) { gone = false; panel.classList.remove('gone'); }
  }
  window.WA = { push, get target() { return T; } };
  addEventListener('message', (e) => { const d = e.data; if (d && d.wa === 'target') push(d); });
  function setGone(why) { gone = true; panel.classList.add('gone'); $('waStage').textContent = why; }
  async function poll() {
    if (mode === 'push' || !ID) return;
    try {
      const list = await fetch(`${DB}/state/threats.json`, { cache: 'no-store' }).then((r) => r.json());
      const t = (list || []).find((x) => x && x.id === ID);
      if (!t) { setGone(mode === 'live' ? 'Ціль зникла з радарів: збита, долетіла або втрачена' : 'Ціль уже зникла з радарів'); return; }
      mode = 'live'; T = t; if (!trailSeeded && t.trail) seedTrail(t.trail);
    } catch (e) { console.warn('WarAlarm state', e); }
  }
  // ---- the shown position (world, metres) eases toward where the target is now
  const cur = new THREE.Vector3(), goal = new THREE.Vector3(); let hdgCur = 0, pitchCur = 0, have = false, altNow = 0;
  const groundY = (x, y) => hAt(x, y);
  function goalNow(now) {
    let lat, lon, hdg, alt, pitch = 0;
    if (mode === 'push' && P) {
      const dt = Math.min(2.5, (performance.now() - pushAt) / 1000), v = ((P.v ?? P.kmh) || 0) / 3600 * (P.moving === false ? 0 : 1);
      [lat, lon] = v > 0 && P.hdg != null ? moveKm(P.lat, P.lon, P.hdg, v * dt) : [P.lat, P.lon];
      hdg = P.hdg ?? hdgCur / D2R; const a = altOf(T, { p: P.progress, distKm: P.distKm });
      alt = a.alt; pitch = a.pitch; M = { lat, lon, hdg, uncertKm: P.uncertKm || 0, ahead: P.ahead || null, quiet: P.quiet || 0, orbit: !!P.orbit };
    } else {
      M = mode === 'live' ? motion(T, now) : { lat: T.lat, lon: T.lon, hdg: T.heading || 0, quiet: 0 };
      ({ lat, lon, hdg } = M); const a = altOf(T, M); alt = a.alt; pitch = a.pitch;
    }
    const [x, y] = xyOf(lat, lon); altNow = alt;
    goal.set(x, groundY(x, y) + alt, -y);
    return { hdg: (hdg || 0) * D2R, pitch };
  }
  // ---- trail: where it has been (the channel's reports first, then what we flew)
  let trailN = 0, trailSeeded = false, trailAt = 0;
  function trailPush(v) {
    const a = trail.geometry.attributes.position;
    if (trailN >= 600) { a.array.copyWithin(0, 3); trailN = 599; }
    a.array[trailN * 3] = v.x; a.array[trailN * 3 + 1] = v.y; a.array[trailN * 3 + 2] = v.z; trailN++;
    a.needsUpdate = true; trail.geometry.setDrawRange(0, trailN);
  }
  function seedTrail(pts) {
    trailSeeded = true; const a0 = altOf(T, {}).alt;
    for (const p of pts) { if (!Array.isArray(p) || !isFinite(p[0]) || !isFinite(p[1])) continue; const [x, y] = xyOf(p[0], p[1]); trailPush(new THREE.Vector3(x, groundY(x, y) + a0, -y)); }
  }
  function setLine(l, pts) {
    const a = l.geometry.attributes.position, n = Math.min(pts.length, a.count);
    for (let i = 0; i < n; i++) a.array.set(pts[i], i * 3);
    a.needsUpdate = true; l.geometry.setDrawRange(0, n); if (l.material.isLineDashedMaterial) l.computeLineDistances();
  }
  // ---- camera: rides along with the target, keeping the angle and distance the viewer chose
  let interacting = false, lastT = new THREE.Vector3();
  controls.addEventListener('start', () => { interacting = true; });
  controls.addEventListener('end', () => { interacting = false; });
  function snapCam(d) {
    const h = hdgCur, back = new THREE.Vector3(-Math.sin(h), 0, Math.cos(h));
    controls.target.copy(cur); camera.position.copy(cur).addScaledVector(back, d * 0.86).add(new THREE.Vector3(0, d * 0.5, 0));
    const fl = groundY(camera.position.x, -camera.position.z) + 30; if (camera.position.y < fl) camera.position.y = fl;
    lastT.copy(controls.target); controls.update(); invalidate(); shadowDirty = true;
  }
  // ---- hand over to the next oblast's viewer when the target leaves this one
  let OBL = null, handing = false;
  fetch(`${GO}oblasts.json`).then((r) => r.json()).then((x) => { OBL = x; }).catch(() => {});
  const inRing = (r, lon, lat) => { let ins = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) ins = !ins; } return ins; };
  const inObl = (o, lon, lat) => o.rings.reduce((a, r) => a !== inRing(r, lon, lat), false);
  function edgeKm(o, lon, lat) {
    const kx = 111.32 * Math.cos(lat * D2R), ky = 110.57; let best = 1e9;
    for (const r of o.rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const ax = (r[j][0] - lon) * kx, ay = (r[j][1] - lat) * ky, dx = (r[i][0] - r[j][0]) * kx, dy = (r[i][1] - r[j][1]) * ky, L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
      best = Math.min(best, Math.hypot(ax + dx * t, ay + dy * t));
    }
    return best;
  }
  function handover() {
    if (!OBL || !M || handing || gone) return;
    const own = OBL.find((o) => o.slug === REG.slug);
    if (own && inObl(own, M.lon, M.lat)) return;
    const o = OBL.find((x) => x.slug !== REG.slug && inObl(x, M.lon, M.lat) && edgeKm(x, M.lon, M.lat) > 2);
    if (!o) return;                                   // outside Ukraine (over Russia, the sea): stays here
    handing = true; $('waStage').textContent = `→ ${o.name}`;
    const q = new URLSearchParams(location.search); q.set('lat', M.lat.toFixed(5)); q.set('lon', M.lon.toFixed(5)); if (T.heading != null) q.set('hdg', Math.round(T.heading));
    q.set('cat', T.cat || 'shahed'); if (T.label) q.set('label', T.label);
    const url = location.hostname.endsWith('github.io') && o.url ? o.url : `../${o.slug}/`;
    setTimeout(() => location.replace(`${url}?${q.toString()}`), 900);
  }
  // fog follows the camera's height over the ground too, not only the orbit distance: a drone at 1-2 km must not fly in milk
  { const fit0 = fitRange; fitRange = () => { fit0(); const h = camera.position.y - groundY(camera.position.x, -camera.position.z); if (h > 300) { scene.fog.near = Math.max(scene.fog.near, h * 2.2); scene.fog.far = Math.max(scene.fog.far, h * 7 + 4000); } }; }
  // ---- every frame
  let lastFrame = 0, odd = false, uncAt = 0, uiAt = 0, aheadAt = 0;
  function tick(now) {
    requestAnimationFrame(tick);
    if (MOBILE && (odd = !odd)) return;                // ~30 fps on phones
    const dt = Math.min(0.25, (now - (lastFrame || now)) / 1000); lastFrame = now;
    const wall = Date.now(), { hdg, pitch } = goalNow(wall);
    if (!have || cur.distanceTo(goal) > 4000) { cur.copy(goal); hdgCur = hdg; pitchCur = pitch; have = true; trailAt = 0; }
    else {
      cur.lerp(goal, 1 - Math.exp(-dt * 2.2));
      let dh = Math.atan2(Math.sin(hdg - hdgCur), Math.cos(hdg - hdgCur)); hdgCur += dh * (1 - Math.exp(-dt * 2));
      pitchCur += (pitch - pitchCur) * (1 - Math.exp(-dt * 2));
    }
    const c = T.cat || 'shahed'; setCat(COL[c] ? c : 'other', c === 'shahed' && /реактив/i.test(T.label || ''));
    const dist = camera.position.distanceTo(cur), L = LEN[c] || 3, s = realSize ? 1 : Math.max(1, dist * (c === 'fpv' ? 0.1 : 0.08) / L);
    ship.position.copy(cur); ship.rotation.set(pitchCur, Math.PI - hdgCur, 0, 'YXZ'); ship.scale.setScalar(s);
    if (c === 'shahed' || c === 'avia') ship.rotation.z = Math.sin(now / 900) * 0.05;     // a little roll: it is flying
    ship.traverse((o) => { if (o.userData.prop) o.rotation.z += dt * 40; });
    glow.position.copy(cur); glow.scale.setScalar(Math.max(L * s * 2.2, dist * 0.05)); glow.material.opacity = gone ? 0.15 : 0.55 + 0.2 * Math.sin(now / 260);
    const gy = groundY(cur.x, -cur.z);
    setLine(beam, [[cur.x, gy, cur.z], [cur.x, cur.y, cur.z]]);
    const rr = Math.max(20, dist * 0.03) * (1 + 0.25 * ((now / 1400) % 1)); ring.position.set(cur.x, gy + 1.5, cur.z); ring.scale.setScalar(rr); ring.material.opacity = 0.65 * (1 - (now / 1400) % 1) + 0.15;
    if (now - trailAt > 1500) { trailAt = now; const a = trail.geometry.attributes.position.array, n = trailN; if (!n || Math.hypot(a[n * 3 - 3] - cur.x, a[n * 3 - 1] - cur.z) > 8) trailPush(cur.clone()); }
    if (now - aheadAt > 1000) {
      aheadAt = now; const pts = [[cur.x, cur.y, cur.z]];
      for (const p of (M && M.ahead) || []) { if (pts.length >= 64) break; const [x, y] = xyOf(p[0], p[1]); pts.push([x, groundY(x, y) + altNow, -y]); }
      setLine(ahead, pts.length > 1 ? pts : []); ahead.material.dashSize = Math.max(40, dist * 0.02); ahead.material.gapSize = ahead.material.dashSize * 0.7;
    }
    if (now - uncAt > 2000) {
      uncAt = now; const km = (M && M.uncertKm) || 0, pts = [];
      if (km > 0.3 && M) for (let i = 0; i <= 96; i++) { const [a, o] = moveKm(M.lat, M.lon, i * 3.75, km), [x, y] = xyOf(a, o); pts.push([x, groundY(x, y) + 6, -y]); }
      setLine(unc, pts);
    }
    // the camera rides along; the viewer may orbit and zoom, a pan or a flight to a view lets go
    if (camFollow) {
      if (anim) setCam(false);
      else if (interacting && Math.hypot(controls.target.x - lastT.x, controls.target.z - lastT.z) > 3) setCam(false);
      else {
        const off = camera.position.clone().sub(controls.target);
        controls.target.copy(cur); camera.position.copy(cur).add(off);
        const fl = groundY(camera.position.x, -camera.position.z) + 8; if (camera.position.y < fl) camera.position.y = fl;
        if (lastT.distanceTo(cur) > 0.01 && now - uiAt > 900) { shadowDirty = true; renderer.shadowMap.needsUpdate = true; }
        lastT.copy(controls.target);
      }
    }
    // label above the model
    camera.updateMatrixWorld();
    const v = cur.clone().add(new THREE.Vector3(0, L * s * 0.45, 0)).project(camera);
    if (v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2) {
      lab.style.display = ''; lab.style.left = `${(v.x + 1) / 2 * innerWidth}px`; lab.style.top = `${(1 - v.y) / 2 * innerHeight}px`;
    } else lab.style.display = 'none';
    if (now - uiAt > 900) {
      uiAt = now; const name = T.label || CAT_UK[c] || 'Ціль', dir = DIRS[Math.round(((T.heading ?? hdgCur / D2R) % 360 + 360) % 360 / 45) % 8];
      panel.style.setProperty('--wa', `#${color.toString(16).padStart(6, '0')}`); lab.style.setProperty('--wa', `#${color.toString(16).padStart(6, '0')}`);
      $('waName').textContent = `👁 ${name}${T.n > 1 ? ` ×${T.n}` : ''}`;
      if (!gone && !handing) $('waStage').textContent = T.down ? 'збито' : T.stageLabel || '';
      const spd = T.kmh > 0 ? `${Math.round(T.kmh)} км/год` : '';
      $('waInfo').textContent = [T.place, M && M.orbit ? 'кружляє' : `курс ${dir}`, spd, fmtAlt(altNow)].filter(Boolean).join(' · ');
      const q = M ? M.quiet || 0 : 0;
      $('waAge').textContent = gone ? 'останнє відоме місце' : mode === 'static' ? 'точка з посилання' : q < 1 ? 'щойно з каналів' : `останній звіт ${Math.round(q)} хв тому${(M && M.uncertKm) > 0.3 ? ` · може бути в межах ${Math.round(M.uncertKm)} км` : ''}`;
      lab.innerHTML = ''; const b = document.createElement('b'); b.textContent = name; lab.append(b, document.createElement('br'), fmtAlt(altNow));
      handover();
    }
    invalidate();
  }
  return {
    on: true,
    get x() { return xyOf(T.lat, T.lon)[0]; }, get y() { return xyOf(T.lat, T.lon)[1]; },
    start() {                                        // after the first pack is in: place the model and the camera, start flying
      goalNow(Date.now()); cur.copy(goal); have = true; hdgCur = (T.heading || 0) * D2R;
      if (T.trail) seedTrail(T.trail);
      snapCam(T.cat === 'avia' ? 2500 : T.cat === 'fpv' ? 200 : 480);
      requestAnimationFrame(tick);
      if (ID) { setTimeout(poll, mode === 'push' ? 0 : 1500); setInterval(poll, 15000); }
    },
  };
})();
