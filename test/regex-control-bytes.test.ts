import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { inferGoalTargetDecision } from "../src/goal-target-inference";

/**
 * CHECK-FIRST: a regex whose `\b` became a literal BACKSPACE (0x08) can never match.
 *
 * The countable-goal fallback in src/goal-target-inference.ts (the `empty` decision, used when
 * no LLM answers) was written as `/\b(compute|...|how many|...)\b/i`, but the file carries the
 * raw byte 0x08 where `\b` was meant. Inside a regex literal that byte is a literal character,
 * so the pattern demands a backspace in the goal text and silently never fires — a count
 * question with no LLM gets an EMPTY target. The same corruption exists elsewhere in src, so the
 * class is guarded by a repo lint, not just the one instance.
 */

/** Control bytes that never belong in source: 0x00–0x1F except tab, newline, carriage return. */
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

/**
 * Report each control byte that sits inside a regex literal or a `RegExp(` string argument.
 * Line-local: a regex literal is an unclosed `/…` opened after an operator, bracket, keyword or
 * line start; a RegExp string is an unclosed quote opened by `RegExp(`.
 */
export function controlBytesInRegexes(source: string): Array<{ line: number; col: number; byte: number }> {
  const hits: Array<{ line: number; col: number; byte: number }> = [];
  const lines = source.split("\n");
  const REGEX_OPEN = /(?:^|[=(,:!&|?{};[\]]|\breturn|\btypeof|\bcase)\s*\/(?![/*])(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])*$/;
  const REGEXP_STRING_OPEN = /RegExp\(\s*(["'`])(?:(?!\1)[^\\]|\\.)*$/;
  lines.forEach((text, i) => {
    for (const m of text.matchAll(CONTROL)) {
      const prefix = text.slice(0, m.index);
      if (REGEX_OPEN.test(prefix) || REGEXP_STRING_OPEN.test(prefix)) {
        hits.push({ line: i + 1, col: (m.index ?? 0) + 1, byte: m[0].charCodeAt(0) });
      }
    }
  });
  return hits;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const SRC = join(import.meta.dir, "..", "src");

describe("count-question fallback", () => {
  it("MUST-FAIL: with no LLM, 'how many open gaps are there' falls back to shellResult (the fallback regex can match)", async () => {
    const d = await inferGoalTargetDecision("how many open gaps are there", ["shellResult"], {});
    expect(d.shapes).toEqual(["shellResult"]);
  });
});

describe("lint: no control bytes inside regexes in src", () => {
  it("MUST-FAIL: no regex literal or RegExp string in src contains a control byte (0x00–0x1F except tab, LF, CR)", () => {
    const offenders: string[] = [];
    for (const f of sourceFiles(SRC)) {
      for (const h of controlBytesInRegexes(readFileSync(f, "latin1"))) {
        offenders.push(`${f.slice(SRC.length + 1)}:${h.line}:${h.col} byte 0x${h.byte.toString(16).padStart(2, "0")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("CONTROL: the lint catches a 0x08 embedded in a regex literal in a fixture file", () => {
    const fixture = readFileSync(join(import.meta.dir, "fixtures", "regex-control-byte.fixture.txt"), "latin1");
    expect(fixture.includes("\x08")).toBe(true);
    const hits = controlBytesInRegexes(fixture);
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.line === 1 && h.byte === 0x08)).toBe(true);
  });

  it("CONTROL: the lint does not flag an escaped \\b, a tab, or a control byte outside any regex", () => {
    expect(controlBytesInRegexes("const ok = /\\b(foo)\\b/i;\n\tconst t = 1;")).toEqual([]);
    expect(controlBytesInRegexes("const s = \"a\x08b\"; // not a regex")).toEqual([]);
    expect(controlBytesInRegexes("const r = new RegExp(\"\x08x\");").length).toBe(1);
  });
});

describe("count-question fallback — reviving it must not reopen the composition hole", () => {
  // The fallback has been dead since the corruption, so every compute-then-emit goal that
  // reaches it has silently been spared. Repairing the bytes alone revives a single-shape
  // shellResult route for "count X and write it to a note", dropping the write. The repair must
  // carry the shared composition guard; this pins that alongside the existing guard tests.
  it("CONTROL: with no LLM, a count-and-persist goal is NOT truncated to [shellResult] by the fallback", async () => {
    const d = await inferGoalTargetDecision(
      "count the open gaps and record the number in a memory note",
      ["shellResult", "memoryNote_write"], {},
    );
    expect(d.shapes).not.toEqual(["shellResult"]);
  });
});

// ── STRENGTHENED (class, not examples) ───────────────────────────────────────────────────────
// The single-goal check above can be passed by a patch that adds a `how many` alternation
// somewhere upstream and leaves the 0x08 bytes in place. The class is "a regex in the edit-site
// file carries a control byte where an escape was meant", so it is checked two ways:
//  (1) a lint over the edit-site file ONLY (src/goal-target-inference.ts — the whole-src lint
//      above also needs src/index.ts, which is not this gap's file);
//  (2) the fallback's own vocabulary, one phrasing per DISTINCT alternation, must route to
//      [shellResult] with no LLM — a patch special-casing one phrase fails the rest.
// Controls pin `\b` semantics: deleting the bytes (instead of restoring `\b`) makes the
// alternations match inside words (summary ⊃ sum, accountant ⊃ count, computer ⊃ compute), and
// an always-fire fallback routes non-count goals to shellResult. Both must stay off shellResult.
const EDIT_SITE = join(SRC, "goal-target-inference.ts");

// Each phrasing exercises a different alternation of the fallback; none names a shape, a file,
// a news term or a persistence clause, so no earlier deterministic router can claim it.
const COUNTABLE: string[] = [
  "compute 17 times 23",
  "calculate the average of 4, 8 and 15",
  "multiply 12 by 12",
  "divide 100 by 7",
  "sum the integers from 1 to 10",
  "count the vowels in the word banana",
  "how many prime numbers are below fifty",
  "what is the number of weekdays in a leap year",
  "sort these words alphabetically: pear apple fig",
  "reverse the word substrate",
  "give the sha256 of the word hello",
  "hash the string abc with md5",
  "give me the digest of the phrase open sesame",
  "report the count of vowels in onomatopoeia",
];

// Alternations appear only INSIDE longer words; with `\b` restored none of these match.
const SUBSTRING_ONLY: string[] = [
  "give me a summary of the design",
  "who is the accountant for this project",
  "explain the computer architecture of the fleet",
  "what does that hashtag mean",
  "describe the unsorted backlog policy",
  "listen carefully and describe what the vessel does",
];

describe("regex-control-bytes class: the edit-site file and the fallback vocabulary", () => {
  it("MUST-FAIL: no regex literal or RegExp string in src/goal-target-inference.ts contains a control byte", () => {
    const hits = controlBytesInRegexes(readFileSync(EDIT_SITE, "latin1"))
      .map((h) => `goal-target-inference.ts:${h.line}:${h.col} byte 0x${h.byte.toString(16).padStart(2, "0")}`);
    expect(hits).toEqual([]);
  });

  it("MUST-FAIL: with no LLM, every countable phrasing across the fallback's alternations routes to [shellResult]", async () => {
    const misses: string[] = [];
    for (const goal of COUNTABLE) {
      const d = await inferGoalTargetDecision(goal, ["shellResult"], {});
      if (JSON.stringify(d.shapes) !== JSON.stringify(["shellResult"])) misses.push(`${goal} -> ${JSON.stringify(d.shapes)}`);
    }
    expect(misses).toEqual([]);
  });

  it("CONTROL: with no LLM, a goal holding an alternation only inside a longer word is NOT routed to [shellResult] (\\b, not deleted bytes)", async () => {
    const wrong: string[] = [];
    for (const goal of SUBSTRING_ONLY) {
      const d = await inferGoalTargetDecision(goal, ["shellResult"], {});
      if (JSON.stringify(d.shapes) === JSON.stringify(["shellResult"])) wrong.push(goal);
    }
    expect(wrong).toEqual([]);
  });

  it("CONTROL: with no LLM, a non-countable goal is NOT routed to [shellResult] (the fallback is not always-on)", async () => {
    for (const goal of ["explain why the walk backward-chains", "describe the role of the discovery registry"]) {
      const d = await inferGoalTargetDecision(goal, ["shellResult"], {});
      expect(d.shapes).not.toEqual(["shellResult"]);
    }
  });

  it("CONTROL: with no LLM, countable goals that also persist a result are NOT truncated to [shellResult]", async () => {
    for (const goal of [
      "compute the sha256 of hello and save it to a memory note",
      "sum the integers from 1 to 10 and record the result in a note",
    ]) {
      const d = await inferGoalTargetDecision(goal, ["shellResult", "memoryNote_write"], {});
      expect(d.shapes).not.toEqual(["shellResult"]);
    }
  });
});
