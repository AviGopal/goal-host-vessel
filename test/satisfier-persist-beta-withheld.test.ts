// A β THE WALK WITHHELD MUST RIDE ON THE SATISFIER TRACE IT PERSISTS.
//
// WHY. When a not-reached walk withholds β for a satisfier pick (log "NOT REACHED but β WITHHELD for satisfier:<x>"),
// the durable satisfier trace was persisted status "failed" with its reach tag removed, on the theory that an
// untagged satellite is ungraded. It is ungraded, but activity-api's insert path blamed it β=1 anyway (its
// ungraded-failure arm), about 19 ms after the withhold: 590 of 602 withholds on one node. activity-api now honours a
// beta_withheld flag at insert; this pins that goal-host sends it.
//
// THE RULE PINNED HERE:
//   - The satisfier persist for a walk that withheld β sends tags beta_withheld:true and
//     beta_withheld_reason:<reason>, from the SAME decision (walkBetaWithheld; the reason is betasend's dispatch-record
//     entry for lastTrace.id, which is the persisted trace's id, since durableTrace spreads lastTrace).
//   - A satisfier persist that did not withhold β sends no such tag, and keeps its reach tag.
//
// The walk needs a live host and the fleet, so the call site is pinned on the source (as betasend's tests do); the
// tags it builds are driven through the real TranslatingTraceSink with a fetch recorder on the insert call.
//
// Hermetic: the spool dir is a temp dir (set before import: the module constructs a sink at load), and a network
// guard fails any fetch outside the stub origin and any WebSocket.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STUB_ORIGIN = "http://127.0.0.1:9";
process.env["IAS_TRACE_SPOOL_DIR"] = mkdtempSync(join(tmpdir(), "satfix-spool-"));
process.env["LLM_VESSEL_ENDPOINT"] ||= STUB_ORIGIN;
// Module bootstrap resolves through discovery; point every fleet endpoint it reads at the stub.
process.env["DISCOVERY_VESSEL_ENDPOINT"] ||= STUB_ORIGIN;
process.env["ACTIVITY_API_ENDPOINT"] ||= STUB_ORIGIN;

// ---- Network guard ----------------------------------------------------------
const forbiddenNet: string[] = [];
function forbidNetwork(what: string): never {
  forbiddenNet.push(what);
  throw new Error(`NETWORK GUARD: ${what}`);
}
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
globalThis.fetch = (async (input: unknown) => {
  const url = String(input instanceof Request ? input.url : input);
  let origin = "";
  try { origin = new URL(url).origin; } catch { /* not a URL */ }
  if (origin !== STUB_ORIGIN) forbidNetwork(`fetch ${url}`);
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
(globalThis as any).WebSocket = class GuardedWebSocket {
  constructor(url: unknown) { forbidNetwork(`WebSocket ${String(url)}`); }
};
let forbiddenSeen = 0;
afterEach(() => {
  const fresh = forbiddenNet.slice(forbiddenSeen);
  forbiddenSeen = forbiddenNet.length;
  expect(fresh).toEqual([]);
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  (globalThis as any).WebSocket = originalWebSocket;
});

const mod = await import("../src/index");
const withBetaWithheld = (mod as { withBetaWithheld?: (t: readonly string[] | undefined, r: string | null | undefined) => string[] }).withBetaWithheld;
const { TranslatingTraceSink } = await import("@avigopal/ias-executor-ts/adapters");
const SRC = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");

const WHY = "alpha-unreachable-non-deterministic-no-edge";

/** The satisfier-last trace as the walk holds it, then the durableTrace the persist builds from it. */
function lastTrace(): Record<string, unknown> {
  return {
    id: "walk-satisfier-3-1791378965133",
    templateId: "satisfier:substrateObservable",
    status: "completed",
    durationMs: 12,
    costUsd: 0,
    tags: ["surface:mcp", "reached:true"],
    metadata: { satisfier: true },
    tasks: [{ taskId: "t1", success: true, resolverId: "vessel", outputShapes: ["substrateObservable"] }],
  };
}
/** Mirrors the persist block: the untagged-when-withheld tags expression, then the withheld tags. */
function durableTrace(reached: boolean, walkBetaWithheld: boolean, reason: string | null): Record<string, unknown> {
  const lt = lastTrace();
  const existing = (lt.tags as string[]).filter((t) => !/^reached:/.test(t));
  const d: Record<string, unknown> = {
    ...lt,
    status: reached ? "completed" : "failed",
    tags: (!reached && walkBetaWithheld) ? existing : [...existing, reached ? "reached:true" : "reached:false"],
  };
  if (!reached && walkBetaWithheld) d.tags = withBetaWithheld!(d.tags as string[], reason);
  return d;
}
/** Persist through the real sink with the insert call recorded; returns the POST /execution-traces bodies. */
async function insertBodies(trace: Record<string, unknown>): Promise<Record<string, any>[]> {
  const bodies: Record<string, any>[] = [];
  const sink = new TranslatingTraceSink(STUB_ORIGIN, "test-key", {
    fetch: {
      request: async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/v2/activities/execution-traces")) bodies.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 200 });
      },
    },
  } as never);
  await sink.record(trace as never);
  return bodies;
}

describe("the persisted satisfier trace carries the withhold to activity-api's insert", () => {
  test("MUST-FAIL: a withheld not-reached satisfier persist sends beta_withheld:true and the reason", async () => {
    expect(typeof withBetaWithheld).toBe("function");
    const [b] = await insertBodies(durableTrace(false, true, WHY));
    expect(b).toBeDefined();
    expect(b!.execution_id).toBe("walk-satisfier-3-1791378965133");
    expect(b!.success).toBe(false);
    expect(b!.tags).toEqual(expect.arrayContaining(["beta_withheld:true", `beta_withheld_reason:${WHY}`]));
    expect((b!.tags as string[]).some((t) => t.startsWith("reached:"))).toBe(false);
  });

  test("CONTROL: a not-withheld not-reached satisfier persist sends no beta_withheld tag and keeps reached:false", async () => {
    const [b] = await insertBodies(durableTrace(false, false, null));
    expect(b!.tags).toContain("reached:false");
    expect((b!.tags as string[]).some((t) => t.startsWith("beta_withheld"))).toBe(false);
    expect(Object.keys(b!)).not.toContain("beta_withheld");
  });

  test("CONTROL: a reached satisfier persist sends no beta_withheld tag", async () => {
    const [b] = await insertBodies(durableTrace(true, true, WHY));
    expect(b!.tags).toContain("reached:true");
    expect((b!.tags as string[]).some((t) => t.startsWith("beta_withheld"))).toBe(false);
  });

  test("withBetaWithheld replaces, never duplicates, and omits an absent reason", () => {
    expect(withBetaWithheld!(["a", "beta_withheld:true", "beta_withheld_reason:old"], WHY)).toEqual(["a", "beta_withheld:true", `beta_withheld_reason:${WHY}`]);
    expect(withBetaWithheld!(undefined, null)).toEqual(["beta_withheld:true"]);
  });
});

describe("the persist site sends the flag from the walk's own decision (pinned on the source)", () => {
  const block = (() => {
    const i = SRC.indexOf("if (satisfierOnlyTrace) {");
    expect(i).toBeGreaterThan(-1);
    const end = SRC.indexOf("void persistSatisfierTrace(durableTrace);", i);
    expect(end).toBeGreaterThan(i);
    return SRC.slice(i, end + "void persistSatisfierTrace(durableTrace);".length);
  })();

  test("MUST-FAIL: the durable trace gets the withheld tags, gated on walkBetaWithheld, before it is persisted", () => {
    expect(block).toContain("if (!reached && walkBetaWithheld) durableTrace.tags = withBetaWithheld(durableTrace.tags, walkBetaWithheldReason);");
    expect(block.indexOf("withBetaWithheld(")).toBeLessThan(block.indexOf("void persistSatisfierTrace(durableTrace);"));
  });

  test("MUST-FAIL: the reason is the decision's — betasend's record entry for lastTrace.id, set where β is withheld", () => {
    const decided = SRC.indexOf("walkBetaWithheld = _noOracle || _betaWithheldForSymmetry;");
    expect(decided).toBeGreaterThan(-1);
    const after = SRC.slice(decided, decided + 900);
    const setAt = after.indexOf("if (walkBetaWithheld) opts.betaWithheld?.set(lastTrace.id, _noOracle ?");
    const reasonAt = after.indexOf("if (walkBetaWithheld) walkBetaWithheldReason = opts.betaWithheld?.get(lastTrace.id) ??");
    expect(setAt).toBeGreaterThan(-1);
    expect(reasonAt).toBeGreaterThan(setAt);
    // An abstain withholds β too and its trace persists failed and untagged: it is named as well, on the line that
    // declares the reason, right before the abstain branch (whose shape judge-view-gate pins).
    const decl = SRC.indexOf('let walkBetaWithheldReason: string | null = verdict?.abstain ? "verdict-abstain" : null;');
    expect(decl).toBeGreaterThan(-1);
    const abstain = SRC.indexOf("if (verdict?.abstain) {\n        status = \"failed\";\n        walkBetaWithheld = true;", decl);
    expect(abstain).toBeGreaterThan(decl);
    expect(abstain - decl).toBeLessThan(400);
    // The reason is not recomputed or reassigned anywhere else.
    expect(SRC.split(/walkBetaWithheldReason = /).length - 1).toBe(1);
  });

  test("the persisted trace's id is the record's key: durableTrace spreads lastTrace and nothing reassigns it between", () => {
    expect(block).toContain("...lastTrace,");
    const decided = SRC.indexOf("walkBetaWithheld = _noOracle || _betaWithheldForSymmetry;");
    const persist = SRC.indexOf("if (satisfierOnlyTrace) {");
    expect(/\blastTrace\s*=(?!=)/.test(SRC.slice(decided, persist))).toBe(false);
  });
});

describe("network guard", () => {
  test("no fetch left the stub origin and no WebSocket was opened", () => {
    expect(forbiddenNet).toEqual([]);
  });
});
