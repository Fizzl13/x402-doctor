// x402 Trust City: the Trust Index as a night city, drawn in the browser with three.js. One tower per seller (the site
// behind its x402 endpoints), as tall as its number of endpoints on a log scale, its floors stacked by today's verdicts
// (go, caution, don't pay, unreachable). Lit windows in the verdict colour, a band of light round the roof of the taller
// towers, a red beacon on every seller with an endpoint not to pay, and light pulses running along the streets.
// Data: /api/trust/atlas (the same map as atlas.fizzl.eu). Built with textContent where text comes from sellers.
(() => {
  const $ = (id) => document.getElementById(id);
  const stage = $("stage"), canvas = $("city"), msg = $("msg");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fmt = (n) => Number(n).toLocaleString("en-GB");
  const KIDX = { g: 0, c: 1, n: 2, x: 3 };
  const KCOL = ["#19c08f", "#ffb627", "#ff3b30", "#5d6f6b"];
  // Per verdict: share of lit windows, window brightness, glow of the whole facade.
  const KPAR = [[0.32, 1.0, 0.0], [0.55, 1.15, 0.05], [0.78, 1.3, 0.16], [0.06, 0.45, 0.0]];
  const FOG = "#04171a";

  function webgl() {
    try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch { return false; }
  }
  function fail(text) { msg.hidden = false; msg.textContent = text; }

  addEventListener("DOMContentLoaded", () => {
    if (!window.THREE || !webgl()) return fail("This page needs WebGL. The same data is on the Trust Index page.");
    fetch("/api/trust/atlas").then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
      .then(build).catch(() => fail("The city could not be built right now. Try again in a minute."));
  });

  function build(DATA) {
    const THREE = window.THREE;
    const days = DATA.days, D = days.length, d = D - 1, sellers = DATA.sellers;
    const S = sellers.length;
    const sc = new Uint32Array(S * 4);
    for (const [si, h] of DATA.endpoints) { const k = KIDX[(h || "")[d]]; if (k !== undefined) sc[si * 4 + k]++; }
    for (const [si, perDay] of DATA.seller_days || []) sc.set(perDay[d], si * 4);
    const total = (i) => sc[i * 4] + sc[i * 4 + 1] + sc[i * 4 + 2] + sc[i * 4 + 3];
    const order = [...Array(S).keys()].filter((i) => total(i) > 0).sort((a, b) => total(b) - total(a) || (sellers[a][0] < sellers[b][0] ? -1 : 1));
    const N = order.length;
    const dayName = new Date(days[d] + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

    let endpoints = 0, nogo = 0, nogoSellers = 0;
    for (const i of order) { endpoints += total(i); nogo += sc[i * 4 + 2]; if (sc[i * 4 + 2]) nogoSellers++; }
    const stats = $("stats");
    stats.replaceChildren();
    const add = (t, cls) => { const b = document.createElement("b"); b.textContent = t; if (cls) b.className = cls; stats.append(b); };
    add(fmt(N)); stats.append(" sellers · "); add(fmt(endpoints)); stats.append(" paid endpoints · ");
    add(fmt(nogo), "red"); stats.append(" a careful agent won't pay · scan of " + dayName);

    // Grid cells sorted by distance from the centre: the biggest sellers get the middle.
    const side = Math.ceil(Math.sqrt(N)) + 2;
    const cells = [];
    for (let x = 0; x < side; x++) for (let z = 0; z < side; z++) cells.push([x - side / 2, z - side / 2]);
    cells.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]) || a[0] - b[0] || a[1] - b[1]);
    const height = (t) => 0.12 + 1.6 * Math.pow(Math.log10(t + 1), 1.6);

    // ---------------------------------------------------------------- renderer, scene, camera
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setClearColor(0x000000, 0);
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(FOG, side * 0.35, side * 1.45);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, side * 6);
    camera.position.set(-side * 0.36, side * 0.2, side * 0.46);
    const controls = new THREE.OrbitControls(camera, canvas);
    controls.target.set(0, 2.6, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 3;
    controls.maxDistance = side * 1.5;
    controls.maxPolarAngle = Math.PI * 0.47;
    controls.autoRotate = !reduced;
    controls.autoRotateSpeed = 0.35;
    controls.update();
    const stopAuto = () => { controls.autoRotate = false; };
    canvas.addEventListener("pointerdown", stopAuto);
    canvas.addEventListener("wheel", stopAuto, { passive: true });

    const fogUniforms = { fogColor: { value: new THREE.Color(FOG) }, fogNear: { value: scene.fog.near }, fogFar: { value: scene.fog.far } };
    const time = { value: 0 };

    // ---------------------------------------------------------------- towers: one instanced box per verdict floor
    const segs = [];   // [x, z, y0, y1, foot, kind, seller]
    const crowns = []; // [x, z, y, foot, kind]
    const beacons = []; const tips = [];
    const top = new Map(); // seller -> [x, z, height]
    const rnd = (() => { let s = 402; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
    order.forEach((si, n) => {
      const [x, z] = cells[n];
      const t = total(si), h = height(t), foot = h < 4 ? 0.6 : 0.66;
      let y = 0, topKind = 3;
      for (let k = 0; k < 4; k++) {
        const c = sc[si * 4 + k];
        if (!c) continue;
        const dy = (h * c) / t;
        segs.push([x, z, y, y + dy, foot, k, si]);
        y += dy; topKind = k;
      }
      top.set(si, [x, z, h]);
      if (h > 1.5) crowns.push([x, z, h, foot, topKind]);
      if (sc[si * 4 + 2]) beacons.push([x, h + 0.14, z, 1 + Math.min(1, sc[si * 4 + 2] / t)]);
      if (n < 60 && h > 3) { const mh = (0.5 + rnd() * 0.9) * (1 + h / 15); tips.push([x + (rnd() - 0.5) * 0.24, h + mh, z + (rnd() - 0.5) * 0.24, mh]); }
    });

    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const towerMat = new THREE.ShaderMaterial({
      uniforms: { ...fogUniforms, uHi: { value: -1 } },
      vertexShader: `
        attribute vec3 aCol; attribute vec3 aPar; attribute float aId;
        varying vec3 vWorld; varying vec3 vN; varying vec3 vCol; varying vec3 vPar; varying float vDepth; varying float vHi;
        uniform float uHi;
        void main() {
          vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vWorld = w.xyz; vN = normal; vCol = aCol; vPar = aPar;
          vHi = abs(aId - uHi) < 0.5 ? 1.0 : 0.0;
          vec4 mv = viewMatrix * w; vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 fogColor; uniform float fogNear; uniform float fogFar;
        varying vec3 vWorld; varying vec3 vN; varying vec3 vCol; varying vec3 vPar; varying float vDepth; varying float vHi;
        float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        void main() {
          vec3 n = normalize(vN);
          float side = 1.0 - abs(n.y);
          float u = abs(n.x) * vWorld.z + abs(n.z) * vWorld.x;
          float uc = u * 13.0, zr = vWorld.y * 9.0;
          vec2 f = fract(vec2(uc, zr));
          float inside = step(0.16, f.x) * step(f.x, 0.84) * step(0.22, f.y) * step(f.y, 0.78) * side;
          vec3 cell = vec3(floor(uc), floor(zr), floor(vWorld.x + 0.5) * 7.31 + floor(vWorld.z + 0.5) * 3.17 + n.x * 0.37 + n.z * 0.71);
          float r = hash(cell);
          float win = inside * step(1.0 - vPar.x, r) * (0.45 + 0.75 * r);
          // Far away the window grid would shimmer: fade to its average brightness.
          float far = smoothstep(0.35, 0.9, max(fwidth(uc), fwidth(zr)));
          win = mix(win, vPar.x * 0.36 * 0.85 * side, far);
          float light = 0.35 + 0.65 * max(dot(n, normalize(vec3(-0.45, 0.8, 0.35))), 0.0);
          vec3 base = (vCol * 0.07 + 0.012) * light;
          float band = step(f.y, 0.07) * side * 0.06;
          vec3 col = base + vCol * (win * vPar.y + vPar.z + band);
          col = mix(col, col * 1.6 + vec3(0.12), vHi * 0.6);
          float fogF = smoothstep(fogNear, fogFar, vDepth);
          gl_FragColor = vec4(mix(col, fogColor, fogF), 1.0);
        }`,
      fog: false,
    });
    towerMat.extensions = { derivatives: true };
    const towers = new THREE.InstancedMesh(box, towerMat, segs.length);
    const aCol = new Float32Array(segs.length * 3), aPar = new Float32Array(segs.length * 3), aId = new Float32Array(segs.length);
    const m = new THREE.Matrix4(), col = new THREE.Color();
    const segSeller = new Int32Array(segs.length);
    segs.forEach(([x, z, y0, y1, foot, k, si], i) => {
      m.makeScale(foot, y1 - y0, foot); m.setPosition(x, y0, z);
      towers.setMatrixAt(i, m);
      col.set(KCOL[k]); aCol.set([col.r, col.g, col.b], i * 3); aPar.set(KPAR[k], i * 3);
      aId[i] = si; segSeller[i] = si;
    });
    box.setAttribute("aCol", new THREE.InstancedBufferAttribute(aCol, 3));
    box.setAttribute("aPar", new THREE.InstancedBufferAttribute(aPar, 3));
    box.setAttribute("aId", new THREE.InstancedBufferAttribute(aId, 1));
    towers.instanceMatrix.needsUpdate = true;
    scene.add(towers);

    // Bands of light round the roof edge: the four sides of a thin box, no top (a lit top reads as a white tile).
    const ringGeo = new THREE.BoxGeometry(1, 1, 1);
    ringGeo.translate(0, 0.5, 0);
    const idx = ringGeo.index.array, keep = [];
    ringGeo.groups.forEach((g, gi) => { if (gi !== 2 && gi !== 3) for (let j = g.start; j < g.start + g.count; j++) keep.push(idx[j]); });
    ringGeo.setIndex(keep); ringGeo.clearGroups();
    const ringMat = new THREE.MeshBasicMaterial({ fog: true });
    const rings = new THREE.InstancedMesh(ringGeo, ringMat, Math.max(1, crowns.length));
    const CROWN = ["#61f5c3", "#ffc85a", "#ff5a4f", "#8fa39e"];
    crowns.forEach(([x, z, y, foot, k], i) => {
      m.makeScale(foot + 0.012, 0.03, foot + 0.012); m.setPosition(x, y - 0.012, z);
      rings.setMatrixAt(i, m); rings.setColorAt(i, col.set(CROWN[k]));
    });
    rings.count = crowns.length;
    scene.add(rings);

    // Plinths under every tower.
    const plinths = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ color: "#0a1513", fog: true }), N);
    order.forEach((si, n) => { const [x, z] = cells[n]; m.makeScale(0.86, 0.035, 0.86); m.setPosition(x, 0, z); plinths.setMatrixAt(n, m); });
    scene.add(plinths);

    // ---------------------------------------------------------------- lights: red beacons and white antenna tips
    const glowMat = (pulse) => new THREE.ShaderMaterial({
      uniforms: { uTime: time, uScale: { value: 1 }, ...fogUniforms },
      vertexShader: `
        attribute float aSize; attribute float aPhase; uniform float uTime; uniform float uScale; varying float vA; varying float vDepth;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float blink = ${pulse};
          vA = blink; vDepth = -mv.z;
          gl_PointSize = aSize * uScale * (0.6 + 0.4 * blink) / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 color; uniform vec3 fogColor; uniform float fogNear; uniform float fogFar; varying float vA; varying float vDepth;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float core = smoothstep(0.35, 0.0, d), halo = pow(max(0.0, 1.0 - d), 2.2) * 0.55;
          float a = (core + halo) * (0.35 + 0.65 * vA) * (1.0 - smoothstep(fogNear, fogFar * 1.1, vDepth) * 0.85);
          gl_FragColor = vec4(mix(color, vec3(1.0), core * 0.55) * a, a);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    function points(list, hex, size, pulse) {
      const g = new THREE.BufferGeometry();
      const pos = new Float32Array(list.length * 3), sz = new Float32Array(list.length), ph = new Float32Array(list.length);
      list.forEach((p, i) => { pos.set([p[0], p[1], p[2]], i * 3); sz[i] = size * (p[3] || 1); ph[i] = rnd() * 6.283; });
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("aSize", new THREE.BufferAttribute(sz, 1));
      g.setAttribute("aPhase", new THREE.BufferAttribute(ph, 1));
      const mat = glowMat(reduced ? "1.0" : pulse);
      mat.uniforms.color = { value: new THREE.Color(hex) };
      const p = new THREE.Points(g, mat);
      scene.add(p);
      return mat;
    }
    const glows = [
      points(beacons, "#ff2a1f", 900, "0.5 + 0.5 * sin(uTime * 2.4 + aPhase)"),
      points(tips, "#ffffff", 520, "step(0.55, fract(uTime * 0.8 + aPhase))"),
    ];
    // antennas
    if (tips.length) {
      const masts = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ color: "#33403d", fog: true }), tips.length);
      tips.forEach(([x, y, z, mh], i) => { m.makeScale(0.025, mh, 0.025); m.setPosition(x, y - mh, z); masts.setMatrixAt(i, m); });
      scene.add(masts);
    }

    // ---------------------------------------------------------------- wet street with light pulses along the lanes
    const groundMat = new THREE.ShaderMaterial({
      uniforms: { uTime: time, uSide: { value: side }, ...fogUniforms },
      vertexShader: `varying vec3 vWorld; varying float vDepth;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; vec4 mv = viewMatrix * w; vDepth = -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        uniform float uTime; uniform float uSide; uniform vec3 fogColor; uniform float fogNear; uniform float fogFar;
        varying vec3 vWorld; varying float vDepth;
        float h1(float n) { return fract(sin(n * 127.1) * 43758.5453); }
        float lane(float c) { float d = abs(fract(c) - 0.5); float w = fwidth(c) * 0.9; return 1.0 - smoothstep(0.012, 0.012 + w, d); }
        float pulses(float along, float across) {
          float id = floor(across); float r = h1(id + 3.0);
          float dir = r > 0.5 ? 1.0 : -1.0; float speed = 1.2 + 2.4 * r;
          float ph = fract(along * 0.11 + r * 9.0 + uTime * speed * dir * 0.11);
          return pow(ph, 40.0);
        }
        void main() {
          float lx = lane(vWorld.x), lz = lane(vWorld.z);
          float glow = lx * (0.08 + 1.4 * pulses(vWorld.z, vWorld.x)) + lz * (0.08 + 1.4 * pulses(vWorld.x, vWorld.z));
          float fade = 1.0 - smoothstep(uSide * 0.35, uSide * 0.8, length(vWorld.xz));
          vec3 col = vec3(0.008, 0.02, 0.022) + vec3(0.38, 0.96, 0.76) * glow * fade;
          // a wet sheen under the centre of the city
          col += vec3(0.02, 0.07, 0.06) * (1.0 - smoothstep(0.0, uSide * 0.6, length(vWorld.xz)));
          float fogF = smoothstep(fogNear, fogFar, vDepth);
          gl_FragColor = vec4(mix(col, fogColor, fogF), 1.0);
        }`,
    });
    groundMat.extensions = { derivatives: true };
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(side * 6, side * 6), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.001;
    scene.add(ground);

    // ---------------------------------------------------------------- labels for the tallest towers and fizzl.eu
    const labelsEl = $("labels");
    const labels = [];
    const HOME = sellers.findIndex((s) => s[0] === "fizzl.eu");
    const named = order.slice(0, 4);
    if (HOME >= 0 && top.has(HOME) && !named.includes(HOME)) named.push(HOME);
    for (const si of named) {
      const [x, z, h] = top.get(si);
      const el = Object.assign(document.createElement("button"), { type: "button", className: "label" + (si === HOME ? " home" : ""), textContent: sellers[si][0] });
      el.addEventListener("click", () => select(si, true));
      labelsEl.appendChild(el);
      labels[si === HOME ? "unshift" : "push"]({ el, p: new THREE.Vector3(x, h + 0.55, z) });
    }

    // ---------------------------------------------------------------- picking, card, search
    const ray = new THREE.Raycaster(), mouse = new THREE.Vector2(), tip = $("tip");
    let hoverSeller = -1, selected = -1;
    function pick(ev) {
      const r = canvas.getBoundingClientRect();
      mouse.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(mouse, camera);
      const hit = ray.intersectObject(towers, false)[0];
      return hit && hit.instanceId !== undefined ? segSeller[hit.instanceId] : -1;
    }
    const counts = (si) => [0, 1, 2, 3].map((k) => sc[si * 4 + k]);
    canvas.addEventListener("pointermove", (ev) => {
      if (ev.pointerType !== "mouse") return;
      const si = pick(ev);
      hoverSeller = si;
      towerMat.uniforms.uHi.value = selected >= 0 ? selected : si;
      if (si < 0) { tip.hidden = true; canvas.style.cursor = ""; return; }
      canvas.style.cursor = "pointer";
      const [g, c, n] = counts(si);
      tip.textContent = `${sellers[si][0]} · ${fmt(total(si))} endpoints · ${fmt(g)} go, ${fmt(c)} caution, ${fmt(n)} don't pay`;
      const r = stage.getBoundingClientRect();
      tip.style.left = Math.min(ev.clientX - r.left + 14, r.width - 280) + "px";
      tip.style.top = ev.clientY - r.top + 14 + "px";
      tip.hidden = false;
    });
    canvas.addEventListener("pointerleave", () => { tip.hidden = true; if (selected < 0) towerMat.uniforms.uHi.value = -1; });
    let down = null;
    canvas.addEventListener("pointerdown", (ev) => { down = [ev.clientX, ev.clientY]; });
    canvas.addEventListener("pointerup", (ev) => {
      if (!down || Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) > 6) return;
      const si = pick(ev);
      if (si >= 0) select(si, false); else closeCard();
    });

    const card = $("card");
    let fly = null;
    function select(si, flyTo) {
      selected = si;
      towerMat.uniforms.uHi.value = si;
      const [g, c, n, u] = counts(si);
      $("cHost").textContent = sellers[si][0];
      const cat = DATA.categories[sellers[si][1]];
      $("cMeta").textContent = `${cat ? cat.name : "Other"} · ${fmt(total(si))} endpoint${total(si) === 1 ? "" : "s"} · ${dayName}`;
      $("cGo").textContent = fmt(g); $("cCa").textContent = fmt(c); $("cNo").textContent = fmt(n); $("cUn").textContent = fmt(u);
      $("cEps").replaceChildren(); $("cNote").textContent = ""; $("cEpsBtn").hidden = false;
      card.hidden = false;
      controls.autoRotate = false;
      if (flyTo) {
        const [x, z, h] = top.get(si);
        const to = new THREE.Vector3(x, Math.min(h * 0.6, 6), z);
        const dir = camera.position.clone().sub(controls.target).normalize();
        const dist = Math.max(6, h * 1.6 + 4);
        fly = { t: 0, fromT: controls.target.clone(), toT: to, fromP: camera.position.clone(), toP: to.clone().add(dir.multiplyScalar(dist)) };
      }
    }
    function closeCard() { card.hidden = true; selected = -1; towerMat.uniforms.uHi.value = hoverSeller; }
    $("cardClose").addEventListener("click", closeCard);
    $("cEpsBtn").addEventListener("click", async () => {
      const si = selected; if (si < 0) return;
      $("cEpsBtn").hidden = true; $("cNote").textContent = "Loading the endpoints…";
      let data = null;
      try { const r = await fetch(`/api/trust/seller?host=${encodeURIComponent(sellers[si][0])}`); data = r.ok ? await r.json() : null; } catch { data = null; }
      if (selected !== si) return;
      if (!data || !Array.isArray(data.endpoints)) { $("cNote").textContent = "The endpoints could not be loaded right now."; $("cEpsBtn").hidden = false; return; }
      const SHOW = 30;
      $("cEps").replaceChildren(...data.endpoints.slice(0, SHOW).map((e) => {
        const li = document.createElement("li");
        const dot = Object.assign(document.createElement("i"), { className: `v-${e.verdict}`, title: e.verdict });
        const a = Object.assign(document.createElement("a"), { href: `/?url=${encodeURIComponent(e.url)}`, target: "_blank", rel: "noopener", textContent: String(e.url).replace(/^https?:\/\//, "") });
        li.append(dot, a);
        return li;
      }));
      $("cNote").textContent = (data.endpoints.length > SHOW ? `And ${fmt(data.endpoints.length - SHOW)} more. ` : "") + "Each link opens x402 Doctor's free check of that endpoint, never the endpoint itself.";
    });
    $("find").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const q = $("q").value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
      if (!q) return;
      const si = order.find((i) => sellers[i][0] === q) ?? order.find((i) => sellers[i][0].endsWith("." + q) || q.endsWith("." + sellers[i][0])) ?? order.find((i) => sellers[i][0].includes(q));
      if (si === undefined) { $("stats").dataset.miss = q; msgFlash(`No seller "${q}" in today's scan. x402 Doctor can still check any endpoint.`); return; }
      select(si, true);
    });
    let flashTimer = 0;
    function msgFlash(text) { msg.hidden = false; msg.textContent = text; msg.style.pointerEvents = "none"; clearTimeout(flashTimer); flashTimer = setTimeout(() => { msg.hidden = true; }, 3200); }

    // ---------------------------------------------------------------- size, run only while visible
    function resize() {
      const w = stage.clientWidth, h = stage.clientHeight;
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      renderer.setSize(w, h, false);
      camera.aspect = w / h; camera.updateProjectionMatrix();
      const s = (h * Math.min(devicePixelRatio || 1, 2)) / 900;
      glows.forEach((g) => { g.uniforms.uScale.value = s; });
    }
    resize();
    addEventListener("resize", resize);
    let visible = true;
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(stage);
    const clock = new THREE.Clock();
    const v = new THREE.Vector3();
    function frame() {
      requestAnimationFrame(frame);
      if (!visible || document.hidden) { clock.getDelta(); return; }
      const dt = Math.min(clock.getDelta(), 0.1);
      if (!reduced) time.value += dt;
      if (fly) {
        fly.t = Math.min(1, fly.t + dt / 1.4);
        const e = fly.t < 0.5 ? 2 * fly.t * fly.t : 1 - Math.pow(-2 * fly.t + 2, 2) / 2;
        controls.target.lerpVectors(fly.fromT, fly.toT, e);
        camera.position.lerpVectors(fly.fromP, fly.toP, e);
        if (fly.t >= 1) fly = null;
      }
      controls.update();
      renderer.render(scene, camera);
      const w = stage.clientWidth, h = stage.clientHeight;
      // Labels nearest the camera first; one that would overlap a label already placed stays hidden.
      const placed = [];
      for (const l of labels) {
        v.copy(l.p).project(camera);
        const x = ((v.x + 1) / 2) * w, y = ((1 - v.y) / 2) * h;
        let on = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
        if (on) for (const [px, py] of placed) if (Math.abs(px - x) < 150 && Math.abs(py - y) < 22) { on = false; break; }
        l.el.hidden = !on;
        if (on) { placed.push([x, y]); l.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`; }
      }
    }
    msg.hidden = true;
    frame();
  }
})();
