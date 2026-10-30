// THE INSTANCE-VALUE LINT FLAGS A MINTED TEMPLATE THAT REPLAYS ITS SOURCE RUN, AND PASSES A SLOT-LEVEL ONE.
//
// Gap minted-templates-replay-instance-values-because-reach-to-mint-bakes-the-original-goals-record-ids-and-nouns-into-
// their-tasks. Calibrated on the structure of two minted memoryNote_write compositions (the literals themselves are
// never used here; every fixture string below is invented): the write task carried a literal title and body, the
// source dispatch id, the upstream impulses inlined under their shapes' names, and a key built from the goal sentence.
//
//   [MUST-FAIL] a template minted from a remember goal is flagged: literal write content, a run id, an inlined impulse,
//               a goal-derived key
//   [MUST-FAIL] the caller's instance values (a record id, a goal noun) are found in a key, a value and a description
//   [CONTROL]   a slot-level template passes: {{impulse:<shape>}} / {{goal}} slots, shape-level tasks
//   [CONTROL]   every seeded template the executor ships passes (no false positive on hand-written slot templates)
//
// Fixture words from a 5-word draw (draw-words.sh): 2026-10-30T04:40:13Z seed=1793335213930530784
// words=rewrap jaws kudos subheader protozoan
import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const L = (await import("../src/template-instance-lint").catch(() => ({}))) as Record<string, any>;
const lint = (t: unknown, v?: string[]): Array<{ kind: string; path: string }> => (L["lintTemplateInstanceValues"] ? L["lintTemplateInstanceValues"](t, v) : []);
const slotLevel = (t: unknown, v?: string[]): boolean => (L["templateIsSlotLevel"] ? L["templateIsSlotLevel"](t, v) : true);

const MINTED = {
  id: "learned-composition-memorynote-write",
  tasks: [
    {
      id: "compose-step-1",
      resolver: "memoryNote_write",
      inputShapes: [],
      outputShapes: ["memoryNote_write"],
      description: "write the protozoan subheader note",
      config: {
        type: "memoryNote_write",
        title: "Protozoan subheader",
        body: "Remember that the protozoan subheader needs a rewrap before kudos.",
        dispatch_id: "0b6f1c2e-1111-4222-8333-944455556666",
        composedDeliverable_remember_that_the_protozoan_subheader_needs_a_rewrap: "the jaws of the rewrap",
        llm_completion_dispatch: { shape: "llmTextCompletion", success: true, body: { text: "the protozoan subheader, rewrapped" } },
        labels: ["protozoan"],
      },
    },
    { id: "compose-step-1-read-back", resolver: "memoryNote", inputShapes: [], outputShapes: ["memoryNote"], description: "read back record note-kudos-4471", config: { type: "memoryNote" } },
  ],
};

const SLOTTED = {
  id: "learned-composition-slot-level",
  tasks: [
    { id: "s1", resolver: "llm_completion_dispatch", outputShapes: ["llm_completion_dispatch"], config: { type: "llm_completion_dispatch", prompt: "Summarise for the note: {{goal}}" } },
    {
      id: "s2",
      resolver: "memoryNote_write",
      inputShapes: ["llm_completion_dispatch"],
      outputShapes: ["memoryNote_write"],
      description: "write the summary as a note",
      config: { type: "memoryNote_write", title: "{{impulse:note_title}}", body: "{{impulse:llm_completion_dispatch}}", dispatch_id: "{{variables.dispatch_id}}" },
      pointerFromImpulseSlots: { content: "llm_completion_dispatch" },
    },
    { id: "s2-read-back", resolver: "memoryNote", outputShapes: ["memoryNote"], config: { type: "memoryNote" } },
  ],
};

describe("the instance-value lint", () => {
  it("[MUST-FAIL] a template minted from a remember goal is flagged on every structural signal", () => {
    const kinds = new Set(lint(MINTED).map((f) => f.kind));
    expect([...kinds].sort()).toEqual(["goal-derived-key", "inlined-impulse", "run-id", "write-content-literal"]);
    expect(slotLevel(MINTED)).toBe(false);
  });
  it("[MUST-FAIL] the caller's instance values are found in a key, a value and a description", () => {
    const paths = lint(MINTED, ["note-kudos-4471", "protozoan"]).filter((f) => f.kind === "instance-value").map((f) => f.path);
    expect(paths.some((p) => p.endsWith(".description") && p.startsWith("compose-step-1-read-back"))).toBe(true);
    expect(paths.some((p) => p.includes("composedDeliverable_remember_that_the_protozoan"))).toBe(true);
    expect(paths.some((p) => p.endsWith(".labels[0]"))).toBe(true);
  });
  it("[CONTROL] a slot-level template passes, with or without instance values", () => {
    expect(lint(SLOTTED)).toEqual([]);
    expect(lint(SLOTTED, ["note-kudos-4471", "protozoan"])).toEqual([]);
    expect(slotLevel(SLOTTED)).toBe(true);
  });
  it("[CONTROL] every seeded template the executor ships passes", () => {
    const root = join(import.meta.dir, "..", "node_modules", "@avigopal", "ias-executor-ts", "src", "templates");
    expect(existsSync(root)).toBe(true);
    const files = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? files(p) : p.endsWith(".json") ? [p] : []; });
    let n = 0;
    const flagged: string[] = [];
    for (const p of files(root)) {
      let t: unknown; try { t = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
      for (const x of Array.isArray(t) ? t : [t]) {
        if (!x || typeof x !== "object" || !Array.isArray((x as { tasks?: unknown }).tasks)) continue;
        n++;
        if (lint(x).length > 0) flagged.push(p.slice(root.length));
      }
    }
    expect(n).toBeGreaterThan(5);
    expect(flagged).toEqual([]);
  });
});
