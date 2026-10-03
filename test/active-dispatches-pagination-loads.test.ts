/**
 * A TEST FILE THAT CANNOT LOAD REPORTS NOTHING — ITS ASSERTIONS NEVER RUN.
 *
 * test/active-dispatches-pagination.test.ts does
 *
 *     import { executionStore } from "../src/index";
 *
 * but `executionStore` is a module-private `const` in src/index.ts and has never been
 * exported. Bun fails the file at link time:
 *
 *     SyntaxError: Export named 'executionStore' not found in module '.../src/index.ts'
 *
 * so none of its seven pagination tests has ever executed. A file that dies at import counts
 * as one "unhandled error", not as seven failures, which is how it went unnoticed.
 *
 * What must hold: every named import that file takes from a relative module is a value
 * export of that module, so the file can load. The check is STATIC — it reads source text
 * and never imports src/index.ts, whose top level restores and periodically rewrites the
 * dispatch store on disk and schedules resume POSTs to /run-goal. That is also why the fix
 * must not be "export executionStore from src/index.ts": the pagination file clears the store
 * and fills it with fixtures in beforeEach, and importing index.ts would let the 5 s persist
 * timer write those fixtures over the real dispatch store. Repoint the import instead (to a
 * small module that owns the pagination logic, or a local Map).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const TEST_DIR = dirname(new URL(import.meta.url).pathname);
const TARGET = join(TEST_DIR, "active-dispatches-pagination.test.ts");

/** Top-level value exports of a module, by static scan. `export type` / `export interface`
 *  are erased at runtime and cannot break an import, so they are not counted. */
function valueExports(file: string): Set<string> {
  const src = readFileSync(file, "utf8");
  const names = new Set<string>();
  const patterns = [
    /^export\s+(?:async\s+)?function\*?\s+(\w+)/gm,
    /^export\s+(?:const|let|var)\s+(\w+)/gm,
    /^export\s+(?:abstract\s+)?class\s+(\w+)/gm,
    /^export\s+(?:const\s+)?enum\s+(\w+)/gm,
  ];
  for (const re of patterns) for (const m of src.matchAll(re)) names.add(m[1]!);
  // `export { a, b as c }` lists (possibly multi-line); not `export type { … }`.
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1]!.replace(/\/\/.*$/gm, "").split(",")) {
      const p = part.trim();
      if (!p || p.startsWith("type ")) continue;
      const name = p.split(/\s+as\s+/).pop()!.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** Static named value imports from relative modules: `import { a, b as c } from "./x"`. */
function relativeNamedImports(file: string): Array<{ spec: string; names: string[] }> {
  const src = readFileSync(file, "utf8");
  const out: Array<{ spec: string; names: string[] }> = [];
  for (const m of src.matchAll(/^import\s+(?!type\b)([^;]*?)\s+from\s+["'](\.[^"']+)["']/gm)) {
    const clause = m[1]!;
    const braces = /\{([^}]*)\}/.exec(clause);
    if (!braces) continue;
    const names = braces[1]!
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("type "))
      .map((s) => s.split(/\s+as\s+/)[0]!.trim());
    out.push({ spec: m[2]!, names });
  }
  return out;
}

function resolveSpec(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (cand.endsWith(".ts") && existsSync(cand)) return cand;
  }
  return null;
}

/** Every relative named import of `file` that does not resolve to a value export. */
function unresolvedImports(file: string): string[] {
  const missing: string[] = [];
  for (const { spec, names } of relativeNamedImports(file)) {
    const target = resolveSpec(file, spec);
    if (!target) {
      missing.push(`${spec}: module not found`);
      continue;
    }
    const exported = valueExports(target);
    for (const n of names) if (!exported.has(n)) missing.push(`'${n}' is not exported by ${spec}`);
  }
  return missing;
}

describe("active-dispatches-pagination.test.ts can load", () => {
  test("the file still exists (deleting it is not a fix)", () => {
    expect(existsSync(TARGET)).toBe(true);
  });

  test("every named import it takes from a relative module is a value export of that module", () => {
    expect(unresolvedImports(TARGET)).toEqual([]);
  });

  test("control: the export scanner sees src/index.ts's multi-line export list", () => {
    const exported = valueExports(join(TEST_DIR, "..", "src", "index.ts"));
    for (const n of ["symbolInAddedLines", "parsePathsAndExt", "parseThreshold", "verifyGoalReached", "reachVerdictBody"]) {
      expect(exported.has(n)).toBe(true);
    }
    // `export type { ClassRow, … }` is type-only and must not count as a value export.
    expect(exported.has("ClassRow")).toBe(false);
  });

  test("control: a test file whose relative imports do resolve is reported clean", () => {
    const loadable = join(TEST_DIR, "edge-blend.test.ts");
    const imports = relativeNamedImports(loadable);
    expect(imports.some((i) => i.names.includes("blendEdgeScore"))).toBe(true);
    expect(unresolvedImports(loadable)).toEqual([]);
  });
});
