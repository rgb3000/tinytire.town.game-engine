/**
 * The traffic module is a pure, canvas-free simulation, and this file is what keeps it one.
 *
 * Purity here is not an aesthetic. It is what lets the whole model be exercised by the
 * Node-only suite: the moment anything under `src/traffic/` reaches for `three`, the engine's
 * `Grid`, a renderer or a DOM global, these tests stop being runnable and the simulation goes
 * back to being observable only by watching the demo. Determinism has the same shape — a
 * single `Math.random()` or `Date.now()` anywhere in the closure means a failing seed cannot
 * be replayed, which is the property Task 8 exists to establish.
 *
 * Two decisions in here are load-bearing:
 *
 * 1. **The transitive closure, not one directory.** `src/traffic/*.ts` is clean by
 *    construction; what it *imports* is where impurity would actually arrive. `route.ts`
 *    reaches `../utils/roadGeometry` and `../highways/highwayGeometry`, and a future edit to
 *    either could pull in `three` without a single line under `src/traffic/` changing. The
 *    scan therefore follows relative imports outwards until the reachable set closes.
 * 2. **Comments and string bodies are removed before scanning for identifiers.** `tuning.ts`
 *    mentions `CAR_SPEED` in prose — deliberately, to explain why the IDM parameters are
 *    *not* map-overridable constants — and a guard that cannot tell prose from code would
 *    either fail on that comment or be weakened until it could not see a real import either.
 *    `stripComments` and `stripStringBodies` below are what make "mentions it" and "depends
 *    on it" different questions, and `scanner self-check` pins both directions.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const TRAFFIC_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(TRAFFIC_DIR, '..');
const REPO_DIR = resolve(SRC_DIR, '..');

// --- source scanning --------------------------------------------------------------------

/**
 * Remove line and block comments, leaving string and template literals intact.
 *
 * Written as a character scanner rather than a regex because a regex cannot tell `//` inside
 * a string from a comment, and the import specifiers this guard reads are strings.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Blank out the *contents* of string and template literals, keeping the quotes. */
export function stripStringBodies(src: string): string {
  return src
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/** Every module specifier the file imports, re-exports, or dynamically imports. */
export function importSpecifiers(src: string): string[] {
  const code = stripComments(src);
  const found: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,          // import … from 'x'; export … from 'x'
    /\bimport\s*['"]([^'"]+)['"]/g,        // import 'x'
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,   // import('x')
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g,  // require('x')
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) found.push(m[1]);
  }
  return found;
}

/** Resolve a relative specifier to a file on disk, trying the extensions this repo uses. */
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/** The non-test TypeScript sources directly under `src/traffic/`. */
function trafficSources(): string[] {
  return readdirSync(TRAFFIC_DIR)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort()
    .map(f => join(TRAFFIC_DIR, f));
}

export interface Closure {
  /** Absolute paths of every source file reachable from `src/traffic/`, including itself. */
  files: string[];
  /** Bare (non-relative) specifiers imported anywhere in the closure, with the importer. */
  external: { file: string; spec: string }[];
  /** Relative specifiers that resolved to nothing on disk. A broken scan, not a clean one. */
  unresolved: { file: string; spec: string }[];
}

/** Follow relative imports outwards from the traffic sources until the set closes. */
export function transitiveClosure(): Closure {
  const files: string[] = [];
  const seen = new Set<string>();
  const external: { file: string; spec: string }[] = [];
  const unresolved: { file: string; spec: string }[] = [];
  const queue = trafficSources();

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);

    for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) { external.push({ file, spec }); continue; }
      const target = resolveRelative(file, spec);
      if (target === null) { unresolved.push({ file, spec }); continue; }
      if (!seen.has(target)) queue.push(target);
    }
  }

  return { files: files.sort(), external, unresolved };
}

const closure = transitiveClosure();
const rel = (f: string): string => relative(REPO_DIR, f);

/** Code with comments gone and string bodies blanked: what the file actually *does*. */
function codeOf(file: string): string {
  return stripStringBodies(stripComments(readFileSync(file, 'utf8')));
}

// --- the rules --------------------------------------------------------------------------

/**
 * Bare module specifiers no file in the closure may import, matched as **prefixes**: the
 * package itself or any subpath of it. Exact matching against an enumerated list let
 * `three/examples/jsm/utils/BufferGeometryUtils.js` and `tone/build/esm/index` straight
 * through — and enumerating `three/webgpu` was the tell that subpaths were known about and
 * being chased one at a time.
 */
const FORBIDDEN_PACKAGES = ['three', 'tone'];

function isForbiddenPackage(spec: string): boolean {
  return FORBIDDEN_PACKAGES.some(p => spec === p || spec.startsWith(`${p}/`));
}

/** Relative import targets no file in the closure may reach. */
const FORBIDDEN_PATHS: { test: (p: string) => boolean; why: string }[] = [
  { test: p => /(^|\/)core\/Grid\.ts$/.test(p), why: "the engine's Grid" },
  { test: p => /(^|\/)rendering\//.test(p), why: 'the renderer' },
  { test: p => /(^|\/)systems\//.test(p), why: 'the engine systems' },
  { test: p => /(^|\/)entities\//.test(p), why: 'the entity classes' },
];

/**
 * Identifiers that must not appear in *code* anywhere in the closure.
 *
 * `Math.random` and the clock break seed reproducibility, which is what makes a failing
 * invariant sweep debuggable rather than a ghost. The DOM globals are what would make the
 * module unloadable in the Node-only suite.
 */
const FORBIDDEN_IDENTIFIERS: { pattern: RegExp; why: string }[] = [
  { pattern: /\bMath\s*\.\s*random\b/, why: 'Math.random (determinism)' },
  { pattern: /\bDate\s*\.\s*now\b/, why: 'Date.now (determinism)' },
  { pattern: /\bnew\s+Date\b/, why: 'new Date (determinism)' },
  { pattern: /(^|[^.\w])document\b/, why: 'document (the DOM)' },
  { pattern: /(^|[^.\w])window\b/, why: 'window (the DOM)' },
  { pattern: /(^|[^.\w])navigator\b/, why: 'navigator (the DOM)' },
  { pattern: /(^|[^.\w])localStorage\b/, why: 'localStorage (the DOM)' },
  { pattern: /(^|[^.\w])requestAnimationFrame\b/, why: 'requestAnimationFrame (the DOM)' },
  { pattern: /\bHTMLCanvasElement\b/, why: 'HTMLCanvasElement (the DOM)' },
  { pattern: /\bWebGL/, why: 'WebGL (the DOM)' },
];

/**
 * Constants a map may override, which `CLAUDE.md` forbids importing as module constants.
 * `src/constants.test.ts` enforces this repo-wide; repeated here because the traffic module
 * is where the temptation lives — a speed limit is exactly the kind of thing a simulation
 * wants to read directly, and the adapter is the one that must resolve it instead.
 */
const OVERRIDABLE_CONSTANTS = ['CAR_SPEED', 'HIGHWAY_SPEED_MULTIPLIER'];

describe('src/traffic purity', () => {
  it('scans a closure that is real: every traffic source, plus what they import', () => {
    const sources = trafficSources().map(rel);
    // The module's own files. Named rather than counted, so deleting one is visible.
    expect(sources).toEqual([
      'src/traffic/diagnose.ts',
      'src/traffic/headway.ts',
      'src/traffic/index.ts',
      'src/traffic/junction.ts',
      'src/traffic/lanes.ts',
      'src/traffic/obstacles.ts',
      'src/traffic/route.ts',
      'src/traffic/routeQueries.ts',
      'src/traffic/snapshot.ts',
      'src/traffic/step.ts',
      'src/traffic/tuning.ts',
      'src/traffic/types.ts',
    ]);

    // The closure must reach *outside* the directory, or the resolver silently scanned
    // nothing and every rule below would pass vacuously.
    const outside = closure.files.map(rel).filter(f => !f.startsWith('src/traffic/'));
    expect(outside).toContain('src/constants.ts');
    expect(outside).toContain('src/utils/roadGeometry.ts');
    expect(outside).toContain('src/highways/highwayGeometry.ts');
    expect(outside.length).toBeGreaterThanOrEqual(5);

    // A relative import that resolves to nothing means the scan stopped early somewhere.
    expect(closure.unresolved.map(u => `${rel(u.file)} -> ${u.spec}`)).toEqual([]);
  });

  it('scanner self-check: it sees code, and does not see prose', () => {
    // Positive control — each rule fires on a planted violation.
    const planted = [
      `import * as THREE from 'three';`,
      `import { Grid } from '../core/Grid';`,
      `const t = Date.now();`,
      `const r = Math.random();`,
      `document.querySelector('canvas');`,
    ].join('\n');
    const plantedCode = stripStringBodies(stripComments(planted));
    expect(importSpecifiers(planted)).toEqual(
      expect.arrayContaining(['three', '../core/Grid']),
    );
    expect(FORBIDDEN_IDENTIFIERS.filter(f => f.pattern.test(plantedCode)).map(f => f.why))
      .toEqual(expect.arrayContaining([
        'Math.random (determinism)', 'Date.now (determinism)', 'document (the DOM)',
      ]));

    // Negative control — the same words in prose are invisible to every rule.
    const prose = [
      '// Deliberately module constants and not keys of GameConstants: a map may set',
      '// CAR_SPEED, and we do not call Math.random() or Date.now() here.',
      '/* three.js, document and window are all named in this block comment. */',
      `const url = 'https://example.com/three';`,
      'export const S0 = 14;',
    ].join('\n');
    const proseCode = stripStringBodies(stripComments(prose));
    expect(FORBIDDEN_IDENTIFIERS.filter(f => f.pattern.test(proseCode))).toEqual([]);
    expect(importSpecifiers(prose)).toEqual([]);
    expect(OVERRIDABLE_CONSTANTS.filter(c => proseCode.includes(c))).toEqual([]);
    // …and the code that survives stripping is still there, so stripping is not just
    // deleting the file.
    expect(proseCode).toContain('export const S0 = 14');
  });

  it('never imports a rendering or audio package', () => {
    const offenders = closure.external
      .filter(e => isForbiddenPackage(e.spec))
      .map(e => `${rel(e.file)} imports ${e.spec}`);
    expect(offenders).toEqual([]);
    // The matcher itself, in both directions — an exact-match rule passed all three subpaths
    // below, and a rule loose enough to catch them must not swallow unrelated packages.
    expect(['three', 'three/webgpu', 'three/examples/jsm/utils/BufferGeometryUtils.js',
      'tone', 'tone/build/esm/index'].filter(isForbiddenPackage))
      .toHaveLength(5);
    expect(['threejs-helper', 'tonegen', 'zod', 'node:fs', '../three'].filter(isForbiddenPackage))
      .toEqual([]);
  });

  it('never reaches the Grid, the renderer, the systems or the entities', () => {
    const offenders: string[] = [];
    for (const file of closure.files) {
      const path = rel(file);
      for (const { test, why } of FORBIDDEN_PATHS) {
        if (test(path)) offenders.push(`${path} (${why})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each(FORBIDDEN_IDENTIFIERS)('never uses $why', ({ pattern }) => {
    const offenders = closure.files
      .filter(file => pattern.test(codeOf(file)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('never imports a constant a map may override', () => {
    const offenders: string[] = [];
    for (const file of trafficSources()) {
      const code = codeOf(file);
      for (const name of OVERRIDABLE_CONSTANTS) {
        if (new RegExp(`\\b${name}\\b`).test(code)) offenders.push(`${rel(file)}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('permits the prose mention of CAR_SPEED that tuning.ts actually carries', () => {
    // The premise, asserted rather than assumed: if this comment is ever reworded away, the
    // rule above stops being the interesting one and this test says so instead of quietly
    // passing.
    const raw = readFileSync(join(TRAFFIC_DIR, 'tuning.ts'), 'utf8');
    expect(raw).toContain('CAR_SPEED');
    expect(codeOf(join(TRAFFIC_DIR, 'tuning.ts'))).not.toContain('CAR_SPEED');
  });
});
