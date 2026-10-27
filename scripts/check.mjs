// Static checks for the site: the landing page at web/ and the control room at web/app/.
// No browser and no dependencies:
//   1. every script parses
//   2. both pages only reference local files that exist, and every in-page anchor has a target
//   3. CDN scripts are pinned to an exact version and carry an integrity hash
//   4. the asset table is well formed (shape, types, known archetypes and campuses, outlines)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const web = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const read = (file) => readFileSync(join(web, file), 'utf8');
const problems = [];
const fail = (message) => problems.push(message);

for (const file of ['app/app.js', 'app/data/assets.js', 'landing/landing.js']) {
  try {
    new vm.Script(read(file), { filename: file });
  } catch (error) {
    fail(`${file} does not parse: ${error.message}`);
  }
}

for (const page of ['index.html', 'app/index.html']) {
  const html = read(page);
  const dir = dirname(page);
  for (const [, ref] of html.matchAll(/(?:src|href)="([^":#?]+)"/g)) {
    const target = ref.endsWith('/') ? join(dir, ref, 'index.html') : join(dir, ref);
    if (!existsSync(join(web, target))) fail(`${page} references a missing file: ${ref}`);
  }
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const [, anchor] of html.matchAll(/href="#([^"]+)"/g)) {
    if (!ids.has(anchor)) fail(`${page} links to #${anchor}, which does not exist`);
  }
  for (const [tag] of html.matchAll(/<script[^>]*src="https:\/\/[^"]+"[^>]*>/g)) {
    if (!/@\d+\.\d+\.\d+\//.test(tag)) fail(`${page}: CDN script is not pinned to an exact version: ${tag}`);
    if (!/integrity="sha384-/.test(tag)) fail(`${page}: CDN script has no integrity hash: ${tag}`);
  }
}

const ARCHETYPES = new Set([
  'hostel',
  'academic',
  'library',
  'hall',
  'mess',
  'sports',
  'chiller',
  'residence',
  'lab',
  'service',
  'unclassified',
]);
const CAMPUSES = new Set(['iitgn', 'mujaipur']);
const FLAGS = new Set(['', 'i', 'p']);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const sandbox = { window: {} };
vm.runInNewContext(read('app/data/assets.js'), sandbox);
const rows = sandbox.window.LIFECITY_ASSETS;

if (!Array.isArray(rows) || rows.length === 0) {
  fail('data/assets.js does not define window.LIFECITY_ASSETS as a non-empty array');
} else {
  const perCampus = {};
  rows.forEach((row, i) => {
    const [name, arch, group, x, z, w, d, h, kwp, measured, flag, outline, campus] = row;
    const at = `assets row ${i} (${name})`;
    if (row.length !== 13) return fail(`${at}: expected 13 fields, found ${row.length}`);
    if (typeof name !== 'string' || !name) fail(`${at}: name must be a non-empty string`);
    if (!ARCHETYPES.has(arch)) fail(`${at}: unknown archetype "${arch}"`);
    if (typeof group !== 'string') fail(`${at}: group must be a string`);
    if (![x, z, w, d, h, kwp].every(isNum))
      fail(`${at}: x, z, width, depth, height and solarKwp must be numbers`);
    if (!(w > 0 && d > 0 && h > 0)) fail(`${at}: width, depth and height must be positive`);
    if (measured !== 0 && measured !== 1) fail(`${at}: measured must be 0 or 1`);
    if (!FLAGS.has(flag)) fail(`${at}: unknown flag "${flag}"`);
    if (!CAMPUSES.has(campus)) fail(`${at}: unknown campus "${campus}"`);
    if (outline !== null) {
      const ok =
        Array.isArray(outline) &&
        outline.length >= 3 &&
        outline.every((p) => p.length === 2 && p.every(isNum));
      if (!ok) fail(`${at}: outline must be null or at least three [x, z] points`);
    }
    perCampus[campus] = (perCampus[campus] || 0) + 1;
  });
  if (!problems.length) {
    const summary = Object.entries(perCampus)
      .map(([c, n]) => `${c} ${n}`)
      .join(', ');
    console.log(`assets: ${rows.length} rows (${summary})`);
  }
}

if (problems.length) {
  console.error(problems.map((p) => `FAIL ${p}`).join('\n'));
  process.exit(1);
}
console.log('check passed');
