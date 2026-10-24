// THE REGENERATED VERDICT-DIFF GOLDEN CARRIES NO EXECUTION ID IN AN IDEMPOTENCY-KEY HEADER, AND KEEPS KEY REUSE.
//
// Companion to test/verdict-diff-idempotency-key-normalized.test.ts (the child's normalizer), on the golden itself:
// every recorded Idempotency-Key is an ordinal placeholder, so the golden holds no id-shaped "…key": "…" values a
// secret scan reads as keys. Read-only over the committed JSON; runs anywhere (the replay itself is host-only).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "judge-split", "verdict-diff", "golden");
const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
const keysOf = (f: string): string[] => [...readFileSync(join(DIR, f), "utf8").matchAll(/"idempotency-key": "([^"]*)"/g)].map((m) => m[1]!);

describe("MUST-FAIL: every Idempotency-Key in the golden is an ordinal placeholder", () => {
  test("no golden records an execution id (or any other text) as an Idempotency-Key", () => {
    const bad = files.flatMap((f) => keysOf(f).filter((k) => !/^idem-\d+$/.test(k)).map((k) => `${f}: ${k.length} chars`));
    expect(bad).toEqual([]);
  });

  test("ordinals are first-use order within a scenario (idem-1 first, no gaps)", () => {
    for (const f of files) {
      const seen: number[] = [];
      for (const k of keysOf(f)) { const n = Number(k.slice(5)); if (!seen.includes(n)) seen.push(n); }
      expect([f, seen]).toEqual([f, seen.map((_, i) => i + 1)]);
    }
  });
});

describe("CONTROL: the golden still records Idempotency-Key headers where requests carry them", () => {
  test("the header is present (as a placeholder) in the scenarios that send it", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.reduce((n, f) => n + keysOf(f).length, 0)).toBeGreaterThan(0);
  });
});
