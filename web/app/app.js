(function () {
  'use strict';
  const T = window.THREE,
    $ = (s) => document.querySelector(s),
    $$ = (s) => Array.from(document.querySelectorAll(s));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v)),
    lerp = (a, b, f) => a + (b - a) * f;
  const bell = (t, m, s) => {
    let d = Math.abs(t - m);
    d = Math.min(d, 24 - d);
    return Math.exp((-d * d) / (2 * s * s));
  };
  const fmtN = (n) => Math.round(n).toLocaleString('en-IN');
  const fmtKW = (k) => (k >= 1000 ? (k / 1000).toFixed(2) + ' MW' : Math.round(k) + ' kW');
  const hhmm = (h) =>
    String(Math.floor(h)).padStart(2, '0') +
    ':' +
    String(Math.floor(((h % 1) * 60) / 5) * 5).padStart(2, '0');
  const Bus = {
    h: {},
    on(e, f) {
      (this.h[e] = this.h[e] || []).push(f);
    },
    emit(e, p) {
      (this.h[e] || []).forEach((f) => f(p));
    },
  };
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const app = $('#app');
  /* Embed mode (?embed=1&campus=mujaipur): the scene alone, no interface, playing a day on a loop. Used behind the landing page's headline. */
  const Q = new URLSearchParams(location.search),
    EMBED = Q.has('embed');
  if (EMBED) document.documentElement.classList.add('embed');
  if (!T || !T.EffectComposer) {
    app.insertAdjacentHTML(
      'beforeend',
      '<div class="fail">The 3D libraries could not load, so the campus cannot render here.</div>',
    );
    return;
  }

  /* ---------- context and environment ---------- */
  const Ctx = {
    t: 19.5,
    day: 'weekday',
    mask: 31,
    playing: false,
    sel: -1,
    hov: -1,
    tab: 'insp',
    health: 'ok',
    campus: 'all',
  };
  const cool = (h) => clamp(bell(h, 15, 4) + 0.85 * bell(h, 22, 3), 0, 1);
  const carbon = (h) =>
    clamp(0.55 - 0.4 * bell(h, 12.5, 3) + 0.42 * bell(h, 20, 1.8) - 0.12 * bell(h, 3, 2.5), 0, 1);
  const sunEl = (h) => (h >= 6 && h <= 18 ? Math.sin((Math.PI * (h - 6)) / 12) : 0);
  const ci = (h) => 450 + 450 * carbon(h);

  /* ---------- declarative model library: archetypes, shapes, campaigns ---------- */
  const COMP = ['cool', 'light', 'plug', 'hot'];
  const ARCH = {
    hostel: {
      label: 'Hostel',
      v: 2,
      kwm2: 0.014,
      mix: [0.5, 0.15, 0.22, 0.13],
      we: { k: 1, boost: 0.14, mid: 13 },
    },
    academic: {
      label: 'Academic block',
      v: 3,
      kwm2: 0.02,
      mix: [0.45, 0.25, 0.25, 0.05],
      we: { k: 0.3, boost: 0, mid: 13 },
    },
    library: {
      label: 'Library',
      v: 1,
      kwm2: 0.02,
      mix: [0.4, 0.25, 0.3, 0.05],
      we: { k: 0.8, boost: 0, mid: 15 },
    },
    hall: {
      label: 'Auditorium',
      v: 1,
      kwm2: 0.03,
      mix: [0.45, 0.3, 0.22, 0.03],
      we: { k: 0.4, boost: 0, mid: 14 },
    },
    mess: {
      label: 'Mess',
      v: 2,
      kwm2: 0.05,
      mix: [0.15, 0.15, 0.3, 0.4],
      we: { k: 0.95, boost: 0.05, mid: 13 },
    },
    sports: {
      label: 'Sports complex',
      v: 1,
      kwm2: 0.02,
      mix: [0.4, 0.3, 0.15, 0.15],
      we: { k: 1.25, boost: 0.1, mid: 17 },
    },
    chiller: {
      label: 'Chiller plant',
      v: 1,
      kwFixed: 520,
      mix: [0.9, 0.04, 0.06, 0],
      we: { k: 0.8, boost: 0.05, mid: 15 },
    },
    residence: {
      label: 'Residence',
      v: 1,
      kwm2: 0.012,
      mix: [0.45, 0.15, 0.27, 0.13],
      we: { k: 1.05, boost: 0.1, mid: 13 },
    },
    lab: {
      label: 'Research lab',
      v: 1,
      kwm2: 0.035,
      mix: [0.3, 0.2, 0.48, 0.02],
      we: { k: 0.45, boost: 0, mid: 14 },
    },
    service: {
      label: 'Services',
      v: 1,
      kwm2: 0.015,
      mix: [0.4, 0.3, 0.25, 0.05],
      we: { k: 0.5, boost: 0, mid: 12 },
    },
    unclassified: {
      label: 'Unclassified',
      v: 1,
      kwm2: 0.008,
      mix: [0.35, 0.3, 0.3, 0.05],
      we: { k: 0.6, boost: 0, mid: 12 },
    },
  };
  const SH = {
    hostel: {
      cool: [
        0.12,
        [
          [0.55, 22, 3.2],
          [0.25, 15, 3.5],
        ],
      ],
      light: [
        0.1,
        [
          [0.8, 20, 2.2],
          [0.5, 6.5, 1.2],
        ],
      ],
      plug: [
        0.3,
        [
          [0.45, 21, 3],
          [0.3, 8, 1.5],
        ],
      ],
      hot: [
        0.05,
        [
          [0.9, 6.5, 1.1],
          [0.6, 21, 1.4],
        ],
      ],
    },
    academic: {
      cool: [0.1, [[0.8, 13.5, 3.6]]],
      light: [0.1, [[0.85, 12.5, 3.4]]],
      plug: [0.18, [[0.7, 13, 3.6]]],
      hot: [0.05, [[0.3, 12, 3]]],
    },
    library: {
      cool: [0.12, [[0.6, 15, 5]]],
      light: [0.15, [[0.8, 15, 5]]],
      plug: [
        0.2,
        [
          [0.7, 16, 5],
          [0.25, 21, 2],
        ],
      ],
      hot: [0.05, [[0.2, 12, 3]]],
    },
    hall: {
      cool: [0.05, [[0.9, 14, 3]]],
      light: [0.05, [[0.9, 14, 3]]],
      plug: [0.1, [[0.7, 14, 3]]],
      hot: [0.02, [[0.2, 13, 3]]],
    },
    mess: {
      cool: [0.1, [[0.3, 13, 3]]],
      light: [
        0.1,
        [
          [0.6, 8, 1.2],
          [0.8, 13, 1.4],
          [0.9, 20, 1.4],
        ],
      ],
      plug: [
        0.15,
        [
          [0.7, 8, 1],
          [0.9, 13.2, 1.2],
          [0.9, 20.2, 1.3],
        ],
      ],
      hot: [
        0.1,
        [
          [0.8, 7.5, 1.2],
          [0.9, 12.5, 1.3],
          [0.9, 19.5, 1.4],
        ],
      ],
    },
    sports: {
      cool: [0.1, [[0.5, 18, 3]]],
      light: [0.1, [[0.8, 18, 3]]],
      plug: [0.12, [[0.4, 18, 3]]],
      hot: [0.08, [[0.7, 19, 2]]],
    },
    chiller: {
      cool: [
        0.18,
        [
          [0.8, 15, 4.5],
          [0.5, 22, 3.2],
        ],
      ],
      light: [0.3, []],
      plug: [0.3, []],
      hot: [0, []],
    },
    residence: {
      cool: [
        0.14,
        [
          [0.55, 21.5, 3],
          [0.2, 14, 3],
        ],
      ],
      light: [
        0.1,
        [
          [0.7, 20, 2.2],
          [0.4, 7, 1.3],
        ],
      ],
      plug: [
        0.25,
        [
          [0.5, 20.5, 2.6],
          [0.3, 7, 1.5],
        ],
      ],
      hot: [
        0.05,
        [
          [0.8, 6.8, 1.1],
          [0.5, 20.5, 1.5],
        ],
      ],
    },
    lab: {
      cool: [0.2, [[0.6, 14, 4]]],
      light: [0.2, [[0.7, 13, 4]]],
      plug: [0.4, [[0.5, 14, 4]]],
      hot: [0.03, []],
    },
    service: {
      cool: [0.1, [[0.8, 13, 4]]],
      light: [0.1, [[0.8, 12.5, 4]]],
      plug: [0.18, [[0.7, 13, 4]]],
      hot: [0.03, [[0.3, 12, 3]]],
    },
    unclassified: {
      cool: [0.1, [[0.7, 13, 4]]],
      light: [0.1, [[0.8, 12.5, 4]]],
      plug: [0.15, [[0.6, 13, 4]]],
      hot: [0.03, [[0.3, 12, 3]]],
    },
  };
  const shape = (arch, comp, h) => {
    const s = SH[arch][comp];
    let v = s[0];
    for (const b of s[1]) v += b[0] * bell(h, b[1], b[2]);
    if (comp === 'cool' && arch !== 'chiller') v *= 0.6 + 0.4 * cool(h);
    return clamp(v, 0, 1);
  };
  const dayFactor = (A, h, day) => (day === 'weekend' ? A.we.k + A.we.boost * bell(h, A.we.mid, 4) : 1);
  const PROF = {
    flat: () => 1,
    cool: cool,
    away: (h) => 1 - bell(h, 13, 4),
    eve: (h) => bell(h, 20, 2),
    mid: (h) => bell(h, 13, 2.5),
    day: (h) => bell(h, 13, 3.5),
  };
  const ALLK = [
    'hostel',
    'residence',
    'academic',
    'library',
    'hall',
    'sports',
    'lab',
    'chiller',
    'service',
    'unclassified',
  ];
  const CAMP = [
    {
      key: 'ac26',
      label: 'Set it to 26',
      note: 'Raise AC setpoints, and the chilled-water setpoint at the plant.',
      txt: 'Cuts cooling by 9–20%.',
      eff: [{ kinds: ALLK, comp: 'cool', cut: [0.09, 0.15, 0.2], prof: 'cool' }],
    },
    {
      key: 'away',
      label: 'Lights and fans off',
      note: 'Switch off lights and fans in empty rooms and corridors.',
      txt: 'Cuts lighting by 10–25% in teaching buildings and 6–16% in hostels and homes.',
      eff: [
        {
          kinds: ['academic', 'library', 'hall', 'lab'],
          comp: 'light',
          cut: [0.1, 0.18, 0.25],
          prof: 'away',
        },
        { kinds: ['hostel', 'residence'], comp: 'light', cut: [0.06, 0.12, 0.16], prof: 'day' },
      ],
    },
    {
      key: 'shift',
      label: 'Shift the peak',
      note: 'Run geysers outside the evening carbon peak.',
      txt: 'Moves 10–26% of water heating to midday.',
      eff: [
        {
          kinds: ['hostel', 'residence', 'mess'],
          comp: 'hot',
          cut: [0.1, 0.18, 0.26],
          prof: 'eve',
          shiftTo: 'mid',
        },
      ],
    },
    {
      key: 'standby',
      label: 'Standby purge',
      note: 'Switch off idle chargers, TVs and computers.',
      txt: 'Cuts plug loads by 3–9%.',
      eff: [{ kinds: '*', comp: 'plug', cut: [0.03, 0.06, 0.09], prof: 'flat' }],
    },
    {
      key: 'swap',
      label: 'Efficient swap',
      note: 'Replace old ACs and fans with star-rated ones. The old units become e-waste.',
      txt: 'Cuts cooling by 4–12% and lighting by 4–10%.',
      eff: [
        { kinds: ALLK, comp: 'cool', cut: [0.04, 0.08, 0.12], prof: 'cool' },
        { kinds: '*', comp: 'light', cut: [0.04, 0.07, 0.1], prof: 'flat' },
      ],
    },
  ];
  const applies = (e, arch) => e.kinds === '*' || e.kinds.indexOf(arch) >= 0;

  /* ---------- asset registry (the single source of truth for what exists) ---------- */
  const Registry = {
    assets: [],
    byId: new Map(),
    version: 0,
    add(a) {
      a.idx = this.assets.length;
      a.rev = a.rev || 1;
      a.id = a.id || 'ast_' + String(a.idx).padStart(4, '0');
      a.floors = a.floors || Math.max(1, Math.round(a.h / 3.4));
      const A = ARCH[a.arch];
      if (!a.poly)
        a.poly = [
          [a.x - a.w / 2, a.z - a.d / 2],
          [a.x + a.w / 2, a.z - a.d / 2],
          [a.x + a.w / 2, a.z + a.d / 2],
          [a.x - a.w / 2, a.z + a.d / 2],
        ];
      if (!a.area) {
        let s2 = 0;
        const P = a.poly;
        for (let i = 0; i < P.length; i++) {
          const p = P[i],
            q = P[(i + 1) % P.length];
          s2 += p[0] * q[1] - q[0] * p[1];
        }
        a.area = Math.abs(s2) / 2;
      }
      a.kwPeak = A.kwFixed || A.kwm2 * a.area * a.floors;
      a.campus = a.campus || 'iitgn';
      this.assets.push(a);
      this.byId.set(a.id, a);
      this.version++;
      return a;
    },
    overlaps(x, z, w, d) {
      for (const a of this.assets) {
        if (Math.abs(a.x - x) < (a.w + w) / 2 + 1 && Math.abs(a.z - z) < (a.d + d) / 2 + 1) return a;
      }
      return null;
    },
  };

  /* ---------- simulation service: pure per-asset function, memoised, with incremental totals ---------- */
  const Sim = {
    mem: new Map(),
    tot: new Map(),
    order: [],
    hits: 0,
    miss: 0,
    lastMs: 0,
    key(m, d) {
      return m + '|' + d;
    },
    touch(k) {
      const i = this.order.indexOf(k);
      if (i >= 0) this.order.splice(i, 1);
      this.order.push(k);
      while (this.order.length > 6) {
        const o = this.order.shift();
        this.mem.delete(o);
        [...this.tot.keys()].forEach((x) => {
          if (x.indexOf(o + '|') === 0) this.tot.delete(x);
        });
      }
    },
    compute(a, mask, day) {
      const A = ARCH[a.arch],
        out = new Float32Array(96),
        kp = a.kwPeak * (a.calib || 1);
      for (let h = 0; h < 24; h++) {
        const base = COMP.map((c, i) => shape(a.arch, c, h) * A.mix[i]),
          wf = dayFactor(A, h, day);
        out[h] = base.reduce((x, y) => x + y, 0) * wf * kp;
        for (let l = 0; l < 3; l++) {
          const c = base.slice();
          for (let i = 0; i < CAMP.length; i++) {
            if (!((mask >> i) & 1)) continue;
            for (const e of CAMP[i].eff) {
              if (!applies(e, a.arch)) continue;
              const ci2 = COMP.indexOf(e.comp);
              let m = 1 - e.cut[l] * PROF[e.prof](h);
              if (e.shiftTo) m += 0.5 * e.cut[l] * PROF[e.shiftTo](h);
              c[ci2] *= m;
            }
          }
          out[24 + (2 - l) * 24 + h] = c.reduce((x, y) => x + y, 0) * wf * kp;
        }
      }
      return out;
    },
    get(a, mask = Ctx.mask, day = Ctx.day) {
      const k = this.key(mask, day);
      let m = this.mem.get(k);
      if (!m) {
        m = new Map();
        this.mem.set(k, m);
      }
      this.touch(k);
      let v = m.get(a.idx);
      if (v && v.rev === a.rev) {
        this.hits++;
        return v.arr;
      }
      this.miss++;
      const arr = this.compute(a, mask, day);
      m.set(a.idx, { rev: a.rev, arr });
      return arr;
    },
    totals(mask = Ctx.mask, day = Ctx.day, campus = Ctx.campus) {
      const k = this.key(mask, day) + '|' + campus;
      let t = this.tot.get(k);
      if (!t) {
        const t0 = performance.now();
        t = new Float64Array(96);
        for (const a of Registry.assets) {
          if (campus !== 'all' && a.campus !== campus) continue;
          const x = this.get(a, mask, day);
          for (let i = 0; i < 96; i++) t[i] += x[i];
        }
        this.tot.set(k, t);
        if (this.tot.size > 24) this.tot.delete(this.tot.keys().next().value);
        this.lastMs = performance.now() - t0;
      }
      return t;
    },
    onAdded(list) {
      const t0 = performance.now();
      this.tot.forEach((t, k) => {
        const p = k.split('|');
        for (const a of list) {
          if (p[2] !== 'all' && a.campus !== p[2]) continue;
          const x = this.get(a, +p[0], p[1]);
          for (let i = 0; i < 96; i++) t[i] += x[i];
        }
      });
      return performance.now() - t0;
    },
    kw(a, mode, h) {
      const arr = this.get(a),
        o = mode ? 48 : 0,
        h0 = Math.floor(h) % 24,
        h1 = (h0 + 1) % 24,
        f = h - Math.floor(h);
      return lerp(arr[o + h0], arr[o + h1], f);
    },
    comps(a, h) {
      const A = ARCH[a.arch],
        wf = dayFactor(A, h, Ctx.day);
      return COMP.map((c, i) => shape(a.arch, c, h) * A.mix[i] * wf * a.kwPeak);
    },
    fill() {
      const cap = Shared.cap,
        d = Shared.data;
      d.fill(0);
      for (const a of Registry.assets) {
        const arr = this.get(a);
        for (let h = 0; h < 24; h++) {
          const o = (h * cap + a.idx) * 4;
          d[o] = arr[h] / a.kwPeak;
          d[o + 1] = arr[48 + h] / a.kwPeak;
        }
      }
      Shared.tex.needsUpdate = true;
    },
  };

  /* ---------- GPU buffers shared by both views: one draw call per layer, any number of assets ---------- */
  const Shared = {
    cap: 0,
    tex: null,
    data: null,
    hmat: null,
    meta: null,
    plane: null,
    geo: new T.BufferGeometry(),
    lineGeo: new T.BufferGeometry(),
    owner: [],
    synced: 0,
    init() {
      this.plane = new T.PlaneGeometry(1, 1);
      this.plane.rotateX(-Math.PI / 2);
      this.ensure(128);
    },
    ensure(n) {
      if (n <= this.cap) return false;
      let cap = Math.max(128, this.cap);
      while (cap < n) cap *= 2;
      const grow = (old, len) => {
        const x = new Float32Array(len);
        if (old) x.set(old.array);
        return x;
      };
      this.hmat = new T.InstancedBufferAttribute(grow(this.hmat, cap * 16), 16);
      this.meta = new T.InstancedBufferAttribute(grow(this.meta, cap * 4), 4);
      this.hmat.setUsage(T.DynamicDrawUsage);
      this.plane.setAttribute('aMeta', this.meta);
      if (this.tex) this.tex.dispose();
      this.data = new Float32Array(cap * 24 * 4);
      this.tex = new T.DataTexture(this.data, cap, 24, T.RGBAFormat, T.FloatType);
      this.tex.minFilter = this.tex.magFilter = T.NearestFilter;
      this.tex.generateMipmaps = false;
      this.tex.needsUpdate = true;
      this.cap = cap;
      Bus.emit('gpu.grow', cap);
      return true;
    },
    write(a) {
      const q = new T.Quaternion(),
        m = new T.Matrix4();
      m.compose(new T.Vector3(a.x, 0.5, a.z), q, new T.Vector3(a.w * 1.7 + 18, 1, a.d * 1.7 + 18));
      m.toArray(this.hmat.array, a.idx * 16);
      const o = a.idx * 4;
      this.meta.array[o] = a.idx;
      this.meta.array[o + 1] = a.measured ? 1 : 0;
      this.meta.array[o + 2] = a.solarKwp > 0 ? 1 : 0;
      this.meta.array[o + 3] = 0;
    },
    rebuild() {
      const pos = [],
        nor = [],
        meta = [],
        owner = [],
        lp = [],
        lm = [],
        ld = [];
      const inside = (P, x, z) => {
        let c = false;
        for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
          const a = P[i],
            b = P[j];
          if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
        }
        return c;
      };
      for (const a of Registry.assets) {
        const P = a.poly,
          n = P.length;
        if (n < 3) continue;
        const h = a.h,
          mt = [a.idx, a.measured ? 1 : 0, a.solarKwp > 0 ? 1 : 0, 0];
        let tri = [];
        try {
          tri = T.ShapeUtils.triangulateShape(
            P.map((p) => new T.Vector2(p[0], p[1])),
            [],
          );
        } catch (e) {
          tri = [];
        }
        for (const t of tri) {
          for (const k of t) {
            pos.push(P[k][0], h, P[k][1]);
            nor.push(0, 1, 0);
            meta.push(mt[0], mt[1], mt[2], mt[3]);
          }
          owner.push(a.idx);
        }
        let cum = 0;
        for (let i = 0; i < n; i++) {
          const p = P[i],
            q = P[(i + 1) % n],
            dx = q[0] - p[0],
            dz = q[1] - p[1],
            L = Math.hypot(dx, dz);
          if (L < 0.01) continue;
          let nx = dz / L,
            nz = -dx / L;
          if (inside(P, (p[0] + q[0]) / 2 + nx * 0.6, (p[1] + q[1]) / 2 + nz * 0.6)) {
            nx = -nx;
            nz = -nz;
          }
          [
            [p[0], 0, p[1]],
            [q[0], 0, q[1]],
            [q[0], h, q[1]],
            [p[0], 0, p[1]],
            [q[0], h, q[1]],
            [p[0], h, p[1]],
          ].forEach((v) => {
            pos.push(v[0], v[1], v[2]);
            nor.push(nx, 0, nz);
            meta.push(mt[0], mt[1], mt[2], mt[3]);
          });
          owner.push(a.idx, a.idx);
          lp.push(p[0], h + 0.05, p[1], q[0], h + 0.05, q[1]);
          lm.push(mt[0], mt[1], mt[2], mt[3], mt[0], mt[1], mt[2], mt[3]);
          ld.push(cum, cum + L);
          cum += L;
        }
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(new Float32Array(pos), 3));
      g.setAttribute('normal', new T.BufferAttribute(new Float32Array(nor), 3));
      g.setAttribute('aMeta', new T.BufferAttribute(new Float32Array(meta), 4));
      g.computeBoundingSphere();
      const l = new T.BufferGeometry();
      l.setAttribute('position', new T.BufferAttribute(new Float32Array(lp), 3));
      l.setAttribute('aMeta', new T.BufferAttribute(new Float32Array(lm), 4));
      l.setAttribute('aDist', new T.BufferAttribute(new Float32Array(ld), 1));
      l.computeBoundingSphere();
      const og = this.geo,
        ol = this.lineGeo;
      this.geo = g;
      this.lineGeo = l;
      this.owner = owner;
      Bus.emit('gpu.geo');
      og.dispose();
      ol.dispose();
    },
    sync() {
      const n = Registry.assets.length;
      this.ensure(n);
      for (let i = this.synced; i < n; i++) this.write(Registry.assets[i]);
      this.synced = n;
      this.hmat.needsUpdate = this.meta.needsUpdate = true;
      this.rebuild();
      Bus.emit('gpu.count', n);
    },
  };

  const LOADFN = `
uniform sampler2D uData;uniform float uCap,uHour,uMode;
float loadAt(float idx){float h0=floor(uHour),h1=mod(h0+1.,24.),f=uHour-h0;
 vec4 a=texture2D(uData,vec2((idx+.5)/uCap,(h0+.5)/24.)),b=texture2D(uData,vec2((idx+.5)/uCap,(h1+.5)/24.));
 return mix(mix(a.x,a.y,uMode),mix(b.x,b.y,uMode),f);}`;
  const RAMPFN = `
vec3 ramp(float k){vec3 a=vec3(.435,.659,.863),b=vec3(.878,.663,.231),c=vec3(.784,.271,.169);return k<.5?mix(a,b,k*2.):mix(b,c,(k-.5)*2.);}
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}`;
  const BVS =
    LOADFN +
    `
attribute vec4 aMeta;varying vec3 vW,vN;varying vec4 vM;varying float vLoad;
void main(){vec4 w=modelMatrix*vec4(position,1.);vW=w.xyz;vN=normal;vM=aMeta;vLoad=loadAt(aMeta.x);gl_Position=projectionMatrix*viewMatrix*w;}`;
  const BFS =
    `
uniform float uCarbon,uSun,uHover,uSel,uWin,uConf,uSolar;uniform vec3 uSunDir,uFog;
varying vec3 vW,vN;varying vec4 vM;varying float vLoad;` +
    RAMPFN +
    `
void main(){
 vec3 n=normalize(vN);float L=clamp(vLoad,0.,1.);float k=clamp(.05+L*uCarbon*1.25,0.,1.);vec3 rc=ramp(k);
 float hs=max(step(abs(vM.x-uHover),.5),step(abs(vM.x-uSel),.5));
 float idh=hash(vec2(vM.x*1.7,3.1));vec3 base=mix(vec3(.075,.08,.125),vec3(.105,.10,.15),idh);
 float diff=.4+.6*max(dot(n,uSunDir),0.)*uSun+.12*n.y;vec3 col=base*diff;
 if(abs(n.y)<.5){
  vec2 tg=normalize(vec2(-n.z,n.x));float u=dot(vW.xz,tg);vec2 g=vec2(u/5.,vW.y/3.6);vec2 cell=floor(g),f=fract(g);
  float win=step(.16,f.x)*step(f.x,.84)*step(.22,f.y)*step(f.y,.78);
  float lit=step(hash(cell+vM.x*13.7),L*1.12+.03)*win*uWin;
  vec3 lamp=mix(vec3(1.,.78,.46),rc,.18);col+=lamp*lit*(.8+.9*L);col+=vec3(.04,.038,.06)*win*(1.-lit);
 }else if(n.y>.5){
  col=base*1.6+rc*(.05+.24*L);
  if(vM.z>.5&&uSolar>.5){vec2 f2=fract(vec2(vW.x/2.4,vW.z/3.2));float panel=step(.07,f2.x)*step(f2.x,.93)*step(.07,f2.y)*step(f2.y,.93);col=mix(col,vec3(.02,.03,.07)+vec3(.95,.68,.16)*(.2+1.5*uSun)*panel,.85);}
 }
 col+=hs*.05;
 float fog=1.-exp(-distance(cameraPosition,vW)*.0003);col=mix(col,uFog,clamp(fog,0.,1.));
 gl_FragColor=vec4(col,1.);}`;
  const LVS =
    LOADFN +
    `
attribute vec4 aMeta;attribute float aDist;varying vec4 vM;varying float vLoad,vDist;
void main(){vM=aMeta;vDist=aDist;vLoad=loadAt(aMeta.x);gl_Position=projectionMatrix*viewMatrix*modelMatrix*vec4(position,1.);}`;
  const LFS =
    `
uniform float uCarbon,uHover,uSel,uConf;varying vec4 vM;varying float vLoad,vDist;` +
    RAMPFN +
    `
void main(){float L=clamp(vLoad,0.,1.);float k=clamp(.05+L*uCarbon*1.25,0.,1.);vec3 rc=ramp(k);
 float hs=max(step(abs(vM.x-uHover),.5),step(abs(vM.x-uSel),.5));
 float dash=mix(step(.5,fract(vDist/7.)),1.,vM.y);if(dash<.5||uConf<.5)discard;
 vec3 col=mix(mix(vec3(.92,.88,.80),rc,.35),vec3(1.),hs);gl_FragColor=vec4(col*(.6+.45*L+.5*hs),1.);}`;
  const HVS =
    LOADFN +
    `attribute vec4 aMeta;varying vec2 vUv;varying float vLoad;
void main(){vUv=uv;vLoad=loadAt(aMeta.x);gl_Position=projectionMatrix*viewMatrix*modelMatrix*instanceMatrix*vec4(position,1.);}`;
  const HFS = `uniform float uCarbon,uHalo;varying vec2 vUv;varying float vLoad;
vec3 ramp(float k){vec3 a=vec3(.435,.659,.863),b=vec3(.878,.663,.231),c=vec3(.784,.271,.169);return k<.5?mix(a,b,k*2.):mix(b,c,(k-.5)*2.);}
void main(){float d=length(vUv-.5)*2.;float a=pow(clamp(1.-d,0.,1.),2.4);float L=clamp(vLoad,0.,1.);float k=clamp(.05+L*uCarbon*1.25,0.,1.);gl_FragColor=vec4(ramp(k)*a*(.07+.5*L)*uHalo,1.);}`;

  /* ---------- one world = one view of the campus (baseline, or with campaigns) ---------- */
  const CAMPS = [
    {
      id: 'iitgn',
      name: 'IIT Gandhinagar',
      sub: new T.Vector3(388.8, 46.0, 110.6),
      cp: { x: 173.9, z: 33.2 },
      ch: { x: 194.4, z: -165.9 },
      river: true,
      pillars: true,
      cpw: 96,
      cpd: 24,
      cpy: 9,
      solarBase: 190,
      home: [new T.Vector3(250.0, 520.0, 700.0), new T.Vector3(60.0, 0.0, 60.0)],
      views: {
        hostels: [new T.Vector3(-10.0, 250.0, 448.0), new T.Vector3(-130.0, 10.0, 148.0)],
        quad: [new T.Vector3(80.0, 300.0, 53.0), new T.Vector3(-39.0, 5.0, -276.0)],
        util: [new T.Vector3(503.0, 320.0, 319.0), new T.Vector3(253.0, 5.0, -10.0)],
      },
      citizen: { asset: 'Duven hostel', group: 'Central hostels' },
    },
    {
      id: 'mujaipur',
      name: 'Manipal University Jaipur',
      sub: new T.Vector3(1421.7, 40.0, 101.7),
      cp: { x: 1379.2, z: -368.2 },
      ch: { x: 1427.3, z: 138.1 },
      crk: { x: 1767.5, z: -332.8 },
      pool: { x: 1563.9, z: 303.0 },
      cpw: 64,
      cpd: 34,
      cpy: 3,
      solarBase: 200,
      home: [new T.Vector3(1850.0, 520.0, 751.0), new T.Vector3(1691.0, 0.0, 51.0)],
      views: {
        hostels: [new T.Vector3(1667.0, 230.0, 322.0), new T.Vector3(1557.0, 10.0, 32.0)],
        quad: [new T.Vector3(1945.0, 280.0, 233.0), new T.Vector3(1835.0, 5.0, -66.0)],
        util: [new T.Vector3(1575.0, 260.0, 369.0), new T.Vector3(1425.0, 5.0, 119.0)],
      },
      citizen: { asset: 'B1 Block', group: 'B blocks' },
    },
  ];
  function glowTex(stops) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d'),
      r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    stops.forEach((s) => r.addColorStop(s[0], s[1]));
    g.fillStyle = r;
    g.fillRect(0, 0, 128, 128);
    return new T.CanvasTexture(c);
  }
  function Flows(max, seg, color) {
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(new Float32Array(max * seg * 2 * 3), 3));
    const lines = new T.LineSegments(
      geo,
      new T.LineBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.11,
        blending: T.AdditiveBlending,
        depthWrite: false,
      }),
    );
    lines.frustumCulled = false;
    const pg = new T.BufferGeometry();
    pg.setAttribute('position', new T.BufferAttribute(new Float32Array(max * 3 * 3), 3));
    pg.setAttribute('color', new T.BufferAttribute(new Float32Array(max * 3 * 3), 3));
    const pts = new T.Points(
      pg,
      new T.PointsMaterial({
        size: 2.6,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        blending: T.AdditiveBlending,
        depthWrite: false,
        map: glowTex([
          [0, 'rgba(255,255,255,1)'],
          [0.4, 'rgba(255,255,255,.5)'],
          [1, 'rgba(255,255,255,0)'],
        ]),
      }),
    );
    pts.frustumCulled = false;
    return {
      max,
      seg,
      lines,
      pts,
      n: 0,
      ends: [],
      ph: new Float32Array(max * 3).map(() => Math.random()),
      spd: new Float32Array(max),
      col: [],
      src: null,
      set(src, list) {
        this.src = src;
        this.n = Math.min(max, list.length);
        this.ends = list.slice(0, this.n);
        const p = geo.attributes.position.array;
        for (let i = 0; i < this.n; i++) {
          const e = this.ends[i],
            a = src,
            b = e.p,
            m = new T.Vector3().addVectors(a, b).multiplyScalar(0.5);
          m.y += 30 + a.distanceTo(b) * 0.18;
          for (let s = 0; s < seg; s++) {
            const u0 = s / seg,
              u1 = (s + 1) / seg;
            [u0, u1].forEach((u, j) => {
              const x = (1 - u) * (1 - u) * a.x + 2 * (1 - u) * u * m.x + u * u * b.x,
                y = (1 - u) * (1 - u) * a.y + 2 * (1 - u) * u * m.y + u * u * b.y,
                z = (1 - u) * (1 - u) * a.z + 2 * (1 - u) * u * m.z + u * u * b.z;
              const o = ((i * seg + s) * 2 + j) * 3;
              p[o] = x;
              p[o + 1] = y;
              p[o + 2] = z;
            });
          }
          this.col[i] = e.c;
          this.spd[i] = e.s;
          this.mid = this.mid || [];
          this.mid[i] = m;
        }
        geo.setDrawRange(0, this.n * seg * 2);
        geo.attributes.position.needsUpdate = true;
        pg.setDrawRange(0, this.n * 3);
      },
      tick(dt, still) {
        if (!this.src) return;
        const p = pg.attributes.position.array,
          c = pg.attributes.color.array;
        for (let i = 0; i < this.n; i++) {
          const e = this.ends[i],
            m = this.mid[i],
            a = this.src,
            b = e.p;
          for (let k = 0; k < 3; k++) {
            const j = i * 3 + k;
            this.ph[j] = (this.ph[j] + (still ? 0 : dt * (0.05 + 0.32 * this.spd[i]))) % 1;
            const u = this.ph[j];
            p[j * 3] = (1 - u) * (1 - u) * a.x + 2 * (1 - u) * u * m.x + u * u * b.x;
            p[j * 3 + 1] = (1 - u) * (1 - u) * a.y + 2 * (1 - u) * u * m.y + u * u * b.y;
            p[j * 3 + 2] = (1 - u) * (1 - u) * a.z + 2 * (1 - u) * u * m.z + u * u * b.z;
            const f = Math.sin(u * Math.PI);
            c[j * 3] = this.col[i].r * f;
            c[j * 3 + 1] = this.col[i].g * f;
            c[j * 3 + 2] = this.col[i].b * f;
          }
        }
        pg.attributes.position.needsUpdate = true;
        pg.attributes.color.needsUpdate = true;
      },
    };
  }

  const RAMP = [new T.Color('#6FA8DC'), new T.Color('#E0A93B'), new T.Color('#C8452B')];
  const rampC = (k) => {
    k = clamp(k, 0, 1);
    const c = new T.Color();
    return k < 0.5 ? c.copy(RAMP[0]).lerp(RAMP[1], k * 2) : c.copy(RAMP[1]).lerp(RAMP[2], (k - 0.5) * 2);
  };
  const Layers = {
    win: true,
    halo: true,
    conf: true,
    flows: true,
    solar: true,
    trees: true,
    labels: true,
    bloom: true,
  };

  function World(canvas, mode) {
    const w = app.clientWidth,
      h = app.clientHeight,
      W = { mode };
    const r = new T.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
    r.setSize(w, h, false);
    r.setClearColor(0x0b0f1c);
    r.info.autoReset = false;
    const scene = new T.Scene();
    scene.fog = new T.FogExp2(0x0a1226, 0.0005);
    const cam = new T.PerspectiveCamera(38, w / h, 5, 9000);
    const comp = new T.EffectComposer(r);
    comp.addPass(new T.RenderPass(scene, cam));
    const bloom = new T.UnrealBloomPass(new T.Vector2(w, h), 0.5, 0.5, 0.58);
    comp.addPass(bloom);
    const U = {
      uData: { value: Shared.tex },
      uCap: { value: Shared.cap },
      uHour: { value: Ctx.t },
      uMode: { value: mode },
      uCarbon: { value: 0.9 },
      uSun: { value: 0 },
      uSunDir: { value: new T.Vector3(0, 1, 0) },
      uHover: { value: -1 },
      uSel: { value: -1 },
      uWin: { value: 1 },
      uConf: { value: 1 },
      uSolar: { value: 1 },
      uHalo: { value: 1 },
      uFog: { value: new T.Color(0x0a1226) },
    };
    const bm = new T.ShaderMaterial({
      uniforms: U,
      vertexShader: BVS,
      fragmentShader: BFS,
      side: T.DoubleSide,
    });
    const bld = new T.Mesh(Shared.geo, bm);
    bld.frustumCulled = false;
    scene.add(bld);
    const box = bld;
    const lm = new T.ShaderMaterial({ uniforms: U, vertexShader: LVS, fragmentShader: LFS });
    const lines = new T.LineSegments(Shared.lineGeo, lm);
    lines.frustumCulled = false;
    scene.add(lines);
    const hm = new T.ShaderMaterial({
      uniforms: U,
      vertexShader: HVS,
      fragmentShader: HFS,
      transparent: true,
      blending: T.AdditiveBlending,
      depthWrite: false,
    });
    const halo = new T.InstancedMesh(Shared.plane, hm, 1);
    halo.frustumCulled = false;
    halo.instanceMatrix = Shared.hmat;
    halo.raycast = function () {};
    scene.add(halo);
    Object.assign(W, { r, scene, cam, comp, bloom, U, box, halo });
    const ground = new T.Mesh(
      new T.PlaneGeometry(5000, 5000).rotateX(-Math.PI / 2),
      new T.MeshBasicMaterial({ color: 0x0b0f1c }),
    );
    ground.position.y = -0.2;
    scene.add(ground);
    const grid = new T.GridHelper(2400, 96, 0x252d47, 0x161c30);
    grid.position.y = 0.05;
    grid.material.transparent = true;
    grid.material.opacity = 0.38;
    scene.add(grid);
    const road = (x, z, rw, rd) => {
      const m = new T.Mesh(
        new T.PlaneGeometry(rw, rd).rotateX(-Math.PI / 2),
        new T.MeshBasicMaterial({ color: 0x161b2c }),
      );
      m.position.set(x, 0.12, z);
      scene.add(m);
      const l = new T.Mesh(
        new T.PlaneGeometry(rw > rd ? rw : 1, rw > rd ? 1 : rd).rotateX(-Math.PI / 2),
        new T.MeshBasicMaterial({ color: 0xe8dec8, transparent: true, opacity: 0.18 }),
      );
      l.position.set(x, 0.16, z);
      scene.add(l);
    };
    CAMPS.forEach((c) => {
      if (c.river) {
        const river = new T.Mesh(
          new T.PlaneGeometry(260, 3200).rotateX(-Math.PI / 2),
          new T.MeshBasicMaterial({ color: 0x16294d, transparent: true, opacity: 0.8 }),
        );
        river.position.set(-521, 0.1, -276);
        river.rotation.y = -0.68;
        scene.add(river);
      }
      if (c.crk) {
        const pitch = new T.Mesh(
          new T.CircleGeometry(62, 40).rotateX(-Math.PI / 2),
          new T.MeshBasicMaterial({ color: 0x1f3a2c }),
        );
        pitch.position.set(c.crk.x, 0.12, c.crk.z);
        scene.add(pitch);
      }
      if (c.pool) {
        const poolM = new T.Mesh(
          new T.PlaneGeometry(28, 14).rotateX(-Math.PI / 2),
          new T.MeshBasicMaterial({ color: 0x2a5a86 }),
        );
        poolM.position.set(c.pool.x, 0.14, c.pool.z);
        scene.add(poolM);
      }
    });
    /* sky, stars, sun and moon */
    const skyM = new T.ShaderMaterial({
      side: T.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: new T.Color() }, bot: { value: new T.Color() } },
      vertexShader:
        'varying float h;void main(){h=normalize(position).y;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader:
        'uniform vec3 top;uniform vec3 bot;varying float h;void main(){gl_FragColor=vec4(mix(bot,top,smoothstep(-.05,.55,h)),1.);}',
    });
    scene.add(new T.Mesh(new T.SphereGeometry(4200, 24, 16), skyM));
    const sp = new Float32Array(900);
    for (let i = 0; i < 300; i++) {
      const a = Math.random() * Math.PI * 2,
        e = Math.random() * 1.2 + 0.1,
        R = 4000;
      sp[i * 3] = Math.cos(a) * Math.cos(e) * R;
      sp[i * 3 + 1] = Math.sin(e) * R;
      sp[i * 3 + 2] = Math.sin(a) * Math.cos(e) * R;
    }
    const sg = new T.BufferGeometry();
    sg.setAttribute('position', new T.BufferAttribute(sp, 3));
    const stars = new T.Points(
      sg,
      new T.PointsMaterial({
        size: 1.7,
        sizeAttenuation: false,
        color: 0xe6e2d6,
        transparent: true,
        depthWrite: false,
        fog: false,
      }),
    );
    scene.add(stars);
    const sun = new T.Sprite(
      new T.SpriteMaterial({
        map: glowTex([
          [0, 'rgba(255,236,190,1)'],
          [0.18, 'rgba(255,200,110,.75)'],
          [1, 'rgba(255,170,80,0)'],
        ]),
        blending: T.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    );
    sun.scale.set(900, 900, 1);
    scene.add(sun);
    /* special assets: substation, solar carport, chiller towers, trees */
    const spc = CAMPS.map((c) => {
      const g = new T.Group();
      g.position.set(c.sub.x, 0, c.sub.z);
      const oct = new T.Mesh(new T.OctahedronGeometry(7), new T.MeshBasicMaterial({ color: 0xc8452b }));
      oct.position.y = c.sub.y;
      g.add(oct);
      const beam = new T.Mesh(
        new T.CylinderGeometry(0.8, 0.8, c.sub.y, 6),
        new T.MeshBasicMaterial({ color: 0x5b5a66 }),
      );
      beam.position.y = c.sub.y / 2;
      g.add(beam);
      scene.add(g);
      const cm = new T.MeshBasicMaterial({ color: 0xe0a93b });
      const canopy = new T.Mesh(new T.BoxGeometry(c.cpw, 1.2, c.cpd), cm);
      canopy.position.set(c.cp.x, c.cpy, c.cp.z);
      scene.add(canopy);
      if (c.pillars)
        for (let i = 0; i < 6; i++) {
          const pl = new T.Mesh(new T.BoxGeometry(1.2, 9, 1.2), new T.MeshBasicMaterial({ color: 0x4a4a56 }));
          pl.position.set(c.cp.x - 42 + i * 17, 4.5, c.cp.z - 10);
          scene.add(pl);
        }
      for (let i = 0; i < 3; i++) {
        const t2 = new T.Mesh(
          new T.CylinderGeometry(6, 7, 18, 16),
          new T.MeshBasicMaterial({ color: 0x2c3148 }),
        );
        t2.position.set(c.ch.x + 28 + i * 15, 9, c.ch.z - 20);
        scene.add(t2);
        const rg = new T.Mesh(
          new T.RingGeometry(4.5, 5.6, 24).rotateX(-Math.PI / 2),
          new T.MeshBasicMaterial({ color: 0x7fb2e5 }),
        );
        rg.position.set(c.ch.x + 28 + i * 15, 18.2, c.ch.z - 20);
        scene.add(rg);
      }
      const stp = new Float32Array(3 * 16 * 3),
        steam = new T.Points(
          new T.BufferGeometry().setAttribute('position', new T.BufferAttribute(stp, 3)),
          new T.PointsMaterial({
            size: 16,
            sizeAttenuation: true,
            transparent: true,
            opacity: 0.22,
            depthWrite: false,
            color: 0xb8c4d8,
            map: glowTex([
              [0, 'rgba(255,255,255,.9)'],
              [1, 'rgba(255,255,255,0)'],
            ]),
          }),
        );
      steam.frustumCulled = false;
      scene.add(steam);
      return { c, oct, canopy, cm, stp, steam, ph: new Float32Array(48).map(() => Math.random()) };
    });
    const TREES = [
      [-27.1, 147.6],
      [1685.3, 133.7],
      [-167.5, 149.8],
      [1577.4, 113.7],
      [-211.1, 216.5],
      [1575.2, -12.2],
      [-17.8, 209.1],
      [1657.0, 239.1],
      [-138.4, -237.0],
      [1608.2, 254.1],
      [-23.2, -191.6],
      [1937.4, 24.1],
      [103.1, -329.8],
      [1881.9, -107.5],
      [155.3, -237.0],
      [1848.3, -19.9],
      [75.6, -240.2],
      [2036.7, 146.9],
      [-7.7, 102.1],
      [2013.4, -119.3],
      [84.7, -11.4],
      [1550.8, 182.3],
      [151.2, 430.0],
      [1814.4, -83.1],
      [174.8, 506.8],
      [1723.4, -44.7],
      [451.8, 63.8],
      [1751.2, 341.7],
      [301.3, 11.5],
      [-218.1, 108.5],
    ];
    const trees = new T.InstancedMesh(
      new T.IcosahedronGeometry(1, 1),
      new T.MeshBasicMaterial({ color: 0x7fa37a }),
      TREES.length,
    );
    const stems = new T.InstancedMesh(
      new T.CylinderGeometry(0.5, 0.7, 1, 6),
      new T.MeshBasicMaterial({ color: 0x4a4332 }),
      TREES.length,
    );
    const tm = new T.Matrix4();
    TREES.forEach((p, i) => {
      tm.compose(new T.Vector3(p[0], 8, p[1]), new T.Quaternion(), new T.Vector3(4.6, 4.6, 4.6));
      trees.setMatrixAt(i, tm);
      tm.compose(new T.Vector3(p[0], 3, p[1]), new T.Quaternion(), new T.Vector3(1, 6, 1));
      stems.setMatrixAt(i, tm);
    });
    trees.frustumCulled = stems.frustumCulled = false;
    scene.add(trees, stems);
    const flows = CAMPS.map((c) => ({ c, flow: Flows(24, 18, 0xc8452b), sflow: Flows(8, 14, 0xe0a93b) }));
    flows.forEach((f) => scene.add(f.flow.lines, f.flow.pts, f.sflow.lines, f.sflow.pts));
    const ghost = new T.Group();
    const gb = new T.Mesh(
      new T.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
      new T.MeshBasicMaterial({ color: 0xe0a93b, transparent: true, opacity: 0.22, depthWrite: false }),
    );
    const ge = new T.LineSegments(
      new T.EdgesGeometry(new T.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)),
      new T.LineBasicMaterial({ color: 0xe0a93b }),
    );
    ghost.add(gb, ge);
    ghost.visible = false;
    scene.add(ghost);
    const ring = new T.Mesh(
      new T.RingGeometry(0.9, 1, 48).rotateX(-Math.PI / 2),
      new T.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: T.AdditiveBlending,
      }),
    );
    ring.position.y = 0.6;
    scene.add(ring);
    Object.assign(W, { skyM, stars, sun, spc, trees, stems, TREES, flows, ghost, ring, ringT: 0 });
    W.setEnv = function (h) {
      const s = sunEl(h),
        night = h >= 6 && h < 18 ? 0 : 1,
        du = Math.max(bell(h, 18.7, 1.1), bell(h, 5.6, 0.9));
      const mix = (a, b, g) => a.map((v, i) => v + (b[i] - v) * g),
        top = mix([10, 13, 26], [64, 90, 126], s),
        bot = mix(mix([20, 24, 42], [142, 150, 158], s), [122, 72, 60], du * 0.75);
      skyM.uniforms.top.value.setRGB(top[0] / 255, top[1] / 255, top[2] / 255);
      skyM.uniforms.bot.value.setRGB(bot[0] / 255, bot[1] / 255, bot[2] / 255);
      U.uFog.value.setRGB(bot[0] / 255, bot[1] / 255, bot[2] / 255);
      scene.fog.color.copy(U.uFog.value);
      stars.material.opacity = (1 - s) * (1 - du * 0.5) * 0.9;
      const day = h >= 6 && h < 18,
        u = day ? (h - 6) / 12 : (h >= 18 ? h - 18 : h + 6) / 12,
        a = Math.PI * u,
        dir = new T.Vector3(-Math.cos(a), Math.sin(a) + 0.04, -0.35).normalize();
      sun.position.copy(dir).multiplyScalar(3600);
      sun.material.color.set(day ? 0xffe9b8 : 0xc9d3ea);
      sun.scale.setScalar(day ? 900 : 420);
      sun.material.opacity = day ? 1 : 0.7;
      U.uSunDir.value.copy(dir);
      U.uSun.value = day ? s : 0.16 * Math.sin(Math.PI * u);
      U.uCarbon.value = carbon(h);
      U.uHour.value = h;
      spc.forEach((q) => q.cm.color.setRGB(0.3 + 0.62 * s, 0.24 + 0.45 * s, 0.1 + 0.05 * s));
      W.sunK = s;
    };
    W.sync = function () {
      halo.count = Registry.assets.length;
    };
    W.regrow = function () {
      halo.instanceMatrix = Shared.hmat;
      U.uData.value = Shared.tex;
      U.uCap.value = Shared.cap;
    };
    W.applyLayers = function () {
      U.uWin.value = Layers.win ? 1 : 0;
      U.uConf.value = Layers.conf ? 1 : 0;
      U.uSolar.value = Layers.solar ? 1 : 0;
      U.uHalo.value = Layers.halo ? 1 : 0;
      trees.visible = stems.visible = Layers.trees;
      flows.forEach((f) => {
        f.flow.lines.visible = f.flow.pts.visible = Layers.flows;
        f.sflow.lines.visible = f.sflow.pts.visible = Layers.flows && Layers.solar;
      });
      bloom.enabled = Layers.bloom;
      spc.forEach((q) => {
        q.canopy.visible = Layers.solar;
      });
    };
    W.setTrees = function (n) {
      trees.count = stems.count = clamp(n, 0, TREES.length);
    };
    W.setFlows = function () {
      const c0 = U.uCarbon.value;
      flows.forEach((f) => {
        const as = Registry.assets.filter((a) => a.campus === f.c.id);
        if (!as.length) return;
        const list = as
            .map((a) => ({ a, k: Sim.kw(a, mode, Ctx.t) }))
            .sort((p, q) => q.k - p.k)
            .slice(0, 24),
          mx = list[0] ? list[0].k : 1;
        f.flow.set(
          f.c.sub,
          list.map((o) => ({
            p: new T.Vector3(o.a.x, o.a.h + 2, o.a.z),
            c: rampC(clamp(0.05 + (o.k / mx) * c0 * 1.25, 0, 1)),
            s: o.k / mx,
          })),
        );
        const near = as
          .filter((a) => a.arch === 'academic')
          .slice(0, 6)
          .map((a) => ({ p: new T.Vector3(a.x, a.h + 2, a.z), c: new T.Color(0xe0a93b), s: W.sunK || 0 }));
        const ch = as.find((a) => a.arch === 'chiller');
        if (ch)
          near.push({ p: new T.Vector3(ch.x, ch.h + 2, ch.z), c: new T.Color(0xe0a93b), s: W.sunK || 0 });
        f.sflow.set(new T.Vector3(f.c.cp.x, 10, f.c.cp.z), near);
        f.sflow.spd = Float32Array.from(near.map((n) => n.s));
      });
    };
    W.tick = function (dt, t) {
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      flows.forEach((f) => {
        f.flow.tick(dt, still);
        f.sflow.tick(dt, still);
      });
      spc.forEach((q) => {
        q.oct.rotation.y += dt * 0.8;
        q.oct.material.color.copy(rampC(carbon(Ctx.t)));
        if (!still) {
          for (let i = 0; i < 48; i++) {
            q.ph[i] = (q.ph[i] + dt * 0.18) % 1;
            const tw = Math.floor(i / 16),
              p = q.ph[i];
            q.stp[i * 3] = q.c.ch.x + 28 + tw * 15 + Math.sin(i * 3.1 + p * 5) * 3;
            q.stp[i * 3 + 1] = 19 + p * 34;
            q.stp[i * 3 + 2] = q.c.ch.z - 20 + Math.cos(i * 2.3) * 3;
          }
          q.steam.geometry.attributes.position.needsUpdate = true;
        }
      });
      if (W.ringT > 0) {
        W.ringT = Math.max(0, W.ringT - dt);
        const f = 1 - W.ringT / 2;
        ring.scale.setScalar(10 + f * 90);
        ring.material.opacity = (1 - f) * 0.9;
      } else ring.material.opacity = 0;
    };
    W.resize = function () {
      const w2 = app.clientWidth,
        h2 = app.clientHeight;
      r.setSize(w2, h2, false);
      comp.setSize(w2, h2);
      bloom.setSize(w2, h2);
      cam.aspect = w2 / h2;
      cam.updateProjectionMatrix();
    };
    W.render = function () {
      comp.render();
    };
    W.sync();
    W.applyLayers();
    W.setEnv(Ctx.t);
    W.regeo = function () {
      bld.geometry = Shared.geo;
      lines.geometry = Shared.lineGeo;
    };
    Bus.on('gpu.grow', W.regrow);
    Bus.on('gpu.geo', W.regeo);
    return W;
  }

  /* ---------- boot GPU, worlds, data ---------- */
  let A, B;
  try {
    Shared.init();
    A = World($('#cvA'), 0);
    B = World($('#cvB'), 1);
  } catch (err) {
    app.insertAdjacentHTML(
      'beforeend',
      '<div class="fail">WebGL is not available in this browser, so the 3D campus cannot render here.</div>',
    );
    return;
  }
  const controls = new T.OrbitControls(A.cam, $('#pick'));
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.maxPolarAngle = 1.48;
  controls.minDistance = 60;
  controls.maxDistance = 4200;
  const HOME = { p: new T.Vector3(880, 2400, 2050), t: new T.Vector3(880, 0, 60) };
  A.cam.position.copy(HOME.p);
  controls.target.copy(HOME.t);
  controls.update();

  const ASSET_DATA = window.LIFECITY_ASSETS;
  ASSET_DATA.forEach((r) =>
    Registry.add({
      name: r[0],
      arch: r[1],
      group: r[2],
      x: r[3],
      z: r[4],
      w: r[5],
      d: r[6],
      h: r[7],
      solarKwp: r[8],
      measured: !!r[9],
      estimated: r[10] === 'i',
      placeholder: r[10] === 'p',
      poly: r[11] || undefined,
      campus: r[12],
    }),
  );
  const BASE_N = Registry.assets.length;
  const CARPORT = { name: 'Solar carport', kwp: 190, reported: true, placeholder: true };

  /* ---------- event log and simulated telemetry ---------- */
  const Log = {
    items: [],
    filter: 'all',
    push(type, msg) {
      const d = new Date();
      this.items.unshift({ type, msg, t: d.toTimeString().slice(0, 8) });
      if (this.items.length > 120) this.items.pop();
      Bus.emit('log');
    },
  };
  const Svc = {
    names: [
      'API response, p95',
      'Readings in',
      'Cache hits',
      'Retry queue',
      'Database connections',
      'Worker lag',
    ],
    unit: ['ms', 'per s', '%', 'readings', '', 'ms'],
    ser: [[], [], [], [], [], []],
    val: [0, 0, 0, 0, 0, 0],
    queue: 0,
    fps: 60,
    fa: 0,
    fn: 0,
    step() {
      const N = Registry.assets.length,
        down = Ctx.health === 'down';
      const tot = Sim.hits + Sim.miss || 1;
      this.queue = down ? this.queue + 380 + Math.random() * 80 : Math.max(0, this.queue * 0.55 - 20);
      this.val = [
        down ? 310 + Math.random() * 60 : 34 + N * 0.011 + Math.random() * 7,
        down ? 0 : 900 + Math.random() * 1300,
        down ? 97 + Math.random() * 2 : clamp((Sim.hits / tot) * 100, 0, 99.5),
        this.queue,
        down ? 0 : 8 + Math.ceil(N / 450),
        down ? 900 + this.queue * 0.6 : 18 + N * 0.017 + Math.random() * 5,
      ];
      this.val.forEach((v, i) => {
        this.ser[i].push(v);
        if (this.ser[i].length > 36) this.ser[i].shift();
      });
    },
  };
  function ingestTick() {
    if (Ctx.health === 'down') {
      Log.push(
        'ingest',
        'buffered ' + fmtN(380 + Math.random() * 80) + ' readings in the retry queue (database unreachable)',
      );
      return;
    }
    const n = Math.round(800 + Math.random() * 1500),
      ms = Math.round(18 + Math.random() * 30 + Registry.assets.length * 0.004),
      dup = Math.floor(Math.random() * 5);
    Log.push(
      'ingest',
      'batch of ' +
        fmtN(n) +
        ' readings accepted in ' +
        ms +
        ' ms, ' +
        dup +
        ' duplicate' +
        (dup === 1 ? '' : 's') +
        ' dropped (idempotent)',
    );
  }
  setInterval(() => {
    if (document.hidden) return;
    Svc.step();
    ingestTick();
    Bus.emit('svc');
  }, 1600);
  setInterval(() => {
    if (document.hidden || Math.random() > 0.35) return;
    const ms = Registry.assets.filter((a) => a.measured),
      a = ms[Math.floor(Math.random() * ms.length)];
    if (a && Ctx.health === 'ok')
      Log.push(
        'alert',
        esc(a.name) +
          ' is running ' +
          (8 + Math.floor(Math.random() * 14)) +
          '% above its fitted baseline for 3 intervals in a row.',
      );
  }, 4200);

  /* ---------- scene sync: registry to GPU ---------- */
  function commit(newOnes, label) {
    const t0 = performance.now();
    const grew = Shared.ensure(Registry.assets.length);
    Shared.sync();
    const t1 = performance.now();
    const dMs = Sim.onAdded(newOnes);
    Sim.fill();
    const t2 = performance.now();
    A.sync();
    B.sync();
    A.setFlows();
    B.setFlows();
    Bus.emit('registry');
    return { reg: t1 - t0, sim: dMs, tex: t2 - t1 - dMs, total: performance.now() - t0, grew };
  }
  Shared.sync();
  Sim.totals();
  Sim.fill();
  A.sync();
  B.sync();

  /* ---------- camera ---------- */
  let tween = null;
  function flyTo(pos, tgt, ms) {
    tween = {
      t0: performance.now(),
      ms: ms || 900,
      p0: A.cam.position.clone(),
      t0v: controls.target.clone(),
      p1: pos,
      t1: tgt,
    };
  }
  function flyAsset(a) {
    const d = Math.max(a.w, a.d) * 2.6 + 90;
    flyTo(
      new T.Vector3(a.x + d * 0.55, a.h * 0.6 + d * 0.6, a.z + d * 0.95),
      new T.Vector3(a.x, a.h * 0.4, a.z),
      900,
    );
  }
  const viewsFor = () => {
    const c = CAMPS.find((x) => x.id === Ctx.campus) || null;
    return c
      ? Object.assign({ home: c.home }, c.views)
      : {
          home: [HOME.p, HOME.t],
          hostels: CAMPS[0].views.hostels,
          quad: CAMPS[0].views.quad,
          util: CAMPS[0].views.util,
        };
  };
  const campusLabel = () =>
    Ctx.campus === 'all'
      ? 'both campuses'
      : (CAMPS.find((c) => c.id === Ctx.campus) || { name: 'the test district' }).name;
  const campusAssets = () => Registry.assets.filter((a) => Ctx.campus === 'all' || a.campus === Ctx.campus);
  $$('#views button').forEach((b) =>
    b.addEventListener('click', () => {
      const v = viewsFor()[b.dataset.v];
      flyTo(v[0].clone(), v[1].clone(), 1000);
      $$('#views button').forEach((x) => x.classList.toggle('on', x === b));
    }),
  );
  function setSelection(i, fly) {
    Ctx.sel = i;
    A.U.uSel.value = B.U.uSel.value = i;
    Bus.emit('sel');
    if (fly && i >= 0) flyAsset(Registry.assets[i]);
  }

  /* ---------- picking, placement ---------- */
  const ray = new T.Raycaster(),
    ndc = new T.Vector2(),
    groundPl = new T.Plane(new T.Vector3(0, 1, 0), 0);
  let placing = false,
    placed = null,
    downAt = null;
  function pickAt(e) {
    const r = $('#pick').getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, A.cam);
    return ray;
  }
  function groundAt(e) {
    const rr = pickAt(e),
      p = new T.Vector3();
    return rr.ray.intersectPlane(groundPl, p) ? p : null;
  }
  let moveQ = false,
    lastE = null;
  $('#pick').addEventListener('pointermove', (e) => {
    lastE = e;
    if (moveQ) return;
    moveQ = true;
    requestAnimationFrame(() => {
      moveQ = false;
      if (!lastE) return;
      const ev = lastE;
      if (placing) {
        const g = groundAt(ev);
        if (g) {
          const x = Math.round(g.x / 5) * 5,
            z = Math.round(g.z / 5) * 5;
          placed = { x, z };
          updateGhost();
          $('#posOut').textContent = 'x ' + x + ', z ' + z;
        }
        return;
      }
      const hit = pickAt(ev).intersectObject(A.box, false)[0],
        i = hit ? Shared.owner[hit.faceIndex] : -1;
      if (i !== Ctx.hov) {
        Ctx.hov = i;
        A.U.uHover.value = B.U.uHover.value = i;
        $('#pick').style.cursor = i >= 0 ? 'pointer' : 'grab';
        Bus.emit('hov');
      }
    });
  });
  $('#pick').addEventListener('pointerleave', () => {
    if (Ctx.hov !== -1) {
      Ctx.hov = -1;
      A.U.uHover.value = B.U.uHover.value = -1;
      Bus.emit('hov');
    }
  });
  $('#pick').addEventListener('pointerdown', (e) => {
    downAt = { x: e.clientX, y: e.clientY };
  });
  $('#pick').addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 5) return;
    if (placing) {
      if (placed) {
        placing = false;
        $('#btnPlace').textContent = 'Pick position on map';
        updateGhost();
      }
      return;
    }
    const hit = pickAt(e).intersectObject(A.box, false)[0];
    setSelection(hit ? Shared.owner[hit.faceIndex] : -1, !!hit);
    setTab('right', 'insp');
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (placing) {
        placing = false;
        placed = null;
        updateGhost();
        $('#btnPlace').textContent = 'Pick position on map';
      } else setSelection(-1, false);
    }
  });

  /* ---------- labels over special assets ---------- */
  const LAB = [
    {
      id: 'chiller',
      campus: 'iitgn',
      text: 'Chiller plant (placeholder)',
      p: new T.Vector3(194.4, 34, -165.9),
    },
    {
      id: 'solar',
      campus: 'iitgn',
      kwp: 190,
      kn: 'reported',
      text: 'Solar carport (placeholder)',
      p: new T.Vector3(173.9, 22, 33.2),
    },
    { id: 'sub', campus: 'iitgn', text: 'Substation (placeholder)', p: new T.Vector3(388.8, 58, 46.0) },
    { id: 'river', campus: 'iitgn', text: 'Sabarmati river, approximate', p: new T.Vector3(-470, 6, -230) },
    {
      id: 'chiller',
      campus: 'mujaipur',
      text: 'Chiller plant (inferred)',
      p: new T.Vector3(1427.3, 30, 138.1),
    },
    {
      id: 'solar',
      campus: 'mujaipur',
      kwp: 200,
      kn: 'placeholder',
      text: 'Solar array (size unknown)',
      p: new T.Vector3(1379.2, 22, -368.2),
    },
    { id: 'sub', campus: 'mujaipur', text: 'Transformer', p: new T.Vector3(1421.7, 40, 101.7) },
    { id: 'name', campus: 'iitgn', text: 'IIT Gandhinagar', p: new T.Vector3(68, 70, 145) },
    { id: 'name', campus: 'mujaipur', text: 'Manipal University Jaipur', p: new T.Vector3(1691, 70, 51) },
  ];
  LAB.forEach((l) => {
    l.el = document.createElement('div');
    l.el.className = 'tag' + (l.id === 'name' ? ' big' : '');
    l.el.innerHTML = '<b></b><span></span>';
    l.el.firstChild.textContent = l.text;
    $('#labels').append(l.el);
  });
  const _v = new T.Vector3();
  const HT = document.createElement('div');
  HT.className = 'tag';
  HT.innerHTML = '<b></b><span></span>';
  HT.style.display = 'none';
  $('#labels').append(HT);
  function placeLabels() {
    const w = app.clientWidth,
      h = app.clientHeight,
      s = A.sunK || 0;
    LAB.forEach((l) => {
      if (
        !Layers.labels ||
        (l.id === 'name' ? Ctx.campus !== 'all' : Ctx.campus === 'all' || l.campus !== Ctx.campus)
      ) {
        l.el.style.display = 'none';
        return;
      }
      _v.copy(l.p).project(A.cam);
      const vis = _v.z < 1 && Math.abs(_v.x) < 1.1 && Math.abs(_v.y) < 1.1;
      l.el.style.display = vis ? 'flex' : 'none';
      if (!vis) return;
      l.el.style.transform =
        'translate(' +
        Math.round((_v.x * 0.5 + 0.5) * w - l.el.offsetWidth / 2) +
        'px,' +
        Math.round((-_v.y * 0.5 + 0.5) * h - l.el.offsetHeight - 14) +
        'px)';
      let t2 = '';
      if (l.id === 'chiller') {
        const ch = Registry.assets.find((a) => a.arch === 'chiller' && a.campus === l.campus);
        t2 = ch ? fmtKW(Sim.kw(ch, 0, Ctx.t)) : '';
      } else if (l.id === 'solar') t2 = fmtKW(l.kwp * s * 0.8) + ' of ' + l.kwp + ' kWp, ' + l.kn;
      else if (l.id === 'name')
        t2 = fmtKW(Sim.totals(Ctx.mask, Ctx.day, l.campus)[48 + (Math.floor(Ctx.t) % 24)]) + ' now';
      else if (l.id === 'river') t2 = 'north-west edge';
      else t2 = Math.round(ci(Ctx.t)) + ' g/kWh grid';
      l.el.lastChild.textContent = t2;
    });
    const hi = Ctx.hov >= 0 ? Ctx.hov : Ctx.sel;
    if (hi >= 0 && Registry.assets[hi]) {
      const a = Registry.assets[hi];
      _v.set(a.x, a.h + 4, a.z).project(A.cam);
      const vis = _v.z < 1 && Math.abs(_v.x) < 1.1 && Math.abs(_v.y) < 1.1;
      HT.style.display = vis ? 'flex' : 'none';
      if (vis) {
        HT.firstChild.textContent = a.name;
        HT.lastChild.textContent =
          fmtKW(Sim.kw(a, 0, Ctx.t)) +
          (Ctx.mask ? ' → ' + fmtKW(Sim.kw(a, 1, Ctx.t)) : '') +
          (a.measured ? ' · has readings' : ' · modelled');
        HT.style.transform =
          'translate(' +
          Math.round((_v.x * 0.5 + 0.5) * w - HT.offsetWidth / 2) +
          'px,' +
          Math.round((-_v.y * 0.5 + 0.5) * h - HT.offsetHeight - 14) +
          'px)';
      }
    } else HT.style.display = 'none';
  }

  /* ---------- ghost placement ---------- */
  function updateGhost() {
    [A, B].forEach((W) => {
      const g = W.ghost;
      g.visible = placing || (!!placed && Ctx.tab === 'add');
      if (!g.visible || !placed) return;
      const w = +$('#fW').value || 36,
        d = +$('#fD').value || 24,
        fl = +$('#fFloors').value || 5;
      g.position.set(placed.x, 0, placed.z);
      g.scale.set(w, fl * 3.4, d);
    });
  }
  ['fW', 'fD', 'fFloors'].forEach((id) => $('#' + id).addEventListener('input', updateGhost));

  /* ---------- UI helpers ---------- */
  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    $('#toast').append(t);
    setTimeout(() => t.remove(), 2600);
  }
  function setTab(group, tab) {
    $$('.tabs[data-group="' + group + '"] button').forEach((b) =>
      b.classList.toggle('on', b.dataset.tab === tab),
    );
    const side = group === 'left' ? '#left' : '#right';
    $$(side + ' .pane').forEach((p) => p.classList.toggle('on', p.id === 'p-' + tab));
    if (group === 'right') {
      Ctx.tab = tab;
      updateGhost();
      if (tab === 'cit') Bus.emit('cit');
      if (tab === 'insp') Bus.emit('sel');
      if (tab === 'sys') Bus.emit('svc');
      if (tab === 'ev') Bus.emit('log');
    }
  }
  $$('.tabs button').forEach((b) =>
    b.addEventListener('click', () => setTab(b.parentElement.dataset.group, b.dataset.tab)),
  );

  /* ---------- generic plot ---------- */
  function plot(cv, o) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2),
      W = cv.clientWidth,
      H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const L = o.l != null ? o.l : 34,
      R = 8,
      Tt = o.notes ? 26 : 8,
      Bt = o.heat ? 30 : 18,
      pw = W - L - R,
      ph = H - Tt - Bt,
      X = (h) => L + (h / 24) * pw,
      Y = (v) => Tt + ph - (v / o.ymax) * ph;
    g.font = '11px Spline Sans Mono, monospace';
    g.textBaseline = 'middle';
    if (o.solar) {
      g.fillStyle = 'rgba(224,169,59,.07)';
      g.fillRect(X(6), Tt, X(18) - X(6), ph);
      g.fillStyle = 'rgba(224,169,59,.55)';
      g.textAlign = 'center';
      g.fillText('solar window', X(12), Tt + 8);
    }
    g.strokeStyle = 'rgba(235,227,210,.12)';
    g.lineWidth = 1;
    for (let i = 0; i <= 2; i++) {
      const y = Tt + (ph * i) / 2;
      g.beginPath();
      g.moveTo(L, y);
      g.lineTo(W - R, y);
      g.stroke();
    }
    g.fillStyle = 'rgba(169,160,142,.85)';
    g.textAlign = 'right';
    g.fillText(o.fmt(o.ymax), L - 5, Tt + 6);
    g.fillText('0', L - 5, Tt + ph - 1);
    if (o.band) {
      g.beginPath();
      o.band.hi.forEach((v, h) => g[h ? 'lineTo' : 'moveTo'](X(h), Y(v)));
      for (let h = 23; h >= 0; h--) g.lineTo(X(h), Y(o.band.lo[h]));
      g.closePath();
      g.fillStyle = 'rgba(127,178,229,.2)';
      g.fill();
    }
    o.series.forEach((s) => {
      g.beginPath();
      s.y.forEach((v, h) => g[h ? 'lineTo' : 'moveTo'](X(h), Y(v)));
      g.strokeStyle = s.c;
      g.lineWidth = s.w || 1.6;
      g.setLineDash(s.dash || []);
      g.stroke();
      g.setLineDash([]);
    });
    if (o.heat) {
      const y = Tt + ph + 8;
      for (let h = 0; h < 24; h += 0.5) {
        g.fillStyle = '#' + rampC(clamp(carbon(h) * 1.02, 0, 1)).getHexString();
        g.fillRect(X(h), y, pw / 48 + 0.6, 5);
      }
      g.fillStyle = 'rgba(169,160,142,.85)';
      g.textAlign = 'right';
      g.fillText('carbon', L - 6, y + 6);
    }
    g.fillStyle = 'rgba(169,160,142,.7)';
    g.textAlign = 'center';
    const yl = H - 6 - (o.heat ? 0 : 0);
    for (let h = 0; h <= 24; h += 3) g.fillText(String(h).padStart(2, '0'), X(h), o.heat ? H - 5 : H - 6);
    const cx = X(Ctx.t);
    g.strokeStyle = 'rgba(235,227,210,.6)';
    g.beginPath();
    g.moveTo(cx, Tt);
    g.lineTo(cx, Tt + ph);
    g.stroke();
    o.series.forEach((s) => {
      const i0 = Math.floor(Ctx.t) % 24,
        i1 = (i0 + 1) % 24,
        v = lerp(s.y[i0], s.y[i1], Ctx.t - Math.floor(Ctx.t));
      g.fillStyle = s.c;
      g.beginPath();
      g.arc(cx, Y(v), 3.2, 0, 7);
      g.fill();
    });
    if (o.hover != null) {
      const hx = X(o.hover);
      g.strokeStyle = 'rgba(235,227,210,.3)';
      g.setLineDash([2, 3]);
      g.beginPath();
      g.moveTo(hx, Tt);
      g.lineTo(hx, Tt + ph);
      g.stroke();
      g.setLineDash([]);
      const i0 = Math.floor(o.hover) % 24,
        txt = hhmm(o.hover) + '  ' + o.series.map((s) => o.fmt(s.y[i0])).join(' → ');
      g.font = '12px Spline Sans Mono, monospace';
      g.textBaseline = 'alphabetic';
      g.textAlign = hx > W * 0.6 ? 'right' : 'left';
      g.fillStyle = 'rgba(235,227,210,.95)';
      g.fillText(txt, hx + (hx > W * 0.6 ? -6 : 6), Tt + ph - 8);
    }
    (o.notes || []).forEach((n) => {
      g.font = 'italic 14px Newsreader, Georgia, serif';
      g.fillStyle = 'rgba(235,227,210,.92)';
      g.textAlign = 'right';
      g.textBaseline = 'alphabetic';
      const px = X(n.h),
        py = Y(n.v),
        tx = px - 26;
      g.fillText(n.t, tx, Tt - 8);
      g.strokeStyle = 'rgba(235,227,210,.6)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(tx + 4, Tt - 5);
      g.quadraticCurveTo(px - 4, Tt - 2, px - 0.5, py - 4);
      g.stroke();
      g.beginPath();
      g.moveTo(px - 3.5, py - 8);
      g.lineTo(px - 0.5, py - 3);
      g.lineTo(px + 2.5, py - 8);
      g.stroke();
    });
    cv._geo = { L, pw };
  }

  /* ---------- dock: campaign chips, chart, counters ---------- */
  function buildChips() {
    const c = $('#chips');
    c.innerHTML = '';
    const all = document.createElement('button');
    all.className = 'chip';
    all.textContent = 'All campaigns';
    all.addEventListener('click', () => {
      Ctx.mask = Ctx.mask === 31 ? 0 : 31;
      scenarioChanged('mask');
    });
    c.append(all);
    c._all = all;
    CAMP.forEach((cp, i) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = cp.label;
      b.setAttribute('aria-pressed', 'true');
      b.addEventListener('click', () => {
        Ctx.mask ^= 1 << i;
        scenarioChanged('mask');
      });
      c.append(b);
    });
  }
  function refreshChips() {
    const c = $('#chips');
    c._all.classList.toggle('on', Ctx.mask === 31);
    Array.from(c.children)
      .slice(1)
      .forEach((b, i) => {
        const on = (Ctx.mask >> i) & 1;
        b.classList.toggle('on', !!on);
        b.setAttribute('aria-pressed', String(!!on));
      });
    $$('#campList input').forEach((inp, i) => {
      inp.checked = !!((Ctx.mask >> i) & 1);
    });
  }
  let tiles = {};
  function buildTiles() {
    const defs = [
      ['sav', 'Energy saved today'],
      ['co2', 'Carbon avoided'],
      ['inr', 'Bill saved'],
      ['pk', 'Peak shaved'],
      ['sol', 'Solar now'],
      ['cov', 'Measured coverage'],
    ];
    const t = $('#tiles');
    t.innerHTML = '';
    defs.forEach((d) => {
      const e = document.createElement('div');
      e.className = 'tile';
      e.innerHTML = '<span class="lbl">' + d[1] + '</span><span class="v">0</span><span class="s"></span>';
      t.append(e);
      tiles[d[0]] = { v: e.children[1], s: e.children[2], cur: 0, tgt: 0 };
    });
  }
  function statsNow() {
    const base = Sim.totals(0, Ctx.day),
      mid = Sim.totals(Ctx.mask, Ctx.day);
    let kwh = 0,
      co = 0;
    for (let h = 0; h < 24; h++) {
      const f = clamp(Ctx.t - h, 0, 1);
      if (f <= 0) break;
      const d = (base[h] - mid[48 + h]) * f;
      kwh += d;
      co += (d * ci(h)) / 1000;
    }
    let pb = 0,
      pm = 0;
    for (let h = 0; h < 24; h++) {
      pb = Math.max(pb, base[h]);
      pm = Math.max(pm, mid[48 + h]);
    }
    const CA = campusAssets(),
      kwp =
        CA.reduce((s, a) => s + (a.solarKwp || 0), 0) +
        CAMPS.filter((c) => Ctx.campus === 'all' || c.id === Ctx.campus).reduce((s, c) => s + c.solarBase, 0),
      meas = CA.filter((a) => a.measured).length;
    return {
      kwh,
      co,
      inr: kwh * 7.5,
      pk: pb - pm,
      sol: kwp * sunEl(Ctx.t) * 0.8,
      kwp,
      meas,
      n: Math.max(1, campusAssets().length),
      now0: base[Math.floor(Ctx.t) % 24],
      now1: mid[48 + (Math.floor(Ctx.t) % 24)],
    };
  }
  function refreshTiles() {
    const s = statsNow();
    tiles.sav.tgt = s.kwh;
    tiles.co2.tgt = s.co;
    tiles.inr.tgt = s.inr;
    tiles.pk.tgt = s.pk;
    tiles.sol.tgt = s.sol;
    tiles.cov.tgt = (s.meas / s.n) * 100;
    tiles.sav.s.textContent = 'kWh since midnight';
    tiles.co2.s.textContent = 'kg of CO2e, modelled grid';
    tiles.inr.s.textContent = 'at ₹7.5 a unit, a placeholder';
    tiles.pk.s.textContent = Ctx.campus === 'all' ? 'kW, both campuses' : 'kW, this campus';
    tiles.sol.s.textContent =
      'of ' +
      s.kwp +
      ' kWp' +
      (Ctx.campus === 'iitgn'
        ? ' (reported)'
        : Ctx.campus === 'mujaipur'
          ? ' (placeholder)'
          : Ctx.campus === 'all'
            ? ' (mixed sources)'
            : '');
    tiles.cov.s.textContent = s.meas + ' of ' + fmtN(s.n) + ' have meter readings';
    return s;
  }
  function animTiles() {
    const f = (k, fmt) => {
      const t = tiles[k];
      t.cur += (t.tgt - t.cur) * 0.18;
      if (Math.abs(t.tgt - t.cur) < 0.01) t.cur = t.tgt;
      t.v.textContent = fmt(t.cur);
    };
    f('sav', (v) => '≈ ' + fmtN(v));
    f('co2', (v) => '≈ ' + fmtN(v));
    f('inr', (v) => '≈ ₹' + fmtN(v));
    f('pk', (v) => '≈ ' + fmtN(v));
    f('sol', (v) => fmtN(v) + ' kW');
    f('cov', (v) => v.toFixed(v < 10 ? 1 : 0) + '%');
  }
  function drawChart() {
    const base = Sim.totals(0, Ctx.day),
      b = Array.from(base.slice(0, 24)),
      lf = Array.from(Sim.totals(Ctx.mask, Ctx.day).slice(48, 72)),
      lo = Array.from(Sim.totals(Ctx.mask, Ctx.day).slice(24, 48)),
      hi = Array.from(Sim.totals(Ctx.mask, Ctx.day).slice(72, 96));
    const ymax = Math.max(...b) * 1.1;
    let pk = 17,
      pv = 0;
    for (let h = 16; h < 24; h++)
      if (b[h] > pv) {
        pv = b[h];
        pk = h;
      }
    const o = {
      ymax,
      fmt: fmtKW,
      heat: true,
      solar: true,
      l: 52,
      hover: chartHov,
      notes: [{ h: pk, v: pv, t: 'Dinner, geysers and every AC at once' }],
      series: [{ y: b, c: '#A9A08E', dash: [4, 3], w: 1.3 }],
    };
    if (Ctx.mask) {
      o.series.push({ y: lf, c: '#7FB2E5', w: 2 });
      o.band = { lo: hi, hi: lo };
    }
    plot($('#chart'), o);
  }
  $('#chart').addEventListener('pointerdown', (e) => {
    const cv = e.currentTarget;
    cv.setPointerCapture(e.pointerId);
    cv._drag = true;
    scrub(e);
  });
  let chartHov = null;
  $('#chart').addEventListener('pointermove', (e) => {
    const cv = e.currentTarget;
    if (cv._drag) scrub(e);
    else {
      const r = cv.getBoundingClientRect(),
        g = cv._geo || { L: 52, pw: r.width - 60 };
      chartHov = clamp(((e.clientX - r.left - g.L) / g.pw) * 24, 0, 23.99);
      drawChart();
    }
  });
  $('#chart').addEventListener('pointerleave', () => {
    chartHov = null;
    drawChart();
  });
  $('#chart').addEventListener('pointerup', (e) => {
    e.currentTarget._drag = false;
  });
  function scrub(e) {
    const cv = $('#chart'),
      r = cv.getBoundingClientRect(),
      g = cv._geo || { L: 52, pw: r.width - 60 };
    Ctx.t = clamp(((e.clientX - r.left - g.L) / g.pw) * 24, 0, 23.99);
    timeChanged();
  }
  $('#play').addEventListener('click', () => {
    Ctx.playing = !Ctx.playing;
    $('#playIcon').setAttribute('d', Ctx.playing ? 'M4 3h3v10H4zM9 3h3v10H9z' : 'M5 3l8 5-8 5z');
    $('#play').setAttribute('aria-label', Ctx.playing ? 'Pause' : 'Play the day');
  });
  const PRE = [
    ['Dawn', 6.5],
    ['Noon', 12.5],
    ['Evening peak', 19.5],
    ['Midnight', 0.5],
  ];
  $('#presets').innerHTML = PRE.map((p) => '<button data-h="' + p[1] + '">' + p[0] + '</button>').join('');
  $('#presets').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) {
      Ctx.t = +b.dataset.h;
      timeChanged();
    }
  });
  $$('#daySeg button').forEach((b) =>
    b.addEventListener('click', () => {
      Ctx.day = b.dataset.d;
      $$('#daySeg button').forEach((x) => x.classList.toggle('on', x === b));
      scenarioChanged('day');
    }),
  );

  /* ---------- state change handlers ---------- */
  let flowT = 0;
  function timeChanged() {
    A.setEnv(Ctx.t);
    B.setEnv(Ctx.t);
    $('#clock').textContent = hhmm(Ctx.t);
    drawChart();
    const s = refreshTiles();
    flowDirty = true;
    listDirty = true;
    Bus.emit('time');
    return s;
  }
  let flowDirty = true,
    listDirty = true;
  function scenarioChanged(why) {
    const t0 = performance.now();
    Sim.fill();
    const ms = performance.now() - t0;
    A.setTrees(3);
    B.setTrees(3 + Math.round((vitality() / 100) * (A.TREES.length - 3)));
    const any = Ctx.mask > 0;
    $('#stageB').hidden = !any;
    $('#divider').hidden = !any;
    refreshChips();
    timeChanged();
    Log.push(
      'model',
      (why === 'day'
        ? 'Day type set to ' + Ctx.day
        : why === 'campus'
          ? 'Scope set to ' + campusLabel()
          : 'Campaigns on: ' + maskNames(Ctx.mask)) +
        '. Campus totals recomputed in ' +
        Sim.lastMs.toFixed(1) +
        ' ms, graphics table refreshed in ' +
        ms.toFixed(1) +
        ' ms, ' +
        Math.round((Sim.hits / (Sim.hits + Sim.miss || 1)) * 100) +
        '% of simulations came from the cache.',
    );
    Bus.emit('scen');
  }

  /* ---------- left: assets ---------- */
  const kindOpts = ['all'].concat(Object.keys(ARCH));
  $('#kindSel').innerHTML = kindOpts
    .map((k) => '<option value="' + k + '">' + (k === 'all' ? 'All archetypes' : ARCH[k].label) + '</option>')
    .join('');
  $('#campusSel').addEventListener('change', () => {
    Ctx.campus = $('#campusSel').value;
    listDirty = true;
    let v;
    if (Ctx.campus === 'test') {
      const tt = Registry.assets.filter((a) => a.campus === 'test'),
        cols = Math.min(46, tt.length),
        rws = Math.ceil(tt.length / 46),
        cx = 300 + cols * 17,
        cz = 900 + rws * 17,
        span = Math.max(cols, rws) * 34 + 420;
      v = [new T.Vector3(cx + span * 0.25, span * 0.75, cz + span * 0.85), new T.Vector3(cx, 0, cz)];
    } else v = viewsFor().home;
    flyTo(v[0].clone(), v[1].clone(), 1200);
    $$('#views button').forEach((x) => x.classList.toggle('on', x.dataset.v === 'home'));
    scenarioChanged('campus');
  });
  function refreshCampusSel() {
    const cur = Ctx.campus || 'all',
      cnt = (id) => Registry.assets.filter((a) => a.campus === id).length,
      m = cnt('test');
    $('#campusSel').innerHTML =
      '<option value="all">Both campuses · ' +
      fmtN(Registry.assets.length) +
      ' assets</option>' +
      CAMPS.map(
        (c) => '<option value="' + c.id + '">' + c.name + ' · ' + fmtN(cnt(c.id)) + ' assets</option>',
      ).join('') +
      (m ? '<option value="test">Test district · ' + fmtN(m) + ' assets</option>' : '');
    $('#campusSel').value = cur;
  }
  const RH = 34;
  let rows = [];
  function buildRows() {
    const q = $('#q').value.trim().toLowerCase(),
      k = $('#kindSel').value,
      sort = $('#sortSel').value;
    rows = Registry.assets.filter(
      (a) =>
        (k === 'all' || a.arch === k) &&
        (!q || a.name.toLowerCase().includes(q)) &&
        (Ctx.campus === 'all' || a.campus === Ctx.campus),
    );
    const v = (a) =>
      sort === 'load'
        ? -Sim.kw(a, 1, Ctx.t)
        : sort === 'saved'
          ? -(Sim.kw(a, 0, Ctx.t) - Sim.kw(a, 1, Ctx.t))
          : a.name;
    rows.sort((a, b) => {
      const x = v(a),
        y = v(b);
      return typeof x === 'string' ? x.localeCompare(y) : x - y;
    });
    $('#aspacer').style.height = rows.length * RH + 'px';
    $('#afoot1').textContent = fmtN(rows.length) + ' asset' + (rows.length === 1 ? '' : 's') + ' shown';
    $('#afoot2').textContent = rows.filter((a) => a.measured).length + ' measured';
    renderRows();
  }
  function renderRows() {
    const sc = $('#alist'),
      st = Math.max(0, Math.floor(sc.scrollTop / RH) - 2),
      n = Math.ceil(sc.clientHeight / RH) + 4,
      box = $('#arows');
    box.style.transform = 'translateY(' + st * RH + 'px)';
    box.innerHTML = rows
      .slice(st, st + n)
      .map((a) => {
        const b = Sim.kw(a, 0, Ctx.t),
          l = Sim.kw(a, 1, Ctx.t),
          d = b ? Math.round(((l - b) / b) * 100) : 0;
        return (
          '<div class="vrow' +
          (a.idx === Ctx.sel ? ' sel' : '') +
          '" data-i="' +
          a.idx +
          '"><i class="dot ' +
          (a.measured ? 'meas' : 'mod') +
          '"></i><span class="nm">' +
          esc(a.name) +
          '</span><span class="kd">' +
          ARCH[a.arch].label.split(' ')[0] +
          '</span><span class="kw">' +
          fmtKW(l) +
          (Ctx.mask && d ? ' <span style="color:var(--teal)">' + d + '%</span>' : '') +
          '</span></div>'
        );
      })
      .join('');
  }
  $('#alist').addEventListener('scroll', renderRows);
  $('#arows').addEventListener('click', (e) => {
    const r = e.target.closest('.vrow');
    if (r) {
      setSelection(+r.dataset.i, true);
      setTab('right', 'insp');
    }
  });
  ['q', 'kindSel', 'sortSel'].forEach((id) =>
    $('#' + id).addEventListener('input', () => {
      $('#alist').scrollTop = 0;
      buildRows();
    }),
  );
  /* layers */
  const LDEF = [
    ['win', 'Lit windows', "Windows light up in proportion to each building's load"],
    ['halo', 'Ground wash', 'Brightness is the load. Colour is how carbon-heavy the grid is'],
    ['conf', 'Outlines', 'Solid outline: has meter readings. Dashed: modelled'],
    ['flows', 'Energy flows', 'Lines from the substation to the 24 heaviest loads. Gold lines carry solar'],
    [
      'solar',
      'Solar panels',
      'IITGN reports 500 kWp on roofs and a carport; Manipal Jaipur has one mapped array of unknown size (200 kWp placeholder). Glow follows the sun',
    ],
    ['trees', 'Greenery', 'Grows as more campaigns switch on, standing in for verified savings'],
    ['labels', 'Labels', 'Names on the plant, the carport and the substation'],
    ['bloom', 'Soft glow', 'A halo around bright lights. Turn it off on a slow graphics card'],
  ];
  $('#layerList').innerHTML = LDEF.map(
    (l) =>
      '<label class="tog"><b>' +
      l[1] +
      '</b><small>' +
      l[2] +
      '</small><span class="sw"><input type="checkbox" data-l="' +
      l[0] +
      '" checked><i></i></span></label>',
  ).join('');
  $$('#layerList input').forEach((i) =>
    i.addEventListener('change', () => {
      Layers[i.dataset.l] = i.checked;
      A.applyLayers();
      B.applyLayers();
    }),
  );
  /* campaigns + saved scenarios */
  $('#campList').innerHTML = CAMP.map(
    (c, i) =>
      '<label class="tog"><b>' +
      c.label +
      '</b><small>' +
      c.note +
      ' ' +
      c.txt +
      '</small><span class="sw"><input type="checkbox" data-c="' +
      i +
      '" checked><i></i></span></label>',
  ).join('');
  $$('#campList input').forEach((i) =>
    i.addEventListener('change', () => {
      Ctx.mask = (Ctx.mask & ~(1 << +i.dataset.c)) | ((i.checked ? 1 : 0) << +i.dataset.c);
      scenarioChanged('mask');
    }),
  );
  const maskNames = (m, short) => {
    const on = CAMP.filter((c, i) => (m >> i) & 1);
    return !on.length
      ? 'none'
      : on.length === CAMP.length
        ? short
          ? 'all five'
          : 'all five campaigns'
        : short
          ? on.length + ' campaigns'
          : on.map((c) => c.label).join(', ');
  };
  const Saved = [
    { name: 'Full Mission LiFE', mask: 31 },
    { name: 'AC at 26 and shift the peak', mask: 4 | 1 },
  ];
  function savedStats(mask) {
    const b = Sim.totals(0, Ctx.day),
      m = Sim.totals(mask, Ctx.day);
    let kwh = 0,
      co = 0,
      pb = 0,
      pm = 0;
    for (let h = 0; h < 24; h++) {
      const d = b[h] - m[48 + h];
      kwh += d;
      co += (d * ci(h)) / 1000;
      pb = Math.max(pb, b[h]);
      pm = Math.max(pm, m[48 + h]);
    }
    return { kwh, co, pk: pb - pm };
  }
  function renderSaved() {
    $('#savedList').innerHTML = Saved.map((s, i) => {
      const st = savedStats(s.mask);
      return (
        '<div class="card"><div class="row"><b>' +
        esc(s.name) +
        '</b><button class="btn" data-ap="' +
        i +
        '">Apply</button></div><div class="foot" style="display:block">Saves ' +
        fmtN(st.kwh) +
        ' kWh and ' +
        fmtN(st.co) +
        ' kg of CO2e a day. The peak drops by ' +
        fmtN(st.pk) +
        ' kW.</div></div>'
      );
    }).join('');
    $('#scenNote').textContent = Saved.length + ' saved · ' + Sim.order.length + ' of 6 scenarios cached';
  }
  $('#savedList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ap]');
    if (b) {
      Ctx.mask = Saved[+b.dataset.ap].mask;
      scenarioChanged('mask');
    }
  });
  $('#btnSave').addEventListener('click', () => {
    Saved.push({
      name: 'Scenario ' + (Saved.length + 1) + ' · ' + maskNames(Ctx.mask, true),
      mask: Ctx.mask,
    });
    renderSaved();
    toast('Scenario saved');
    Log.push('model', 'Scenario saved: ' + maskNames(Ctx.mask) + '.');
  });

  /* ---------- leaderboard: the gamified layer, scored fairly ---------- */
  const HOOD = [
    ['Central hostels', 78, 12, 'iitgn'],
    ['West hostels', 64, 9, 'iitgn'],
    ['South hostels', 52, 6, 'iitgn'],
    ['Academic core', 35, 4, 'iitgn'],
    ['Residential blocks', 58, 7, 'iitgn'],
    ['Dining', 88, 14, 'iitgn'],
    ['Recreation', 45, 5, 'iitgn'],
    ['B blocks', 78, 12, 'mujaipur'],
    ['G blocks', 64, 9, 'mujaipur'],
    ['Teaching complex', 35, 4, 'mujaipur'],
    ['Faculty apartments', 58, 7, 'mujaipur'],
    ['Dining ', 88, 14, 'mujaipur'],
    ['Recreation ', 45, 5, 'mujaipur'],
  ];
  const hoodsHere = () =>
    HOOD.filter((h) => Ctx.campus === 'all' || h[3] === Ctx.campus || Ctx.campus === 'test');
  function hoodStats() {
    return hoodsHere()
      .map((h) => {
        const as = Registry.assets.filter((a) => a.campus === h[3] && a.group === h[0].trim());
        let b = 0,
          m = 0;
        as.forEach((a) => {
          const x = Sim.get(a);
          for (let i = 0; i < 24; i++) {
            b += x[i];
            m += x[48 + i];
          }
        });
        const cut = b ? (b - m) / b : 0;
        return { name: h[0], campus: h[3], part: h[1], streak: h[2], cut, score: (cut * h[1]) / 100 };
      })
      .sort((p, q) => q.score - p.score);
  }
  function vitality() {
    const H = hoodsHere(),
      part = H.reduce((x, h) => x + h[1], 0) / Math.max(1, H.length) / 100,
      on = Ctx.mask.toString(2).split('1').length - 1;
    return Math.round(clamp((on / 5) * 60 + part * 40 * (on ? 1 : 0.2), 0, 100));
  }
  function renderHood() {
    const s = hoodStats(),
      mx = Math.max(...s.map((x) => x.score), 0.001),
      v = vitality(),
      lvl = Math.round((v / 100) * 4),
      C = 2 * Math.PI * 30;
    $('#vitNum').textContent = v + ' / 100';
    $('#vitNote').textContent =
      'Greenery level ' + lvl + ' of 4. It rises as more campaigns switch on and more people take part.';
    $('#vitRing').innerHTML =
      '<circle cx="38" cy="38" r="30" fill="none" stroke="rgba(235,227,210,.14)" stroke-width="6"/><circle cx="38" cy="38" r="30" fill="none" stroke="#7FA37A" stroke-width="6" stroke-dasharray="' +
      ((C * v) / 100).toFixed(1) +
      ' ' +
      C.toFixed(1) +
      '" transform="rotate(-90 38 38)"/>';
    $('#hoodList').innerHTML = s
      .map(
        (x, i) =>
          '<div class="hood"><span class="rk mono">' +
          (i + 1) +
          '</span><div><div class="row"><b>' +
          x.name.trim() +
          (Ctx.campus === 'all'
            ? ' <small style="color:var(--faint);font-weight:400">' +
              (x.campus === 'iitgn' ? 'IITGN' : 'MUJ') +
              '</small>'
            : '') +
          '</b><span class="mono">' +
          (x.score * 100).toFixed(1) +
          '% saved</span></div><div class="stack"><i style="width:' +
          ((x.score / mx) * 100).toFixed(1) +
          '%;background:#E0A93B"></i></div><div class="foot"><span>' +
          x.part +
          '% taking part</span><span>' +
          x.streak +
          '-day streak</span></div></div></div>',
      )
      .join('');
  }
  /* ---------- citizen view: what one resident sees ---------- */
  let lastCit = 0;
  function renderCitizen(force) {
    const now = performance.now();
    if (!force && now - lastCit < 220) return;
    lastCit = now;
    const cz = (CAMPS.find((c) => c.id === Ctx.campus) || CAMPS[0]).citizen,
      a = Registry.assets.find((x) => x.name === cz.asset) || Registry.assets[0],
      rooms = 380,
      arr = Sim.get(a),
      h0 = Math.floor(Ctx.t);
    let b = 0,
      m = 0,
      fb = 0,
      fm = 0;
    for (let h = 0; h < 24; h++) {
      fb += arr[h];
      fm += arr[48 + h];
      if (h <= h0) {
        const f = h === h0 ? Ctx.t - h0 : 1;
        b += arr[h] * f;
        m += arr[48 + h] * f;
      }
    }
    const mine = m / rooms,
      avg = b / rooms,
      under = avg ? Math.round((1 - mine / avg) * 100) : 0,
      perDay = (fb - fm) / rooms,
      on = Ctx.mask.toString(2).split('1').length - 1,
      rank = hoodStats().findIndex((x) => x.name === cz.group) + 1;
    $('#p-cit').innerHTML =
      '<div class="phone"><div class="hd"><b>Room 214</b><span>' +
      esc(a.name) +
      '</span></div>' +
      '<div><span class="lbl">Used so far today</span><div class="big">' +
      mine.toFixed(1) +
      ' kWh</div><div class="delta ' +
      (under > 0 ? 'neg' : '') +
      '">' +
      (under > 0 ? under + '% under' : 'on par with') +
      ' the usual for this hostel</div></div>' +
      '<canvas id="phBars" class="plot" style="height:70px"></canvas>' +
      '<div><span class="lbl">Your actions</span>' +
      CAMP.map(
        (c, i) =>
          '<label class="act"><input type="checkbox" data-a="' +
          i +
          '"' +
          ((Ctx.mask >> i) & 1 ? ' checked' : '') +
          '><span><b>' +
          c.label +
          '</b><small>' +
          c.note +
          '</small></span><span class="pts">+' +
          (10 + i * 5) +
          '</span></label>',
      ).join('') +
      '</div>' +
      '<div class="foot" style="display:block;line-height:1.55">' +
      (on ? 'You are saving about ' + perDay.toFixed(1) + ' kWh a day. ' : 'No actions on yet. ') +
      'Streak: ' +
      (HOOD.find((h) => h[0] === cz.group) || HOOD[0])[2] +
      ' days. ' +
      cz.group +
      ' are ranked ' +
      rank +
      ' of ' +
      hoodStats().length +
      '. Points this week: ' +
      (120 + on * 40) +
      '. All of this is made up.</div></div>';
    $$('#p-cit input').forEach((i) =>
      i.addEventListener('change', () => {
        Ctx.mask ^= 1 << +i.dataset.a;
        scenarioChanged('mask');
      }),
    );
    const cv = $('#phBars');
    if (!cv) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2),
      W = cv.clientWidth,
      H = cv.clientHeight;
    if (!W) return;
    cv.width = W * dpr;
    cv.height = H * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const full = fb / rooms,
      vals = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(
        (d, i) => full * (0.92 + 0.14 * Math.abs(Math.sin(i * 1.9 + 1))),
      ),
      mx = Math.max(...vals, full) * 1.1,
      bw = W / 7;
    g.font = '11px Spline Sans Mono, monospace';
    g.textAlign = 'center';
    vals.concat([mine]).forEach((v, i) => {
      const hh = (v / mx) * (H - 18);
      g.fillStyle = i === 6 ? '#E0A93B' : 'rgba(235,227,210,.28)';
      g.fillRect(i * bw + bw * 0.2, H - 14 - hh, bw * 0.6, hh);
      g.fillStyle = 'rgba(169,160,142,.9)';
      g.fillText(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Today'][i], i * bw + bw / 2, H - 2);
    });
    const ay = H - 14 - (full / mx) * (H - 18);
    g.strokeStyle = 'rgba(235,227,210,.5)';
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(0, ay);
    g.lineTo(W, ay);
    g.stroke();
    g.setLineDash([]);
  }
  Bus.on('cit', () => renderCitizen(true));
  Bus.on('time', () => {
    if (Ctx.tab === 'cit') renderCitizen();
  });
  Bus.on('scen', () => {
    if (Ctx.tab === 'cit') renderCitizen(true);
  });
  /* ---------- right: inspector ---------- */
  function inspector() {
    const p = $('#p-insp'),
      i = Ctx.hov >= 0 ? Ctx.hov : Ctx.sel,
      s = statsNow();
    if (i < 0) {
      const kinds = {};
      campusAssets().forEach((a) => {
        kinds[a.arch] = (kinds[a.arch] || 0) + Sim.kw(a, 0, Ctx.t);
      });
      const tot = Object.values(kinds).reduce((x, y) => x + y, 0) || 1;
      const cols = [
        '#6FA8DC',
        '#E0A93B',
        '#C8452B',
        '#7FA37A',
        '#B9A98A',
        '#8E7CC3',
        '#D98F6B',
        '#5E8F9C',
        '#A9A08E',
      ];
      const top = campusAssets()
        .map((a) => ({ a, k: Sim.kw(a, 0, Ctx.t) }))
        .sort((x, y) => y.k - x.k)
        .slice(0, 5);
      p.innerHTML =
        '<div class="card"><span class="lbl">Campus now · ' +
        hhmm(Ctx.t) +
        '</span><div class="big">' +
        fmtKW(s.now0) +
        (Ctx.mask ? ' <small>→</small> ' + fmtKW(s.now1) : '') +
        '</div>' +
        (Ctx.mask
          ? '<div class="delta neg">' + Math.round(((s.now1 - s.now0) / s.now0) * 100) + '% vs baseline</div>'
          : '') +
        '<div class="stack">' +
        Object.keys(kinds)
          .map(
            (k, j) =>
              '<i style="width:' +
              (kinds[k] / tot) * 100 +
              '%;background:' +
              cols[j % cols.length] +
              '"></i>',
          )
          .join('') +
        '</div><div class="legend">' +
        Object.keys(kinds)
          .map(
            (k, j) =>
              '<span style="--c:' +
              cols[j % cols.length] +
              '">' +
              ARCH[k].label +
              ' ' +
              Math.round((kinds[k] / tot) * 100) +
              '%</span>',
          )
          .join('') +
        '</div></div>' +
        '<div class="card"><span class="lbl">Heaviest loads now</span>' +
        top
          .map(
            (o) =>
              '<div class="row"><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
              esc(o.a.name) +
              '</span><span class="mono">' +
              fmtKW(o.k) +
              '</span></div>',
          )
          .join('') +
        '</div>' +
        '<div class="foot" style="display:block">Hover a building to read it. Click to fly in. Escape lets go.</div>';
      return;
    }
    const a = Registry.assets[i],
      A2 = ARCH[a.arch],
      b = Sim.kw(a, 0, Ctx.t),
      l = Sim.kw(a, 1, Ctx.t),
      cs = Sim.comps(a, Ctx.t),
      ct = cs.reduce((x, y) => x + y, 0) || 1,
      cc = ['#6FA8DC', '#E0A93B', '#A9A08E', '#C8452B'];
    p.innerHTML =
      '<div class="row"><b style="font-size:14px">' +
      esc(a.name) +
      '</b><span class="chip static"><i class="dot ' +
      (a.measured ? 'meas' : 'mod') +
      '"></i>' +
      (a.measured ? 'Measured' : 'Modelled') +
      '</span></div>' +
      '<div class="card"><span class="lbl">Load at ' +
      hhmm(Ctx.t) +
      '</span><div class="big">' +
      fmtKW(b) +
      (Ctx.mask ? ' <small>→</small> ' + fmtKW(l) : '') +
      '</div>' +
      (Ctx.mask
        ? '<div class="delta neg">' + Math.round(((l - b) / b) * 100) + '% with the selected campaigns</div>'
        : '') +
      '<canvas class="plot" id="spark" style="height:96px"></canvas><span class="lbl">What is driving it</span><div class="stack">' +
      cs.map((v, j) => '<i style="width:' + (v / ct) * 100 + '%;background:' + cc[j] + '"></i>').join('') +
      '</div><div class="legend">' +
      COMP.map(
        (c, j) =>
          '<span style="--c:' +
          cc[j] +
          '">' +
          { cool: 'Cooling', light: 'Lighting', plug: 'Plug', hot: 'Water heating' }[c] +
          ' ' +
          Math.round((cs[j] / ct) * 100) +
          '%</span>',
      ).join('') +
      '</div></div>' +
      '<div class="card"><span class="lbl">Registry record</span><dl class="kv"><dt>id</dt><dd>' +
      a.id +
      '</dd><dt>archetype</dt><dd>' +
      a.arch +
      '@v' +
      A2.v +
      '</dd><dt>campus</dt><dd>' +
      a.campus +
      '</dd><dt>position</dt><dd>' +
      (a.campus === 'test'
        ? 'generated'
        : a.placeholder
          ? 'placeholder'
          : a.estimated
            ? 'inferred'
            : a.added
              ? 'you placed it'
              : a.campus === 'mujaipur'
                ? 'OpenStreetMap outline'
                : 'OpenStreetMap point') +
      '</dd><dt>group</dt><dd>' +
      esc(a.group || '-') +
      '</dd><dt>floors</dt><dd>' +
      a.floors +
      '</dd><dt>floor area</dt><dd>' +
      fmtN(a.w * a.d * a.floors) +
      ' m²</dd><dt>modelled peak</dt><dd>' +
      fmtKW(a.kwPeak) +
      '</dd><dt>rooftop solar</dt><dd>' +
      (a.solarKwp ? a.solarKwp + ' kWp reported' : 'none') +
      '</dd><dt>revision</dt><dd>' +
      a.rev +
      '</dd></dl></div>' +
      '<div class="card"><span class="lbl">Data lineage</span><div class="foot" style="display:block;line-height:1.6">' +
      (a.measured
        ? 'Meter feed on the ingestion API (demo flag). Baseline fitted on weather-normalised history. Last reading 4 s ago, simulated.'
        : 'No meter. Estimated from the ' +
          A2.label.toLowerCase() +
          ' archetype and floor area. Becomes measured when readings arrive.') +
      '</div></div>' +
      '<div class="row"><button class="btn" id="btnFly">Fly to</button><button class="btn" id="btnClr">Clear selection</button>' +
      (a.measured ? '' : '<button class="btn pri" id="btnMeter">Connect a meter (demo)</button>') +
      '</div>';
    const arr = Sim.get(a),
      bb = Array.from(arr.slice(0, 24)),
      ll = Array.from(arr.slice(48, 72));
    plot($('#spark'), {
      ymax: Math.max(...bb) * 1.1,
      fmt: fmtKW,
      l: 44,
      heat: false,
      solar: true,
      series: Ctx.mask
        ? [
            { y: bb, c: '#A9A08E', dash: [4, 3], w: 1.2 },
            { y: ll, c: '#7FB2E5', w: 1.8 },
          ]
        : [{ y: bb, c: '#A9A08E', w: 1.6 }],
    });
    $('#btnFly').onclick = () => flyAsset(a);
    const bm = $('#btnMeter');
    if (bm) bm.onclick = () => connectMeter(a);
    $('#btnClr').onclick = () => setSelection(-1, false);
  }

  function connectMeter(a) {
    const h0 = Sim.hits,
      m0 = Sim.miss,
      t0 = performance.now(),
      f = +(0.88 + Math.random() * 0.2).toFixed(2),
      was = a.rev;
    a.measured = true;
    a.calib = f;
    a.rev++;
    Shared.write(a);
    Shared.meta.needsUpdate = Shared.hmat.needsUpdate = true;
    Shared.rebuild();
    Sim.tot.clear();
    Sim.totals();
    const re = Sim.miss - m0,
      hit = Sim.hits - h0,
      ms = performance.now() - t0;
    Sim.fill();
    A.setFlows();
    B.setFlows();
    Log.push(
      'asset',
      'asset.updated ' +
        a.id +
        ', revision ' +
        was +
        ' to ' +
        a.rev +
        ': a meter is connected and its baseline fitted (x' +
        f +
        '). ' +
        re +
        ' simulation recomputed, ' +
        hit +
        ' served from the cache, totals rebuilt in ' +
        ms.toFixed(1) +
        ' ms.',
    );
    toast(a.name + ' now has a meter feed');
    Bus.emit('registry');
  }
  /* ---------- right: add building and scale test ---------- */
  $('#fArch').innerHTML = Object.keys(ARCH)
    .filter((k) => k !== 'chiller')
    .map((k) => '<option value="' + k + '">' + ARCH[k].label + '</option>')
    .join('');
  $('#fArch').value = 'lab';
  $('#btnPlace').addEventListener('click', () => {
    placing = !placing;
    $('#btnPlace').textContent = placing ? 'Click the map to place' : 'Pick position on map';
    if (!placing) updateGhost();
    else {
      placed = placed || { x: 0, z: 200 };
      updateGhost();
    }
  });
  $('#btnAdd').addEventListener('click', () => {
    const err = $('#addErr');
    err.textContent = '';
    const name = $('#fName').value.trim(),
      fl = +$('#fFloors').value,
      w = +$('#fW').value,
      d = +$('#fD').value;
    if (!name) {
      err.textContent = 'Enter a name for the building.';
      return;
    }
    if (!(fl >= 1 && fl <= 40)) {
      err.textContent = 'Floors must be between 1 and 40.';
      return;
    }
    if (!(w >= 8 && w <= 120 && d >= 8 && d <= 120)) {
      err.textContent = 'Width and depth must be between 8 and 120 m.';
      return;
    }
    if (!placed) {
      err.textContent = 'Pick a position on the map first.';
      return;
    }
    const hit = Registry.overlaps(placed.x, placed.z, w, d);
    if (hit) {
      err.textContent = 'Overlaps ' + hit.name + '. Move the building.';
      return;
    }
    if (Registry.assets.length + 1 > Shared.maxCap) {
      err.textContent = 'Mock GPU table is full.';
      return;
    }
    const a = Registry.add({
      name,
      arch: $('#fArch').value,
      group: 'Added in this session',
      campus:
        Ctx.campus === 'all' || Ctx.campus === 'test' ? (placed.x > 900 ? 'mujaipur' : 'iitgn') : Ctx.campus,
      added: true,
      x: placed.x,
      z: placed.z,
      w,
      d,
      h: fl * 3.4,
      floors: fl,
      solarKwp: 0,
      measured: false,
    });
    const r = commit([a], 'add');
    placed = null;
    placing = false;
    $('#btnPlace').textContent = 'Pick position on map';
    $('#posOut').textContent = 'no position';
    updateGhost();
    Log.push(
      'asset',
      'asset.created ' +
        a.id +
        ' (' +
        a.arch +
        '@v' +
        ARCH[a.arch].v +
        '): registry insert ' +
        r.reg.toFixed(2) +
        ' ms, incremental sim ' +
        r.sim.toFixed(2) +
        ' ms, GPU append ' +
        r.tex.toFixed(2) +
        ' ms',
    );
    toast(a.name + ' added to the registry');
    A.ringT = B.ringT = 2;
    [A, B].forEach((W) => W.ring.position.set(a.x, 0.6, a.z));
    setSelection(a.idx, true);
    setTab('right', 'insp');
    refreshCampusSel();
    listDirty = true;
  });
  Shared.maxCap = 4096;
  $$('[data-scale]').forEach((b) =>
    b.addEventListener('click', () => {
      const n = +b.dataset.scale;
      if (Registry.assets.length + n > Shared.maxCap) {
        $('#scaleOut').innerHTML =
          '<span class="err">This mock holds 4,096 assets in one GPU table. The real system tiles assets by area (see the plan).</span>';
        return;
      }
      const t0 = performance.now(),
        list = [],
        k = Registry.assets.filter((a) => a.campus === 'test').length,
        kinds = [
          'academic',
          'academic',
          'residence',
          'residence',
          'residence',
          'hostel',
          'lab',
          'mess',
          'library',
        ];
      for (let i = 0; i < n; i++) {
        const j = k + i,
          col = j % 46,
          row = Math.floor(j / 46);
        const arch = kinds[Math.floor(Math.random() * kinds.length)],
          fl = 2 + Math.floor(Math.random() * 10);
        list.push(
          Registry.add({
            name: 'Test building ' + String(j + 1).padStart(4, '0'),
            arch,
            campus: 'test',
            group: 'Test district',
            x: 300 + col * 34,
            z: 900 + row * 34,
            w: 20 + Math.random() * 10,
            d: 16 + Math.random() * 10,
            h: fl * 3.4,
            floors: fl,
            solarKwp: 0,
            measured: false,
          }),
        );
      }
      const tReg = performance.now() - t0,
        keysN = Math.max(1, Sim.tot.size),
        r = commit(list, 'scale');
      const kk = Sim.key(Ctx.mask, Ctx.day);
      Sim.mem.delete(kk);
      [...Sim.tot.keys()].forEach((x) => {
        if (x.indexOf(kk + '|') === 0) Sim.tot.delete(x);
      });
      const q = performance.now();
      Sim.totals();
      const full = performance.now() - q;
      let probe = 0;
      {
        const q2 = performance.now();
        for (let i = 0; i < 20; i++) Sim.compute(Registry.assets[0], Ctx.mask, Ctx.day);
        probe = (performance.now() - q2) / 20;
      }
      Sim.fill();
      Log.push(
        'asset',
        'asset.bulk_created ' + n + ' assets via the same registry path in ' + r.total.toFixed(1) + ' ms',
      );
      $('#scaleOut').innerHTML =
        '<dl class="kv"><dt>added to the registry</dt><dd>' +
        n +
        ' assets in ' +
        tReg.toFixed(1) +
        ' ms</dd><dt>new assets, per cached scenario</dt><dd>' +
        (r.sim / keysN).toFixed(1) +
        ' ms</dd><dt>one more building from here</dt><dd>' +
        probe.toFixed(2) +
        ' ms</dd><dt>starting over, same scenario</dt><dd>' +
        full.toFixed(1) +
        ' ms</dd><dt>graphics upload</dt><dd>' +
        r.tex.toFixed(1) +
        ' ms</dd><dt>assets now</dt><dd>' +
        fmtN(Registry.assets.length) +
        '</dd><dt>graphics table</dt><dd>' +
        fmtN(Shared.cap) +
        ' slots' +
        (r.grew ? ' (grown)' : '') +
        '</dd></dl>';
      refreshCampusSel();
      $('#campusSel').value = 'test';
      Ctx.campus = 'test';
      const tot = Registry.assets.filter((a) => a.campus === 'test').length,
        cols = Math.min(46, tot),
        rws = Math.ceil(tot / 46),
        cx = 300 + cols * 17,
        cz = 900 + rws * 17,
        span = Math.max(cols, rws) * 34 + 420;
      flyTo(new T.Vector3(cx + span * 0.25, span * 0.75, cz + span * 0.85), new T.Vector3(cx, 0, cz), 1200);
      listDirty = true;
      toast(fmtN(n) + ' assets added');
    }),
  );

  /* ---------- right: system and events ---------- */
  function buildSvc() {
    $('#svcGrid').innerHTML = Svc.names
      .map(
        (n, i) =>
          '<div class="card"><span class="lbl">' +
          n +
          '</span><span class="v" id="sv' +
          i +
          '">-</span><canvas id="ss' +
          i +
          '"></canvas></div>',
      )
      .join('');
  }
  function spark(cv, arr, color) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2),
      W = cv.clientWidth,
      H = cv.clientHeight;
    if (!W) return;
    cv.width = W * dpr;
    cv.height = H * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const mx = Math.max(...arr, 1),
      mn = Math.min(...arr, 0);
    g.beginPath();
    arr.forEach((v, i) =>
      g[i ? 'lineTo' : 'moveTo'](
        (i / (arr.length - 1 || 1)) * W,
        H - 2 - ((v - mn) / (mx - mn || 1)) * (H - 4),
      ),
    );
    g.strokeStyle = color;
    g.lineWidth = 1.5;
    g.stroke();
  }
  function systemPane() {
    const down = Ctx.health === 'down';
    Svc.val.forEach((v, i) => {
      const e = $('#sv' + i);
      if (!e) return;
      e.textContent =
        (i === 2 ? v.toFixed(0) : i === 1 ? fmtN(v) : Math.round(v)) + (Svc.unit[i] ? ' ' + Svc.unit[i] : '');
      spark($('#ss' + i), Svc.ser[i], down && (i === 0 || i === 3 || i === 5) ? '#C8452B' : '#7FB2E5');
    });
    const st = (ok) => (ok ? '#7FB2E5' : '#C8452B'),
      nodes = [
        ['Web', 10, 70, 60, 30, true],
        ['API', 100, 70, 50, 30, true],
        ['Cache', 200, 14, 60, 30, !down],
        ['Workers', 200, 70, 60, 30, true],
        ['Postgres', 200, 126, 60, 30, !down],
        ['Ingest', 100, 126, 50, 30, true],
        ['Meters', 10, 126, 60, 30, true],
      ];
    $('#archG').innerHTML =
      '<path class="flow" d="M70 85H100M150 85H200M150 80L200 29M150 90L200 141M100 141H70M150 141H200" fill="none" stroke="' +
      (down ? '#C8452B' : '#7FB2E5') +
      '" stroke-opacity=".7"/>' +
      nodes
        .map(
          (n) =>
            '<rect x="' +
            n[1] +
            '" y="' +
            n[2] +
            '" width="' +
            n[3] +
            '" height="' +
            n[4] +
            '" rx="6" fill="#151a2c" stroke="' +
            st(n[5]) +
            '"/><text x="' +
            (n[1] + n[3] / 2) +
            '" y="' +
            (n[2] + 19) +
            '" text-anchor="middle">' +
            n[0] +
            '</text>',
        )
        .join('');
    $('#renderStats').innerHTML =
      '<span class="lbl">Rendering, measured in this page</span><dl class="kv"><dt>frame rate</dt><dd>' +
      Math.round(Svc.fps) +
      ' fps</dd><dt>assets drawn</dt><dd>' +
      fmtN(Registry.assets.length) +
      '</dd><dt>draw calls per frame</dt><dd>' +
      Math.round(A.r.info.render.calls) +
      ' (all passes, one view)</dd><dt>scenario cache</dt><dd>' +
      Sim.order.length +
      ' of 6 kept, ' +
      Math.round((Sim.hits / (Sim.hits + Sim.miss || 1)) * 100) +
      '% hits</dd><dt>last totals pass</dt><dd>' +
      Sim.lastMs.toFixed(1) +
      ' ms</dd></dl>';
  }
  $('#btnChaos').addEventListener('click', () => {
    Ctx.health = Ctx.health === 'ok' ? 'down' : 'ok';
    const down = Ctx.health === 'down';
    $('#banner').hidden = !down;
    $('#btnChaos').textContent = down ? 'Recover the database' : 'Simulate database outage';
    $('#btnChaos').classList.toggle('warn', !down);
    $('#btnChaos').classList.toggle('pri', down);
    $('#chaosNote').textContent = down ? 'Serving a cached snapshot' : 'Running normally';
    $('#chipHealth').innerHTML =
      '<i class="dot ' + (down ? 'bad' : 'ok') + '"></i>' + (down ? 'Degraded mode' : 'All services normal');
    if (down)
      Log.push(
        'system',
        'database unreachable: /readyz failing, API serves the cached campus snapshot, ingestion buffers writes',
      );
    else
      Log.push(
        'system',
        'database recovered: replayed ' +
          fmtN(Svc.queue) +
          ' buffered readings, 0 duplicates (idempotency keys)',
      );
    Bus.emit('svc');
  });
  const EVF = ['all', 'ingest', 'model', 'asset', 'alert', 'system'],
    EVL = {
      all: 'All',
      ingest: 'Readings',
      model: 'Model',
      asset: 'Assets',
      alert: 'Alerts',
      system: 'System',
    };
  $('#evFilters').innerHTML = EVF.map(
    (f) =>
      '<button class="chip' + (f === 'all' ? ' on' : '') + '" data-f="' + f + '">' + EVL[f] + '</button>',
  ).join('');
  $('#evFilters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    Log.filter = b.dataset.f;
    $$('#evFilters .chip').forEach((c) => c.classList.toggle('on', c === b));
    renderEv();
  });
  function renderEv() {
    $('#evFeed').innerHTML = Log.items
      .filter((e) => Log.filter === 'all' || e.type === Log.filter)
      .slice(0, 40)
      .map(
        (e) =>
          '<div class="ev"><time>' +
          e.t +
          '</time><span class="ty ' +
          e.type +
          '">' +
          (EVL[e.type] || e.type) +
          '</span><span class="m">' +
          e.msg +
          '</span></div>',
      )
      .join('');
  }

  /* ---------- bus wiring ---------- */
  Bus.on('sel', () => {
    inspector();
    renderRows();
  });
  Bus.on('hov', inspector);
  Bus.on('time', () => {
    if (Ctx.hov >= 0 || Ctx.sel >= 0) inspector();
    else if (Ctx.tab === 'insp') inspector();
  });
  Bus.on('svc', () => {
    if (Ctx.tab === 'sys') systemPane();
  });
  Bus.on('log', () => {
    if (Ctx.tab === 'ev') renderEv();
  });
  Bus.on('registry', () => {
    buildRows();
    refreshCampusSel();
    timeChanged();
    inspector();
    renderSaved();
  });
  Bus.on('scen', () => {
    renderSaved();
    buildRows();
    renderHood();
  });

  /* ---------- main loop ---------- */
  let last = performance.now(),
    fpsT = 0,
    fpsN = 0;
  let paused = false,
    readySent = false;
  function loop(now) {
    requestAnimationFrame(loop);
    if (paused) {
      last = now;
      return;
    }
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (Ctx.playing) {
      Ctx.t = (Ctx.t + dt * (EMBED ? 0.55 : 1.1)) % 24;
      timeChanged();
    }
    if (Ctx.tt) {
      const f = clamp((now - Ctx.tt.t0) / Ctx.tt.ms, 0, 1),
        e = f * f * (3 - 2 * f);
      Ctx.t = lerp(Ctx.tt.from, Ctx.tt.to, e) % 24;
      timeChanged();
      if (f >= 1) Ctx.tt = null;
    }
    if (tween) {
      const f = clamp((now - tween.t0) / tween.ms, 0, 1),
        e = f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2;
      A.cam.position.lerpVectors(tween.p0, tween.p1, e);
      controls.target.lerpVectors(tween.t0v, tween.t1, e);
      if (f >= 1) tween = null;
    }
    controls.update();
    B.cam.position.copy(A.cam.position);
    B.cam.quaternion.copy(A.cam.quaternion);
    flowT += dt;
    if (flowDirty && flowT > 0.25) {
      flowT = 0;
      flowDirty = false;
      A.setFlows();
      B.setFlows();
    }
    if (
      listDirty &&
      $('#p-assets').classList.contains('on') &&
      (!Ctx.playing || Math.floor(now / 500) % 2 === 0)
    ) {
      listDirty = false;
      buildRows();
    }
    A.tick(dt);
    B.tick(dt);
    A.r.info.reset();
    if (!EMBED || Ctx.mask === 0) A.render();
    if (Ctx.mask > 0) {
      B.r.info.reset();
      B.render();
    }
    if (EMBED && !readySent) {
      readySent = true;
      parent.postMessage({ type: 'lifecity:ready' }, location.origin);
    }
    placeLabels();
    animTiles();
    fpsT += dt;
    fpsN++;
    if (fpsT > 0.5) {
      Svc.fps = fpsN / fpsT;
      $('#chipFps').textContent = Math.round(Svc.fps) + ' fps · ' + fmtN(Registry.assets.length) + ' assets';
      fpsT = 0;
      fpsN = 0;
    }
  }
  window.addEventListener('resize', () => {
    A.resize();
    B.resize();
    setSplit(split);
    drawChart();
  });
  let split = 0.5;
  function setSplit(f) {
    split = clamp(f, 0.12, 0.88);
    app.style.setProperty('--split', split * app.clientWidth + 'px');
  }
  $('#grip').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    $('#grip').setPointerCapture(e.pointerId);
    $('#grip')._d = true;
  });
  $('#grip').addEventListener('pointermove', (e) => {
    if ($('#grip')._d) {
      const r = app.getBoundingClientRect();
      setSplit((e.clientX - r.left) / r.width);
    }
  });
  $('#grip').addEventListener('pointerup', () => {
    $('#grip')._d = false;
  });

  const Story = {
    on: false,
    timer: null,
    steps: [
      {
        t: 12.5,
        mask: 0,
        view: 'home',
        text: 'Noon. Solar is carrying part of the load, and the grid is at its cleanest.',
        ms: 5200,
        tw: 3200,
      },
      {
        t: 17.5,
        mask: 0,
        view: 'home',
        text: 'By evening, every AC, geyser and kitchen switches on together.',
        ms: 4600,
        tw: 3600,
      },
      {
        t: 19.5,
        mask: 0,
        view: 'home',
        text: 'This is the peak: the same energy, but much dirtier power.',
        ms: 4200,
        tw: 2000,
      },
      {
        t: 19.5,
        mask: 31,
        view: 'home',
        text: 'Now switch on five small habits across the campus.',
        ms: 4600,
      },
      {
        t: 19.5,
        mask: 31,
        view: 'hostels',
        text: 'Hostels gain the most. Air conditioning and hot water are their evening load.',
        ms: 5000,
      },
      {
        t: 19.5,
        mask: 31,
        view: 'util',
        text: 'The chiller plant is the biggest single load, so its setpoint matters most.',
        ms: 5000,
      },
      {
        t: 19.5,
        mask: 31,
        view: 'home',
        tab: 'hood',
        text: 'The neighbourhoods that take part climb the ranking.',
        ms: 4400,
      },
      {
        t: 19.5,
        mask: 31,
        view: 'home',
        text: 'Everything here is a row in a registry. Add a building and it joins in.',
        ms: 4400,
      },
    ],
    show(txt) {
      const e = $('#story');
      e.textContent = txt;
      e.hidden = !txt;
    },
    go(i) {
      if (!this.on) return;
      if (i >= this.steps.length) {
        this.stop();
        return;
      }
      const st = this.steps[i];
      this.show(st.text);
      if (st.mask !== Ctx.mask) {
        Ctx.mask = st.mask;
        scenarioChanged('mask');
      }
      const v = viewsFor()[st.view];
      flyTo(v[0].clone(), v[1].clone(), 1400);
      $$('#views button').forEach((x) => x.classList.toggle('on', x.dataset.v === st.view));
      if (st.tab) setTab('left', st.tab);
      let to = st.t;
      if (to < Ctx.t - 0.01) to += 24;
      Ctx.tt = { from: Ctx.t, to: to, t0: performance.now(), ms: st.tw || 2200 };
      this.timer = setTimeout(() => this.go(i + 1), st.ms);
    },
    start() {
      this.on = true;
      Ctx.playing = false;
      $('#playIcon').setAttribute('d', 'M5 3l8 5-8 5z');
      $('#btnStory').textContent = 'Stop the story';
      this.go(0);
    },
    stop() {
      this.on = false;
      clearTimeout(this.timer);
      this.show('');
      $('#btnStory').textContent = 'Play the story';
    },
  };
  $('#btnStory').addEventListener('click', () => Story[Story.on ? 'stop' : 'start']());
  $('#pick').addEventListener('pointerdown', () => {
    if (Story.on) Story.stop();
  });
  window.addEventListener('keydown', (e) => {
    const tg = e.target && e.target.tagName;
    if (tg === 'INPUT' || tg === 'SELECT' || tg === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ') {
      if (tg === 'BUTTON') return;
      e.preventDefault();
      $('#play').click();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      Ctx.t = (Ctx.t + (e.key === 'ArrowRight' ? 0.5 : -0.5) + 24) % 24;
      timeChanged();
    } else if (/^[1-5]$/.test(e.key)) {
      Ctx.mask ^= 1 << (+e.key - 1);
      scenarioChanged('mask');
    }
  });
  buildChips();
  buildTiles();
  buildSvc();
  refreshCampusSel();
  setSplit(0.5);
  Log.push(
    'system',
    'registry loaded: ' +
      Registry.assets.length +
      ' assets, ' +
      Registry.assets.filter((a) => a.measured).length +
      ' flagged measured (demo), archetype library v1',
  );
  Log.push(
    'model',
    'baseline and 5 campaigns simulated per asset, cached by (asset, revision, scenario, day type)',
  );
  Svc.step();
  Svc.step();
  ingestTick();
  scenarioChanged('init');
  inspector();
  renderSaved();
  systemPane();
  renderEv();
  buildRows();
  A.resize();
  B.resize();
  if (EMBED) {
    // Same-origin parents can pause the scene while it is off screen.
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || !e.data) return;
      if (e.data.type === 'lifecity:pause') paused = true;
      if (e.data.type === 'lifecity:play') paused = false;
    });
    const home = (CAMPS.find((c) => c.id === Q.get('campus')) || { home: [HOME.p, HOME.t] }).home;
    Ctx.campus = (CAMPS.find((c) => c.id === Q.get('campus')) || { id: 'all' }).id;
    A.cam.position.copy(home[0]);
    controls.target.copy(home[1]);
    controls.enabled = false;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.35;
    Ctx.t = 21.5;
    Ctx.playing = true;
    refreshCampusSel();
    scenarioChanged('campus');
  }
  requestAnimationFrame(loop);
})();
