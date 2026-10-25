// A GOAL IS NEVER COALESCED INTO A REQUEUED DISPATCH OF ANOTHER ORIGIN. After a restart goal-host requeues every
// interrupted dispatch the store held; once that was a test fixture ("inbound-auth fixture walk"), which then walked live
// for 25 minutes and spent the LLM dispatch budget. /run-goal coalesces an identical in-flight goal into the running
// record, so a goal of a DIFFERENT origin with the same text would be folded into that requeue and run, and be graded,
// as it. The rule (src/request-queue.ts coalescesInto, used by index.ts handleRunGoal): same text and still running, and
// for a requeued record the same origin. Unrequeued duplicates coalesce as before (the livelock bound).
//
// On the parent the rule is the old inline one (text + running only); the fallback below reproduces it, so the
// MUST-FAIL case fails there on behaviour.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as rq from "../src/request-queue";

type Rec = { status?: unknown; goal?: unknown; requeuedAt?: unknown; initiator?: unknown; principal?: { kind?: unknown } };
const coalescesInto = (rq as unknown as { coalescesInto?: (rec: Rec, goal: string, origin: "system" | "operator") => boolean }).coalescesInto
  ?? ((rec: Rec, goal: string) => rec.status === "running" && typeof rec.goal === "string" && rec.goal.trim() === goal);
const INDEX = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");

const G = "inbound-auth fixture walk";
const requeuedFixture: Rec = { status: "running", goal: G, requeuedAt: 1792900638234, initiator: "system", principal: { kind: "node_self" } };

describe("coalescing into a requeued dispatch", () => {
  test("[MUST-FAIL] a live operator goal with the same text as a requeued system/fixture dispatch is NOT coalesced", () => {
    expect(coalescesInto(requeuedFixture, G, "operator")).toBe(false);
    // a requeued record with no origin at all (a pre-door or seeded record) matches no live origin
    expect(coalescesInto({ status: "running", goal: G, requeuedAt: 1 }, G, "system")).toBe(false);
  });
  test("[CONTROL] same-origin duplicates still coalesce, requeued or not; an unrequeued duplicate coalesces as before", () => {
    expect(coalescesInto(requeuedFixture, G, "system")).toBe(true);
    expect(coalescesInto({ status: "running", goal: G, requeuedAt: 1, initiator: "operator" }, G, "operator")).toBe(true);
    expect(coalescesInto({ status: "running", goal: G, initiator: "system" }, G, "operator")).toBe(true);
    expect(coalescesInto({ status: "completed", goal: G, initiator: "operator" }, G, "operator")).toBe(false);
    expect(coalescesInto({ status: "running", goal: "another goal", initiator: "operator" }, G, "operator")).toBe(false);
  });
  test("[MUST-FAIL] handleRunGoal's coalesce loop asks coalescesInto with the request's origin", () => {
    expect(INDEX).toContain("if (requestQueue.coalescesInto(rec, norm, _origin)) {");
    expect(INDEX).toContain("const _origin = requestQueue.dispatchInitiator(principal, { requeueOf: requeueId, tags, heldRequeue: (id) => requeueInitiators.get(id),");
  });
});
