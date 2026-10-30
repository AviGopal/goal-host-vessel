// AFTER A RE-FRAME, THE ANSWER'S BASIS LEADS WITH WHAT REACHED, NOT THE HOLLOW FIRST ATTEMPT'S OUTPUT.
//
// Gap after-a-reframe-the-dispatchs-answer-body-keeps-the-hollow-first-attempts-output-so-a-person-judges-the-wrong-content.
// A re-frame carries the prior attempt's steps into its pool (metadata.carriedFrom) AHEAD of its own outputs, and the
// answer's "## Basis" listed the pool in order under one budget. After a hollow first attempt (an llmTextCompletion)
// and a reaching re-frame (a memoryNote_write), the person read the hollow attempt's text first, and judged it.
// answer-basis.ts humanPoolDigest now puts the walk's own outputs first and the carried ones after, under a label.
//
//   [MUST-FAIL] a re-frame's pool (carried hollow text first, the reaching write after): the write leads the digest;
//               the carried text follows the label
//   [MUST-FAIL] under the answer's 3000-char Basis cut, the reaching write survives when the carried text is long
//   [MUST-FAIL] index.ts builds the human digest with humanPoolDigest(poolImpulses)
//   [CONTROL]   a pool with nothing carried renders byte-identically to the previous inline digest (so every
//               verdict-diff golden's answerBody is unchanged); the goal impulse and empty content stay excluded
//
// Fixture words from a 5-word draw (draw-words.sh): 2026-10-30T04:29:20Z seed=1793334560726343661
// words=lusty decoy contents gecko giving
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AB = (await import("../src/answer-basis").catch(() => ({}))) as Record<string, any>;
const digest = (pool: unknown[]): string => (AB["humanPoolDigest"] ? AB["humanPoolDigest"](pool) : "<absent>");
const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");

// The digest as index.ts built it inline before this change (the reference for the CONTROL).
function previousDigest(pool: Array<{ metadata?: unknown; content: unknown }>): string {
  return pool
    .filter((imp) => { const s = (imp.metadata as { shape?: string } | undefined)?.shape; return s && s !== "goal"; })
    .map((imp) => {
      let c: string;
      try { c = typeof imp.content === "string" ? imp.content : JSON.stringify(imp.content); } catch { c = String(imp.content); } if (c === undefined || c === null) c = "";
      return c.slice(0, 1500);
    })
    .filter((c) => c.trim().length > 0)
    .join("\n\n");
}

const imp = (shape: string, content: unknown, carriedFrom?: string) => ({ metadata: { shape, ...(carriedFrom ? { carriedFrom } : {}) }, content });
const GOAL = imp("goal", "record the gecko's contents in a note");
const HOLLOW = imp("llmTextCompletion", { success: true, body: { text: "a lusty decoy answer that never wrote the note" } }, "exec_first");
const WRITE = imp("memoryNote_write", { success: true, shape: "memoryNote", body: { id: "note-gecko", title: "gecko contents", written: true } });

describe("the answer basis after a re-frame", () => {
  it("[MUST-FAIL] the reaching write leads; the carried hollow text follows the label", () => {
    const d = digest([GOAL, HOLLOW, WRITE]);
    expect(d.indexOf("note-gecko")).toBeGreaterThanOrEqual(0);
    expect(d.indexOf("lusty decoy")).toBeGreaterThan(d.indexOf("note-gecko"));
    expect(d.indexOf(String(AB["CARRIED_LABEL"]))).toBeGreaterThan(d.indexOf("note-gecko"));
    expect(d.indexOf("lusty decoy")).toBeGreaterThan(d.indexOf(String(AB["CARRIED_LABEL"])));
  });
  it("[MUST-FAIL] under the Basis cut (3000 chars), the reaching write survives a long carried text", () => {
    const longHollow = imp("llmTextCompletion", "giving ".repeat(400), "exec_first");
    const longOther = imp("shellResult", "decoy ".repeat(400), "exec_first");
    expect(digest([GOAL, longHollow, longOther, WRITE]).slice(0, 3000)).toContain("note-gecko");
  });
  it("[MUST-FAIL] index.ts builds the human digest with humanPoolDigest(poolImpulses)", () => {
    expect(SRC.includes("const poolDigestHuman = humanPoolDigest(poolImpulses);")).toBe(true);
    expect(SRC.includes('import { humanPoolDigest } from "./answer-basis";')).toBe(true);
  });
  it("[CONTROL] nothing carried: byte-identical to the previous digest; goal and empty content excluded", () => {
    const pools = [
      [GOAL, WRITE],
      [GOAL, imp("shellResult", { stdout: "3\n", stderr: "", exitCode: 0 }), imp("x_empty", "   "), WRITE],
      [imp("uuidish", "00000000-0000-4000-8000-000000000001"), imp("llmTextCompletion", "x".repeat(2000))],
      [],
    ];
    // At BASE (no answer-basis.ts) the index.ts digest IS the previous one, so the reference stands in for it.
    const current = (AB["humanPoolDigest"] as ((p: unknown[]) => string) | undefined) ?? previousDigest;
    for (const p of pools) expect(current(p)).toBe(previousDigest(p));
  });
});
