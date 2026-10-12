// PROTECTED: the verdict corpus is self-consistent (DESIGN §3.3).
//
//   - MANIFEST.jsonl lines are contiguous from n = 1, each in canonical form, and every link recomputes:
//     link = sha256(prev || "\n" || n || "\n" || id || "\n" || case_sha256), prev of line 1 = 64 zeros;
//   - every case_sha256 matches its file; every file under cases/ is listed exactly once; none is missing;
//   - every case file is in canonical bytes (keys sorted recursively, 2-space indent, LF, trailing newline), so a
//     whitespace-only edit is a hash change;
//   - at least MIN_CASES cases (a frozen floor that may only rise).
// Append-only ACROSS commits is not checkable from inside one tree (a case and its manifest edited together stay
// self-consistent); the closed pull-sync admission glue checks it against the accepted pins.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, chainLink, GENESIS_LINK, loadCorpus, sha256Hex } from "./runner";

/** The count floor (frozen; it may only rise, never fall). */
export const MIN_CASES = 138;
const DIR = dirname(fileURLToPath(import.meta.url));

describe("verdict corpus chain", () => {
  test("the chain verifies and covers every case file", () => {
    const lc = loadCorpus(DIR);
    expect(lc.errors).toEqual([]);
    expect(lc.ok).toBe(true);
  });
  test(`at least MIN_CASES (${MIN_CASES}) cases`, () => {
    expect(loadCorpus(DIR).lines.length).toBeGreaterThanOrEqual(MIN_CASES);
  });
  test("each link recomputes from first principles (not only through loadCorpus)", () => {
    const lines = readFileSync(join(DIR, "MANIFEST.jsonl"), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l) as { n: number; id: string; path: string; case_sha256: string; prev: string; link: string });
    let prev = GENESIS_LINK;
    expect(GENESIS_LINK).toBe("0".repeat(64));
    for (const m of lines) {
      const bytes = readFileSync(join(DIR, m.path), "utf8");
      expect(sha256Hex(bytes)).toBe(m.case_sha256);
      expect(canonicalJson(JSON.parse(bytes))).toBe(bytes);
      expect(m.prev).toBe(prev);
      expect(m.link).toBe(chainLink(prev, m.n, m.id, m.case_sha256));
      prev = m.link;
    }
  });
});

// The checker must be seen to refuse (each mutant applied to a throwaway copy of this corpus).
describe("MUST-FAIL: the chain checker refuses every inconsistency", () => {
  const withCopy = (mutate: (dir: string) => void): string[] => {
    const d = mkdtempSync(join(tmpdir(), "vc-chain-"));
    try {
      cpSync(join(DIR, "MANIFEST.jsonl"), join(d, "MANIFEST.jsonl"));
      cpSync(join(DIR, "cases"), join(d, "cases"), { recursive: true });
      mutate(d);
      return loadCorpus(d).errors;
    } finally { rmSync(d, { recursive: true, force: true }); }
  };
  const first = (): { path: string } => JSON.parse(readFileSync(join(DIR, "MANIFEST.jsonl"), "utf8").split("\n")[0]!);
  test("positive control: an unmodified copy verifies", () => { expect(withCopy(() => {})).toEqual([]); });
  test("a whitespace-only edit of a case is refused", () => {
    expect(withCopy((d) => { const p = join(d, first().path); writeFileSync(p, readFileSync(p, "utf8").replace("\n", "\n ")); }).length).toBeGreaterThan(0);
  });
  test("an expect edit re-hashed into the manifest still breaks the links", () => {
    const errs = withCopy((d) => {
      const lines = readFileSync(join(d, "MANIFEST.jsonl"), "utf8").trimEnd().split("\n");
      const m = JSON.parse(lines[0]!);
      const c = JSON.parse(readFileSync(join(d, m.path), "utf8"));
      c.expect = { reached: true };
      const bytes = canonicalJson(c);
      writeFileSync(join(d, m.path), bytes);
      m.case_sha256 = sha256Hex(bytes);
      lines[0] = JSON.stringify(m);
      writeFileSync(join(d, "MANIFEST.jsonl"), lines.join("\n") + "\n");
    });
    expect(errs.some((e) => /link does not recompute/.test(e))).toBe(true);
  });
  test("a manifest fidelity that disagrees with its case, or an unknown fidelity, is refused", () => {
    const relabel = (to: string) => withCopy((d) => {
      const lines = readFileSync(join(d, "MANIFEST.jsonl"), "utf8").trimEnd().split("\n");
      const m = JSON.parse(lines[0]!); m.fidelity = to; lines[0] = JSON.stringify(m);
      writeFileSync(join(d, "MANIFEST.jsonl"), lines.join("\n") + "\n");
    });
    expect(relabel("recorded-input").some((e) => /fidelity/.test(e))).toBe(true);
    expect(relabel("exact").some((e) => /fidelity/.test(e))).toBe(true);
  });
  test("a deleted case file is refused", () => { expect(withCopy((d) => rmSync(join(d, first().path))).some((e) => /missing/.test(e))).toBe(true); });
  test("an unlisted case file is refused", () => {
    expect(withCopy((d) => { mkdirSync(join(d, "cases", "x"), { recursive: true }); writeFileSync(join(d, "cases", "x", "9999-x.json"), "{}\n"); }).some((e) => /not listed/.test(e))).toBe(true);
  });
  test("a truncated manifest (last line dropped, its case kept) is refused", () => {
    expect(withCopy((d) => { const l = readFileSync(join(d, "MANIFEST.jsonl"), "utf8").trimEnd().split("\n"); writeFileSync(join(d, "MANIFEST.jsonl"), l.slice(0, -1).join("\n") + "\n"); }).some((e) => /not listed/.test(e))).toBe(true);
  });
  test("an empty manifest and a missing cases/ are refused", () => {
    expect(withCopy((d) => { writeFileSync(join(d, "MANIFEST.jsonl"), ""); rmSync(join(d, "cases"), { recursive: true }); }).length).toBeGreaterThan(0);
  });
});
