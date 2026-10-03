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
 *
 * LOADING IS NECESSARY, NOT SUFFICIENT. A static import check alone is gameable: deleting the
 * import line, or gutting the file to an empty describe, satisfies it while the seven
 * pagination tests still never pass. So the gate is the run itself: this file spawns
 * `bun test ./test/active-dispatches-pagination.test.ts` in a child and requires at least seven
 * distinct passing tests, zero failures, a clean exit, and no load error. The child gets a
 * MINIMAL env built from scratch (PATH, HOME, NO_COLOR) — never a copy of process.env: with
 * CLAUDECODE=1 or AGENT=1 set (measured on bun 1.3.14; AI_AGENT has no effect) bun suppresses its
 * per-test "(pass)" lines while still printing "(fail)" lines and the summary, which would turn
 * this test red for a reason unrelated to the pagination file. Output goes to a
 * temp FILE, not a pipe (bun test output through a pipe can truncate).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const TEST_DIR = dirname(new URL(import.meta.url).pathname);
const TARGET = join(TEST_DIR, "active-dispatches-pagination.test.ts");
const REPO_ROOT = resolve(TEST_DIR, "..");
const MIN_PASSING = 7;

/** The seven ORIGINAL pagination tests (describe > name), pinned by exact name so that renaming
 *  or gutting them reads as red, not as "some other seven tests passed". Trivial bodies under
 *  these names remain an accepted residual. */
const PAGINATION_DESCRIBE = "activeDispatches pagination";
const PINNED_PAGINATION_TESTS = [
  "returns all results with no options, sorted by startedAt, limited to 50",
  "filters by status 'running', limit 1, offset 0",
  "retrieves subsequent running jobs with increasing offset",
  "returns empty for a failed-status query with no matches",
  "handles limit beyond total",
  "handles offset beyond total",
  "handles invalid limit/offset values gracefully (non-positive, non-numeric)",
];

/** CONTRACT NAME: the activeDispatches handler in src/index.ts must delegate its pagination to
 *  `paginateDispatches`, exported by src/active-dispatches.ts. The pagination tests exercise that
 *  module, so they only test production behaviour if the handler calls it — a copy that the
 *  handler never calls is the same defect as the re-implementation they replace. */
const CONTRACT_EXPORT = "paginateDispatches";
const INDEX = join(REPO_ROOT, "src", "index.ts");

/** The `if (type === "activeDispatches") { … }` branch of src/index.ts, with // comments
 *  stripped so a mention in a comment does not count as a call. Null when the branch is gone. */
function activeDispatchesHandlerRegion(src: string): string | null {
  const start = src.indexOf('if (type === "activeDispatches")');
  if (start < 0) return null;
  const next = src.indexOf("\n  if (type ===", start + 1);
  const region = src.slice(start, next > start ? next : start + 4000);
  return region.replace(/\/\/.*$/gm, "");
}

let childRun: Promise<ChildRun> | null = null;
/** One child run shared by the tests that read it. */
function paginationRun(): Promise<ChildRun> {
  childRun ??= runPaginationFile();
  return childRun;
}

type ChildRun = { exitCode: number | null; output: string };

/** Run the pagination file in its own bun process; capture stdout+stderr to temp files. */
async function runPaginationFile(): Promise<ChildRun> {
  const dir = mkdtempSync(join(tmpdir(), "pagination-run-"));
  const outPath = join(dir, "stdout.log");
  const errPath = join(dir, "stderr.log");
  try {
    const env: Record<string, string> = { NO_COLOR: "1" };
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.HOME) env.HOME = process.env.HOME;
    const child = Bun.spawn([process.execPath, "test", "./test/active-dispatches-pagination.test.ts"], {
      cwd: REPO_ROOT,
      env,
      stdin: "ignore",
      stdout: Bun.file(outPath),
      stderr: Bun.file(errPath),
    });
    const exitCode = await child.exited;
    const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
    // Strip ANSI even with NO_COLOR set, so parsing never depends on the terminal mode.
    const output = (read(outPath) + "\n" + read(errPath)).replace(/\x1b\[[0-9;]*m/g, "");
    return { exitCode, output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function passingNames(output: string): Set<string> {
  const names = new Set<string>();
  for (const m of output.matchAll(/^\(pass\) (.+?)(?: \[[\d.]+m?s\])?$/gm)) names.add(m[1]!);
  return names;
}

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

  test("it never imports src/index.ts (whose top level boots the host and rewrites the dispatch store)", () => {
    const src = readFileSync(TARGET, "utf8");
    const indexImports = src
      .split("\n")
      .filter((l) => /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']\.\.\/src(?:\/index(?:\.ts)?)?["']/.test(l));
    expect(indexImports).toEqual([]);
  });

  test("its pagination tests RUN AND PASS in a child bun (>=7 passing, 0 failing, no load error)", async () => {
    const { exitCode, output } = await paginationRun();
    const loadErrors = output.split("\n").filter((l) => /Unhandled error|SyntaxError|Cannot find module|ReferenceError/.test(l));
    const failing = output.split("\n").filter((l) => l.startsWith("(fail)"));
    const passing = passingNames(output);
    const diagnosis = { exitCode, passing: [...passing], failing, loadErrors, tail: output.slice(-1500) };
    expect(diagnosis.loadErrors).toEqual([]);
    expect(diagnosis.failing).toEqual([]);
    expect(passing.size >= MIN_PASSING ? "enough" : diagnosis).toBe("enough");
    // Only the pagination file ran: a filter that matched other files would make the count meaningless.
    expect(output).toMatch(/Ran \d+ tests? across 1 file/);
    expect(exitCode).toBe(0);
  }, 60_000);

  test("each of its seven original tests passes BY NAME in the child run (renaming or gutting is not a fix)", async () => {
    const { output } = await paginationRun();
    const passing = passingNames(output);
    const missing = PINNED_PAGINATION_TESTS.map((n) => `${PAGINATION_DESCRIBE} > ${n}`).filter((n) => !passing.has(n));
    expect(missing).toEqual([]);
  }, 60_000);

  test("src/index.ts's activeDispatches handler calls the extracted paginateDispatches from ./active-dispatches", () => {
    const src = readFileSync(INDEX, "utf8");
    const importsContract = new RegExp(
      `import\\s*\\{[^}]*\\b${CONTRACT_EXPORT}\\b[^}]*\\}\\s*from\\s*["']\\./active-dispatches(?:\\.js|\\.ts)?["']`,
    ).test(src);
    expect(importsContract ? "imports it" : `src/index.ts has no import { ${CONTRACT_EXPORT} } from "./active-dispatches"`).toBe("imports it");
    const region = activeDispatchesHandlerRegion(src);
    expect(region === null ? "activeDispatches branch not found in src/index.ts" : "found").toBe("found");
    const calls = new RegExp(`\\b${CONTRACT_EXPORT}\\s*\\(`).test(region ?? "");
    expect(calls ? "handler calls it" : `the activeDispatches branch never calls ${CONTRACT_EXPORT}(…)`).toBe("handler calls it");
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
