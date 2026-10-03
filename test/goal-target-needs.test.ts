import { describe, it, expect } from "bun:test";
import { inferGoalTargetDecision } from "../src/goal-target-inference";
import { isEditIntentGoal, goalDemandsLandedEdit } from "../src/goal-intent";

/**
 * CHECK-FIRST: goal-target inference must pick targets whose PRODUCERS CAN ANSWER THE NEED.
 *
 * Three members of one defect class, each red at base:
 *  (i)   a quantitative question about a store the substrate serves through an advertised READ
 *        shape is aimed at the universal executor (shellResult) instead of the read shape whose
 *        DESCRIPTION says it answers exactly that question. Inference sees shape NAMES only;
 *        discovery serves descriptions (/registry/shape-descriptions) but they are never read
 *        at choice time.
 *  (ii)  a request that explicitly forbids changing anything is classified as edit-intent, so
 *        the only verdict it can ever earn is "edit-intent-no-landed-edit".
 *  (iii) a compound request ("find X, and then do Y with it") keeps one part as a target and
 *        drops the other.
 *
 * CONTRACT these tests pin (the seam a fix must expose):
 *  - `inferGoalTargetDecision(goal, knownShapes, { shapeDescriptions })` — a shape→description
 *    map read AT CHOICE TIME. A deterministic stage over those descriptions decides which
 *    shapes' producers answer the need; the LLM (stubbed here via `complete`) may only refine,
 *    never displace a described producer with the universal executor, and never drop a need.
 *  - If the LLM is consulted, the descriptions of the shapes it is offered are in its prompt.
 *
 * GENERALITY: every fixture is built from the CLASS with a SYNTHETIC registry — invented
 * stores, invented shapes — in two unrelated domains, each in two namings: readable names, and
 * OPAQUE names with REWORDED descriptions. Opaque names defeat any name-matching route
 * (namedAdvertisedShape / _namedShape), and the rewording defeats any keyword list keyed to
 * one description's phrasing: only reading what each description says can pass all four.
 */

type InferOpts = NonNullable<Parameters<typeof inferGoalTargetDecision>[2]> & {
  shapeDescriptions?: Record<string, string>;
};

interface Catalog {
  label: string;
  /** shape name -> advertised description (the synthetic registry). */
  shapes: Record<string, string>;
  /** Role -> shape name in this catalog. */
  tally: string;   // read shape: counts of the store's records per category
  lookup: string;  // read shape: one record's attributes by key
  post: string;    // write shape: sends a message somewhere
  goals: { quantitative: string; compound: string; single: string };
}

// shellResult is the real universal executor the class is about, so its NAME stays; its
// description is reworded per naming like everything else.
const SHELL_A = "Runs an arbitrary shell command line and returns its stdout, stderr and exit code.";
const SHELL_B = "Executes a command in a bash shell; the output is the captured stdout/stderr of that command.";

function widgetDomain(opaque: boolean): Catalog {
  const n = opaque
    ? { tally: "s_k3m9", write: "s_w0q2", lookup: "s_p2x1", post: "s_n7v4", file: "s_f5d8", prose: "s_l1c6" }
    : { tally: "widgetLedger_tally", write: "widgetLedger_write", lookup: "sprocketIndex_lookup", post: "notice_post", file: "fileContent", prose: "llm_completion" };
  const shapes: Record<string, string> = opaque
    ? {
        shellResult: SHELL_B,
        [n.tally]: "Per-category widget totals, computed from the ledger's current records.",
        [n.write]: "Inserts a widget entry into the ledger.",
        [n.lookup]: "Given a sprocket serial, returns who owns that sprocket and where it sits, from the sprocket index.",
        [n.post]: "Publishes a message onto the bulletin board for a named recipient.",
        [n.file]: "Returns the raw bytes of a file on disk.",
        [n.prose]: "Free-text writing by a language model.",
      }
    : {
        shellResult: SHELL_A,
        [n.tally]: "Reads the widget ledger and reports how many widgets it holds in each category.",
        [n.write]: "Appends one new widget record to the widget ledger.",
        [n.lookup]: "Looks up a sprocket by serial number in the sprocket index and returns its owner and location.",
        [n.post]: "Posts a notice to the bulletin board; the payload is the notice text and its recipient.",
        [n.file]: "Reads a file from disk and returns its contents verbatim.",
        [n.prose]: "Asks a language model to compose free-form prose.",
      };
  return {
    label: `widget/${opaque ? "opaque" : "readable"}`,
    shapes,
    tally: n.tally,
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
    ? { tally: "z_91aa", write: "z_07kd", lookup: "z_44rt", post: "z_3mmq", file: "z_8hex", prose: "z_5yyb" }
    : { tally: "depotStock_byRegion", write: "depotStock_append", lookup: "courierRoster_find", post: "dispatchAlert_send", file: "fileContent", prose: "llm_completion" };
  const shapes: Record<string, string> = opaque
    ? {
        shellResult: SHELL_B,
        [n.tally]: "For every destination region, the total of parcels the depot is holding right now.",
        [n.write]: "Registers an incoming parcel with the depot.",
        [n.lookup]: "Maps a tracking code to the courier assigned to carry that parcel.",
        [n.post]: "Raises an alert on the dispatch channel addressed to a person.",
        [n.file]: "Returns the raw bytes of a file on disk.",
        [n.prose]: "Free-text writing by a language model.",
      }
    : {
        shellResult: SHELL_A,
        [n.tally]: "Counts the parcels held at the depot, grouped by destination region.",
        [n.write]: "Records a new parcel arriving at the depot.",
        [n.lookup]: "Finds which courier is assigned to a parcel, given its tracking code.",
        [n.post]: "Sends an alert message to the dispatch channel for a named person.",
        [n.file]: "Reads a file from disk and returns its contents verbatim.",
        [n.prose]: "Asks a language model to compose free-form prose.",
      };
  return {
    label: `parcel/${opaque ? "opaque" : "readable"}`,
    shapes,
    tally: n.tally,
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

async function decide(goal: string, cat: Catalog, complete: InferOpts["complete"]) {
  const opts: InferOpts = { complete, shapeDescriptions: cat.shapes, maxTargetShapes: 6 };
  return inferGoalTargetDecision(goal, Object.keys(cat.shapes), opts);
}

// The universal executor answering every goal — the observed description-blind choice.
const BLIND_SHELL = ["shellResult"];

for (const cat of CATALOGS) {
  describe(`[${cat.label}] (i) a quantitative question targets the advertised read shape that answers it`, () => {
    it("MUST-FAIL (i): LLM unavailable — the described read shape is the primary target, not shellResult", async () => {
      const d = await decide(cat.goals.quantitative, cat, stub(null).complete);
      expect(d.shapes[0]).toBe(cat.tally);
      expect(d.shapes).not.toContain("shellResult");
    });

    it("MUST-FAIL (i): description-blind LLM answers shellResult — the described read shape still leads", async () => {
      const d = await decide(cat.goals.quantitative, cat, stub(BLIND_SHELL).complete);
      expect(d.shapes[0]).toBe(cat.tally);
      expect(d.shapes).not.toContain("shellResult");
    });

    it("MUST-FAIL (i): descriptions are read at choice time — any LLM consulted is shown them", async () => {
      const s = stub(BLIND_SHELL);
      await decide(cat.goals.quantitative, cat, s.complete);
      for (const p of s.prompts) {
        expect(p).toContain(cat.shapes[cat.tally]);
        expect(p).toContain(cat.shapes.shellResult);
      }
    });
  });

  describe(`[${cat.label}] (iii) a compound request keeps every need`, () => {
    it("MUST-FAIL (iii): LLM unavailable — both the lookup and the post are targets", async () => {
      const d = await decide(cat.goals.compound, cat, stub(null).complete);
      expect(d.shapes).toContain(cat.lookup);
      expect(d.shapes).toContain(cat.post);
    });

    it("MUST-FAIL (iii): LLM keeps only the first need — the second is restored", async () => {
      const d = await decide(cat.goals.compound, cat, stub([cat.lookup], 0.8).complete);
      expect(d.shapes).toContain(cat.lookup);
      expect(d.shapes).toContain(cat.post);
    });

    // Both directions: a stage that matches the WHOLE goal to one shape can cover the other
    // need by accident in one direction, never in both.
    it("MUST-FAIL (iii): LLM keeps only the second need — the first is restored", async () => {
      const d = await decide(cat.goals.compound, cat, stub([cat.post], 0.8).complete);
      expect(d.shapes).toContain(cat.lookup);
      expect(d.shapes).toContain(cat.post);
    });

    // Both directions: a stage that matches the WHOLE goal to one shape can cover the other
    // need by accident in one direction, never in both.
    it("MUST-FAIL (iii): LLM keeps only the second need — the first is restored", async () => {
      const d = await decide(cat.goals.compound, cat, stub([cat.post], 0.8).complete);
      expect(d.shapes).toContain(cat.lookup);
      expect(d.shapes).toContain(cat.post);
    });
  });

  describe(`[${cat.label}] controls (green at base)`, () => {
    it("CONTROL: a genuine shell request ('run <command>') targets shellResult, not a described store shape", async () => {
      const d = await decide("Run `wc -l /etc/hosts` and report the output.", cat, stub(BLIND_SHELL).complete);
      expect(d.shapes[0]).toBe("shellResult");
      for (const s of [cat.tally, cat.lookup, cat.post]) expect(d.shapes).not.toContain(s);
    });

    it("CONTROL: a single-need request targets exactly its one shape", async () => {
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
