// Regenerates api/tests/golden/model_golden.json from the front end's own model code.
//
//   node api/tests/golden/generate.mjs web/app/app.js
//
// The load model exists twice: in web/app/app.js (what the browser draws) and in
// api/app/simulation/model.py (what the server will serve). This script runs the JavaScript version
// and records what it produces, so the Python tests can prove the two still agree. Run it again after
// any change to the model in app.js, and commit the new JSON next to the change.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const appJs = process.argv[2];
if (!appJs) {
  console.error('usage: node generate.mjs <path to web/app/app.js>');
  process.exit(2);
}
const src = readFileSync(appJs, 'utf8');

// Cut a named stretch of source out of app.js. Fails loudly when the anchors move.
const between = (from, to) => {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`anchors not found: ${JSON.stringify([from, to])}`);
  return src.slice(start, end);
};

const helpers = between('const clamp =', 'const fmtN =');
const model = between('/* ---------- context and environment', '/* ---------- asset registry');
const compute = between('    compute(a, mask, day) {', '    get(a, mask = Ctx.mask');

const factory = new Function(`
  ${helpers}
  ${model}
  const Sim = { ${compute} };
  return { Sim, ARCH, CAMP, ci, carbon };
`);
const { Sim, ARCH, CAMP, ci, carbon } = factory();

const PEAK_KW = 1000;
const CAMPAIGNS = CAMP.map((c) => c.key);
const slice = (out, from) => Array.from(out.slice(from, from + 24), (v) => Number(v.toPrecision(12)));

// The JS stores its three effect cases as 24-hour blocks: 72 is the low cut, 48 the mid cut, 24 the high cut.
const bands = (out) => ({ low: slice(out, 72), mid: slice(out, 48), high: slice(out, 24) });
const keysOf = (mask) => CAMPAIGNS.filter((_, i) => (mask >> i) & 1);

const cases = [];
for (const archetype of Object.keys(ARCH)) {
  for (const day of ['weekday', 'weekend']) {
    const building = { arch: archetype, kwPeak: PEAK_KW, calib: 1 };
    const none = Sim.compute(building, 0, day);
    cases.push({ archetype, day, campaigns: [], baseline: slice(none, 0) });
    // All five campaigns, and one mix that includes "shift the peak" (bit 2) and "set it to 26" (bit 0).
    for (const mask of [31, 5]) {
      cases.push({ archetype, day, campaigns: keysOf(mask), ...bands(Sim.compute(building, mask, day)) });
    }
  }
}

const hours = Array.from({ length: 24 }, (_, h) => h);
const golden = {
  generated_from: 'web/app/app.js, Sim.compute',
  peak_kw: PEAK_KW,
  carbon_intensity: hours.map((h) => Number(ci(h).toPrecision(12))),
  carbon_index: hours.map((h) => Number(carbon(h).toPrecision(12))),
  cases,
};
const out = join(dirname(fileURLToPath(import.meta.url)), 'model_golden.json');
writeFileSync(out, JSON.stringify(golden) + '\n');
console.log(`wrote ${cases.length} cases to ${out}`);
