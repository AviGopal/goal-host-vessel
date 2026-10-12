// THE RUNTIME READS THE VERDICT CORPUS FROM THE VESSEL CLONE, NEVER FROM THE DEPLOYED MIRROR (case C-hollow-3).
//
// A running node's /vessels/goal-host-vessel is built by mirror-to-live, which copies src/ (and sql/, scripts/, tracked
// dist/) and never test/. The corpus lives in test/verdict-corpus/, so a reader resolving it relative to the deployed
// module found nothing on every node, while every gate (which runs in the clone, where test/ exists) passed.
//
// Driven at the consuming layer: src/ is copied into a mirror-shaped tree (no test/), and a fresh bun process (no module
// cache shared with this suite) imports credit-hold from that tree with VESSELS_CLONE_ROOT naming a temp clone root.
// MUST-FAILS:
//   (a) the mirror-shaped credit-hold loads the full corpus from <clone root>/goal-host-vessel/test/verdict-corpus;
//   (b) a corpus planted beside the mirror (<mirror>/test/verdict-corpus) is NEVER read: with no clone copy the corpus is
//       unreadable (fail closed), not silently the mirror's;
//   (c) the resolver ignores a relative VESSELS_CLONE_ROOT (falls back to the fleet default, never cwd-relative).
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, symlinkSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadCorpus } from "../../src/judge/corpus-runner";
import { DEFAULT_CLONE_ROOT, verdictCorpusDir } from "../../src/judge/corpus-location";

const REPO = resolve(import.meta.dir, "..", "..");
const CORPUS = join(REPO, "test", "verdict-corpus");
const root = mkdtempSync(join(tmpdir(), "corpus-location-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function mirror(name: string, plantCorpus: boolean): string {
  const m = join(root, name, "goal-host-vessel");
  mkdirSync(m, { recursive: true });
  cpSync(join(REPO, "src"), join(m, "src"), { recursive: true });
  if (existsSync(join(REPO, "node_modules"))) symlinkSync(join(REPO, "node_modules"), join(m, "node_modules"));
  if (plantCorpus) copyCorpus(join(m, "test", "verdict-corpus"));
  return m;
}
function copyCorpus(to: string): void {
  mkdirSync(to, { recursive: true });
  cpSync(join(CORPUS, "MANIFEST.jsonl"), join(to, "MANIFEST.jsonl"));
  cpSync(join(CORPUS, "cases"), join(to, "cases"), { recursive: true });
}
/** Import credit-hold from the mirror in a FRESH process; report the dir it resolved and what loadCorpus read there. */
function readFromMirror(m: string, cloneRootEnv: string): { dir: string; cases: number; errors: string[] } {
  const script = `const ch = await import(${JSON.stringify(join(m, "src", "judge", "credit-hold.ts"))});
const cr = await import(${JSON.stringify(join(m, "src", "judge", "corpus-runner.ts"))});
const lc = cr.loadCorpus(ch.DEPLOYED_CORPUS_DIR);
console.log(JSON.stringify({ dir: ch.DEPLOYED_CORPUS_DIR, cases: lc.cases.length, errors: lc.errors }));`;
  const r = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, NO_COLOR: "1", VESSELS_CLONE_ROOT: cloneRootEnv },
  });
  const out = r.stdout.toString().trim().split("\n").pop() ?? "";
  if (r.exitCode !== 0 || !out.startsWith("{")) throw new Error(`subprocess failed (${r.exitCode}): ${r.stderr.toString().slice(0, 600)}`);
  return JSON.parse(out);
}

describe("verdict corpus location (runtime reader)", () => {
  const expected = loadCorpus(CORPUS);

  test("(a) the deployed module reads the corpus from the vessel clone", () => {
    expect(expected.cases.length).toBeGreaterThan(0); // the control: the repo's own corpus is non-empty
    const clones = join(root, "clones-a");
    copyCorpus(join(clones, "goal-host-vessel", "test", "verdict-corpus"));
    const got = readFromMirror(mirror("mirror-a", false), clones);
    expect(got.dir).toBe(join(clones, "goal-host-vessel", "test", "verdict-corpus"));
    expect(got.errors).toEqual([]);
    expect(got.cases).toBe(expected.cases.length);
  });

  test("(b) a corpus beside the deployed mirror is never read: no clone copy reads as unreadable (fail closed)", () => {
    const m = mirror("mirror-b", true);
    const emptyClones = join(root, "clones-b-empty");
    mkdirSync(emptyClones, { recursive: true });
    const got = readFromMirror(m, emptyClones);
    expect(got.dir.startsWith(m)).toBe(false);
    expect(got.dir).toBe(join(emptyClones, "goal-host-vessel", "test", "verdict-corpus"));
    expect(got.cases).toBe(0);
    expect(got.errors.join(" ")).toContain("MANIFEST.jsonl is absent or unreadable");
  });

  test("(c) only an absolute clone root is honoured", () => {
    expect(verdictCorpusDir({ VESSELS_CLONE_ROOT: "relative/clones" })).toBe(join(DEFAULT_CLONE_ROOT, "goal-host-vessel", "test", "verdict-corpus"));
    expect(verdictCorpusDir({})).toBe(join(DEFAULT_CLONE_ROOT, "goal-host-vessel", "test", "verdict-corpus"));
    expect(verdictCorpusDir({ VESSELS_CLONE_ROOT: "/srv/c" })).toBe("/srv/c/goal-host-vessel/test/verdict-corpus");
  });
});
