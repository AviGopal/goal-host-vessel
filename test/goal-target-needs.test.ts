import { describe, it, expect } from "bun:test";
import { inferGoalTargetDecision } from "../src/goal-target-inference";
import { isEditIntentGoal, goalDemandsLandedEdit } from "../src/goal-intent";

/**
 * CHECK-FIRST: goal-target inference must pick targets whose PRODUCERS CAN ANSWER THE NEED.
 *
 * Three members of one defect class, each red at base:
 *  (i)   a quantitative question about a store the substrate serves through an advertised READ
 *        shape is aimed at the universal executor (shellResult) with no command to run, instead
 *        of the read shape whose DESCRIPTION says it answers exactly that question. Inference
 *        sees shape NAMES only; discovery serves descriptions (/registry/shape-descriptions) and
 *        input schemas, but neither is read at choice time.
 *  (ii)  a request that explicitly forbids changing anything is classified as edit-intent, so
 *        the only verdict it can ever earn is "edit-intent-no-landed-edit".
 *  (iii) a compound request ("find X, and then do Y with it") keeps one part as a target and
 *        drops the other.
 *
 * CONTRACT for (i) — the deterministic layer is a VALIDITY constraint, not a preference:
 *
 *  INPUT  `inferGoalTargetDecision(goal, knownShapes, { shapeCatalog, poolShapes, complete })`
 *         shapeCatalog: Record<shape, { description: string; requires?: RequiredInput[] }>
 *         RequiredInput: { name: string; from: "goal"; literal: "code" | "token" }
 *                      | { name: string; from: "pool"; shape: string }
 *           "code"  = the goal carries a quoted or backticked span to bind (e.g. a command);
 *           "token" = the goal carries a literal value (quoted span, or a token with a digit);
 *           "pool"  = an impulse of `shape` is in `poolShapes`.
 *         poolShapes: string[] — shapes present in the pool at choice time.
 *
 *  VALIDITY  a target is valid only if it is advertised (in knownShapes) AND every required
 *            input is bindable from the goal or the pool. An invalid target is NEVER chosen,
 *            whoever proposes it (LLM, shortcut, fallback).
 *
 *  CHOICE    among VALID candidates only: the chooser is the LLM (shown the valid candidates'
 *            descriptions) or a learned posterior. A lexical matcher over descriptions exists
 *            ONLY as the fallback tier when no chooser answers, and it never overrides a valid
 *            chooser's answer (it may only restore a need the chooser left uncovered).
 *
 *  OUTPUT  GoalTargetDecision gains:
 *            candidates:   Array<{ shape: string; valid: boolean; reason: string }>
 *                          — every shape proposed or considered; for an invalid one, `reason`
 *                          names the failed requirement (the unbound input's name, or
 *                          "not advertised").
 *            chooser_tier: "llm" | "posterior" | "fallback" | "deterministic"
 *            shapes:       the choice (unchanged field).
 *
 * GENERALITY: every fixture is built from the CLASS with a SYNTHETIC registry — invented
 * stores, invented shapes — in two unrelated domains, each in two namings: readable names, and
 * OPAQUE names with REWORDED descriptions. Opaque names defeat any name-matching route, and the
 * rewording defeats any keyword list keyed to one description's phrasing.
 *
 * Every test name is unique (it carries its registry label), so a name filter selects one test.
 */

type RequiredInput =
  | { name: string; from: "goal"; literal: "code" | "token" }
  | { name: string; from: "pool"; shape: string };
type CatalogEntry = { description: string; requires?: RequiredInput[] };
type InferOpts = NonNullable<Parameters<typeof inferGoalTargetDecision>[2]> & {
  shapeCatalog?: Record<string, CatalogEntry>;
  poolShapes?: string[];
};
type Decision = Awaited<ReturnType<typeof inferGoalTargetDecision>> & {
  candidates?: Array<{ shape: string; valid: boolean; reason: string }>;
  chooser_tier?: string;
};

interface Catalog {
  label: string;
  shapes: Record<string, CatalogEntry>;
  tally: string;    // valid read shape: counts of the store's records per category
  summary: string;  // valid read shape: a second plausible answer, no required inputs
  detail: string;   // read shape requiring a POOL input (a category/region reference)
  detailRef: string; // the pool shape `detail` needs
  lookup: string;   // read shape requiring a GOAL token (a key)
  post: string;     // write shape: sends a message somewhere
  goals: { quantitative: string; compound: string; single: string };
}

// shellResult is the real universal executor the class is about, so its NAME stays; it requires
// a command, which only a goal that carries one can bind.
const SHELL_INPUT: RequiredInput[] = [{ name: "command", from: "goal", literal: "code" }];
const SHELL_A = "Runs an arbitrary shell command line and returns its stdout, stderr and exit code.";
const SHELL_B = "Executes a command in a bash shell; the output is the captured stdout/stderr of that command.";

function widgetDomain(opaque: boolean): Catalog {
  const n = opaque
    ? { tally: "s_k3m9", summary: "s_j6u0", detail: "s_e2g7", ref: "s_r8t3", write: "s_w0q2", lookup: "s_p2x1", post: "s_n7v4", file: "s_f5d8", prose: "s_l1c6" }
    : { tally: "widgetLedger_tally", summary: "widgetLedger_digest", detail: "widgetLedger_oneCategory", ref: "widgetCategory_ref", write: "widgetLedger_write", lookup: "sprocketIndex_lookup", post: "notice_post", file: "fileContent", prose: "llm_completion" };
  const keyInput: RequiredInput[] = [{ name: "serial", from: "goal", literal: "token" }];
  const refInput: RequiredInput[] = [{ name: "category_ref", from: "pool", shape: n.ref }];
  const shapes: Record<string, CatalogEntry> = opaque
    ? {
        shellResult: { description: SHELL_B, requires: SHELL_INPUT },
        [n.tally]: { description: "Per-category widget totals, computed from the ledger's current records." },
        [n.summary]: { description: "A digest of the latest activity recorded there." },
        [n.detail]: { description: "Widget total for a single category of the ledger; needs that category's reference.", requires: refInput },
        [n.write]: { description: "Inserts a widget entry into the ledger." },
        [n.lookup]: { description: "Given a sprocket serial, returns who owns that sprocket and where it sits, from the sprocket index.", requires: keyInput },
        [n.post]: { description: "Publishes a message onto the bulletin board for a named recipient." },
        [n.file]: { description: "Returns the raw bytes of a file on disk." },
        [n.prose]: { description: "Free-text writing by a language model." },
      }
    : {
        shellResult: { description: SHELL_A, requires: SHELL_INPUT },
        [n.tally]: { description: "Reads the widget ledger and reports how many widgets it holds in each category." },
        [n.summary]: { description: "Summarises recent activity, newest entries first." },
        [n.detail]: { description: "Reports how many widgets the ledger holds in one category, given a reference to that category.", requires: refInput },
        [n.write]: { description: "Appends one new widget record to the widget ledger." },
        [n.lookup]: { description: "Looks up a sprocket by serial number in the sprocket index and returns its owner and location.", requires: keyInput },
        [n.post]: { description: "Posts a notice to the bulletin board; the payload is the notice text and its recipient." },
        [n.file]: { description: "Reads a file from disk and returns its contents verbatim." },
        [n.prose]: { description: "Asks a language model to compose free-form prose." },
      };
  return {
    label: `widget/${opaque ? "opaque" : "readable"}`,
    shapes,
    tally: n.tally,
    summary: n.summary,
    detail: n.detail,
    detailRef: n.ref,
    lookup: n.lookup,
    post: n.post,
    goals: {
      quantitative: "How many widgets does the ledger hold in each category?",
      compound: "Find the owner of sprocket S-17 in the sprocket index, and then post a notice on the bulletin board telling that owner it was recalled.",
      single: "Which owner and location does sprocket S-17 have?",
    },
  };
}

function parcelDomain(opaque: boolean): Catalog {
  const n = opaque
    ? { tally: "z_91aa", summary: "z_2bcc", detail: "z_7dd1", ref: "z_6ref", write: "z_07kd", lookup: "z_44rt", post: "z_3mmq", file: "z_8hex", prose: "z_5yyb" }
    : { tally: "depotStock_byRegion", summary: "depotTraffic_digest", detail: "depotStock_oneRegion", ref: "depotRegion_ref", write: "depotStock_append", lookup: "courierRoster_find", post: "dispatchAlert_send", file: "fileContent", prose: "llm_completion" };
  const keyInput: RequiredInput[] = [{ name: "tracking_code", from: "goal", literal: "token" }];
  const refInput: RequiredInput[] = [{ name: "region_ref", from: "pool", shape: n.ref }];
  const shapes: Record<string, CatalogEntry> = opaque
    ? {
        shellResult: { description: SHELL_B, requires: SHELL_INPUT },
        [n.tally]: { description: "For every destination region, the total of parcels the depot is holding right now." },
        [n.summary]: { description: "Digest of the latest traffic movements." },
        [n.detail]: { description: "Parcel total held at the depot for a single region; needs that region's reference.", requires: refInput },
        [n.write]: { description: "Registers an incoming parcel with the depot." },
        [n.lookup]: { description: "Maps a tracking code to the courier assigned to carry that parcel.", requires: keyInput },
        [n.post]: { description: "Raises an alert on the dispatch channel addressed to a person." },
        [n.file]: { description: "Returns the raw bytes of a file on disk." },
        [n.prose]: { description: "Free-text writing by a language model." },
      }
    : {
        shellResult: { description: SHELL_A, requires: SHELL_INPUT },
        [n.tally]: { description: "Counts the parcels held at the depot, grouped by destination region." },
        [n.summary]: { description: "Summarises recent movements, newest first." },
        [n.detail]: { description: "Counts parcels at the depot bound for one destination region, given a reference to that region.", requires: refInput },
        [n.write]: { description: "Records a new parcel arriving at the depot." },
        [n.lookup]: { description: "Finds which courier is assigned to a parcel, given its tracking code.", requires: keyInput },
        [n.post]: { description: "Sends an alert message to the dispatch channel for a named person." },
        [n.file]: { description: "Reads a file from disk and returns its contents verbatim." },
        [n.prose]: { description: "Asks a language model to compose free-form prose." },
      };
  return {
    label: `parcel/${opaque ? "opaque" : "readable"}`,
    shapes,
    tally: n.tally,
    summary: n.summary,
    detail: n.detail,
    detailRef: n.ref,
    lookup: n.lookup,
    post: n.post,
    goals: {
      quantitative: "How many parcels does the depot hold for each destination region?",
      compound: "Find the courier assigned to tracking code TR-4410, and then send an alert to the dispatch channel naming that courier.",
      single: "Which courier is assigned to tracking code TR-4410?",
    },
  };
}

const CATALOGS: Catalog[] = [widgetDomain(false), widgetDomain(true), parcelDomain(false), parcelDomain(true)];

/** A model that answers with a fixed target set and records every prompt it was shown. */
function stub(targetShapes: string[] | null, confidence = 0.6) {
  const prompts: string[] = [];
  const complete = async (prompt: string): Promise<string | null> => {
    prompts.push(prompt);
    return targetShapes === null ? null : JSON.stringify({ target_shapes: targetShapes, confidence });
  };
  return { complete, prompts };
}

async function decide(goal: string, cat: Catalog, complete: InferOpts["complete"], poolShapes: string[] = []): Promise<Decision> {
  const opts: InferOpts = { complete, shapeCatalog: cat.shapes, poolShapes, maxTargetShapes: 6 };
  return (await inferGoalTargetDecision(goal, Object.keys(cat.shapes), opts)) as Decision;
}

const candidate = (d: Decision, shape: string) => d.candidates?.find((c) => c.shape === shape);

for (const cat of CATALOGS) {
  const L = `[${cat.label}]`;

  describe(`${L} (i) targets are VALID producers; the chooser picks among them`, () => {
    it(`${L} MUST-FAIL (i): LLM unavailable → the fallback tier picks a described VALID shape, chooser_tier = fallback`, async () => {
      const d = await decide(cat.goals.quantitative, cat, stub(null).complete);
      expect(d.shapes[0]).toBe(cat.tally);
      expect(d.shapes).not.toContain("shellResult");
      expect(d.chooser_tier).toBe("fallback");
    });

    it(`${L} MUST-FAIL (i): LLM answers shellResult with no bindable command → rejected as INVALID with the reason recorded; the chosen target is a valid described shape`, async () => {
      const d = await decide(cat.goals.quantitative, cat, stub(["shellResult"]).complete);
      const shell = candidate(d, "shellResult");
      expect(shell?.valid).toBe(false);
      expect(shell?.reason ?? "").toContain("command");
      expect(d.shapes).not.toContain("shellResult");
      expect(d.shapes[0]).toBe(cat.tally);
      expect(candidate(d, cat.tally)?.valid).toBe(true);
    });

    it(`${L} MUST-FAIL (i): the LLM is consulted and SHOWN the descriptions of the valid candidates`, async () => {
      const s = stub([cat.tally]);
      await decide(cat.goals.quantitative, cat, s.complete);
      expect(s.prompts.length).toBeGreaterThan(0);
      for (const p of s.prompts) {
        expect(p).toContain(cat.shapes[cat.tally].description);
        expect(p).toContain(cat.shapes[cat.summary].description);
      }
    });

    it(`${L} CONTROL (i): the LLM chooses one of two VALID described shapes → its choice stands, unaltered`, async () => {
      // The lexical matcher would prefer the tally; the chooser picked the other valid shape.
      // The deterministic layer constrains validity only — it must not override this.
      const d = await decide(cat.goals.quantitative, cat, stub([cat.summary], 0.8).complete);
      expect(d.shapes).toEqual([cat.summary]);
    });

    it(`${L} MUST-FAIL (i): an ADVERTISED target whose required pool input cannot be bound is INVALID, even when the LLM proposes it`, async () => {
      const d = await decide(cat.goals.quantitative, cat, stub([cat.detail], 0.8).complete, []);
      const det = candidate(d, cat.detail);
      expect(det?.valid).toBe(false);
      expect(det?.reason ?? "").toContain(cat.shapes[cat.detail].requires![0].name);
      expect(d.shapes).not.toContain(cat.detail);
      expect(d.shapes[0]).toBe(cat.tally);
    });

    it(`${L} CONTRACT (i): the same target is VALID once the pool holds its input → the LLM's choice stands, chooser_tier = llm`, async () => {
      const d = await decide(cat.goals.quantitative, cat, stub([cat.detail], 0.8).complete, [cat.detailRef]);
      expect(d.shapes).toEqual([cat.detail]);
      expect(candidate(d, cat.detail)?.valid).toBe(true);
      expect(d.chooser_tier).toBe("llm");
    });
  });

  describe(`${L} (iii) a compound request keeps every need`, () => {
    it(`${L} MUST-FAIL (iii): LLM unavailable — both the lookup and the post are targets`, async () => {
      const d = await decide(cat.goals.compound, cat, stub(null).complete);
      expect(d.shapes).toContain(cat.lookup);
      expect(d.shapes).toContain(cat.post);
    });

    it(`${L} MUST-FAIL (iii): LLM keeps only the first need — the second is restored`, async () => {
      const d = await decide(cat.goals.compound, cat, stub([cat.lookup], 0.8).complete);
      expect(d.shapes).toContain(cat.lookup);
      expect(d.shapes).toContain(cat.post);
    });

    // Both directions: a stage that matches the WHOLE goal to one shape can cover the other
    // need by accident in one direction, never in both.
    it(`${L} MUST-FAIL (iii): LLM keeps only the second need — the first is restored`, async () => {
      const d = await decide(cat.goals.compound, cat, stub([cat.post], 0.8).complete);
      expect(d.shapes).toContain(cat.lookup);
      expect(d.shapes).toContain(cat.post);
    });
  });

  describe(`${L} controls (green at base)`, () => {
    it(`${L} CONTROL: a genuine shell request ('run <command>') targets shellResult, not a described store shape`, async () => {
      const d = await decide("Run `wc -l /etc/hosts` and report the output.", cat, stub(["shellResult"]).complete);
      expect(d.shapes[0]).toBe("shellResult");
      for (const s of [cat.tally, cat.summary, cat.lookup, cat.post]) expect(d.shapes).not.toContain(s);
    });

    it(`${L} CONTROL: a single-need request targets exactly its one shape`, async () => {
      const d = await decide(cat.goals.single, cat, stub([cat.lookup], 0.8).complete);
      expect(d.shapes).toEqual([cat.lookup]);
    });
  });
}

// ── (ii) a read-only request is never edit-intent ───────────────────────────────────────────
// Each names a real-looking repos/<vessel>/src file (the edit-intent trigger) AND a store, and
// states — in a different wording each time — that nothing may change. The mutation verb that
// trips the classifier sits INSIDE the clause forbidding mutation.
const READ_ONLY: string[] = [
  "Read repos/widget-vessel/src/ledger.ts and report which categories the widget ledger defines. Do not change anything.",
  "Report what repos/parcel-vessel/src/depot.ts keeps per destination region in the depot store; don't edit or update any file.",
  "Look through repos/widget-vessel/src/ledger.ts and the widget ledger store and tell me how categories are assigned. Never add, remove or modify anything.",
];

describe("(ii) a request that states it must not change anything is never edit-intent", () => {
  for (const goal of READ_ONLY) {
    it(`MUST-FAIL (ii): not edit-intent routing — ${goal.slice(0, 60)}…`, () => {
      expect(isEditIntentGoal(goal)).toBe(false);
    });
    it(`MUST-FAIL (ii): no landed edit demanded — ${goal.slice(0, 60)}…`, () => {
      expect(goalDemandsLandedEdit(goal)).toBe(false);
    });
  }

  // CONTROLS: a genuine edit naming a file stays edit-intent — including one carrying a negated
  // qualifier, which is what stops a fix from discarding every goal that contains "not".
  const EDITS = [
    "Edit repos/widget-vessel/src/ledger.ts to add a colour field to the widget record.",
    "Fix the rounding in repos/parcel-vessel/src/depot.ts without changing its public API.",
  ];
  for (const goal of EDITS) {
    it(`CONTROL: a genuine edit request stays edit-intent — ${goal.slice(0, 60)}…`, () => {
      expect(isEditIntentGoal(goal)).toBe(true);
      expect(goalDemandsLandedEdit(goal)).toBe(true);
    });
  }
});
