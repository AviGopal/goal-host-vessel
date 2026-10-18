// A QUESTION ABOUT THIS SYSTEM'S OWN STATE NEEDS A LOCAL READ — STRUCTURALLY, THROUGH THE REAL GATE.
//
// The third referent class of gap the-llm-reach-judge-accepts-ungrounded-answers-to-current-information-
// and-self-description-goals. The first cut keyed the rule on a WORD LIST, and qa found it refusing
// general-knowledge questions answered by one LLM step ("the pool of candidates", "/usr/bin on Linux",
// "this system of equations", "the memory store in Redux", …). The rule is now STRUCTURAL: it applies
// when the goal's targets include a local-read shape that THIS substrate's own vessels serve (resolved
// through discovery at use time, own-substrate rows only), whatever the goal's words.
//
// Also here: the floor's reach gate is handed the read tools the floor EXECUTED (floorJudgedShapes). Its real
// effect is on the current-information rule: an executed web search is an in-run source. On the floor the
// local-state rule is inert for now: the floor's requested targets are in its produced shapes, so a local-read
// target always counts as read (named debt in the commit that rewrote T6).
//
// NO LIVE SERVICES. globalThis.fetch is replaced BEFORE index.ts is imported; discovery names a local
// shell/file vessel (this substrate's own), a peer-only producer, and an llm vessel; anything else 404s.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const LLM_VESSEL = "http://llm-vessel.test.invalid/resolve";
const JUDGE_MARK = "You verify whether a substrate execution REACHED";
const JUDGE_REASON = "stub judge: the answer addresses the goal";

const realFetch = globalThis.fetch;
let judgeCalls = 0;

function stubFetch(input: unknown, init?: { body?: unknown }): Promise<Response> {
  const body = typeof init?.body === "string" ? init.body : "";
  const json = (o: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } }));
  if (body.includes(JUDGE_MARK)) {
    judgeCalls++;
    const verdict = JSON.stringify({ reached: true, reason: JUDGE_REASON, completion_shapes: ["llm_completion_dispatch"] });
    return json({ content: { body: { content: verdict } }, body: { content: verdict } });
  }
  if (body.includes('"vesselCapability"') && body.includes('"llm_completion"')) {
    return json({ content: { vessels: [{ id: "llm-test-vessel", endpoint: "http://llm-vessel.test.invalid", resolve_endpoint: LLM_VESSEL, protocol: "http" }] } });
  }
  if (body.includes('"vesselCapability"') && (body.includes('"shellResult"') || body.includes('"fs_read"'))) {
    return json({ content: { vessels: [{ id: "local-tools", endpoint: "http://local-tools.test.invalid", resolve_endpoint: "http://local-tools.test.invalid/resolve", protocol: "http", origin: "local" }] } });
  }
  if (body.includes('"vesselCapability"') && (body.includes('"memoryNote"') || body.includes('"web_resource"'))) {
    return json({ content: { vessels: [{ id: "own-other", endpoint: "http://own-other.test.invalid", resolve_endpoint: "http://own-other.test.invalid/resolve", protocol: "http", origin: "local" }] } });
  }
  if (body.includes('"vesselCapability"') && body.includes('"fileContent"')) {
    return Promise.reject(new Error("stub: discovery unreachable"));
  }
  if (body.includes('"vesselCapability"') && body.includes('"peerInventory"')) {
    return json({ content: { vessels: [{ id: "peer-vessel", endpoint: "http://peer.test.invalid", resolve_endpoint: "http://peer.test.invalid/resolve", protocol: "http", origin: "peer", peerEndpoint: "http://peer.test.invalid" }] } });
  }
  return json({ error: "stub: not served" }, 404);
}

type Verdict = { reached: boolean; reason: string; deterministic?: boolean; judge_verdict_before_pregate?: { reached: boolean | null; reason: string } };
type Gate = (goal: string, producedShapes: string[], taskSummary: string, contentDigest?: string, commandEvidence?: string, walkEvidence?: unknown, judgeView?: unknown, deliverables?: string[]) => Promise<Verdict | null>;
let verifyGoalReached: Gate;
let floorJudgedShapes: (targets: readonly string[], writes: ReadonlySet<string>, executed: ReadonlyArray<{ tool: string; ok: boolean }>) => string[];
let rewardBufferEntries: (key?: string) => number;

const stateDir = require("node:path").join(import.meta.dir, "..", ".local-state-gate-state");
const prevEnv = { store: process.env["GOAL_HOST_DISPATCH_STORE_PATH"], dump: process.env["MEM_DUMP_PATH"] };

beforeAll(async () => {
  require("node:fs").mkdirSync(stateDir, { recursive: true });
  process.env["GOAL_HOST_DISPATCH_STORE_PATH"] = `${stateDir}/dispatches.json`;
  process.env["MEM_DUMP_PATH"] = `${stateDir}/mem-dump.json`;
  globalThis.fetch = stubFetch as unknown as typeof fetch;
  process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
  const mod = await import("../src/index");
  verifyGoalReached = mod.verifyGoalReached as unknown as Gate;
  floorJudgedShapes = (mod as unknown as { floorJudgedShapes: typeof floorJudgedShapes }).floorJudgedShapes;
  ({ rewardBufferEntries } = await import("../src/llm-router"));
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (prevEnv.store === undefined) delete process.env["GOAL_HOST_DISPATCH_STORE_PATH"]; else process.env["GOAL_HOST_DISPATCH_STORE_PATH"] = prevEnv.store;
  if (prevEnv.dump === undefined) delete process.env["MEM_DUMP_PATH"]; else process.env["MEM_DUMP_PATH"] = prevEnv.dump;
  try { require("node:fs").rmSync(stateDir, { recursive: true, force: true }); } catch { /* temp dir */ }
});

const LLM_ONLY = ["goal", "dispatch_id", "llm_completion_dispatch"];
const llmOnly = (goal: string, answer: string) => [
  `- goal: ${JSON.stringify({ goal })}`,
  `- dispatch_id: 6f1c1a52-0000-4000-8000-000000000003`,
  `- llm_completion_dispatch: ${answer}`,
].join("\n");
const FS_GOAL = "What is the structure of the full filesystem from root? List the top-level directories and what each one holds.";
const GENERIC_TREE = "The root contains /bin for essential binaries, /etc for configuration, /home for user directories, /usr for user programs and /var for variable data.";

// qa's false positives of the word-list cut: general-knowledge questions, one LLM step, an answer-shaped target.
const GENERAL_KNOWLEDGE = [
  "Who is in the pool of candidates for the city council election in Lisbon?",
  "Who won the pool tournament at the 2024 Olympics?",
  "Explain what the default /etc/nginx/nginx.conf contains on a fresh install.",
  "Explain what is usually kept in /usr/bin on Linux.",
  "Explain what the GitHub REST /repos/{owner}/{repo} endpoint returns.",
  "Describe the Linux filesystem hierarchy from root.",
  "Derive the quadratic formula from root principles.",
  "Solve this system of equations: x + y = 3 and x - y = 1.",
  "Explain how this machine learning pipeline handles class imbalance: a scaler, then a random forest.",
  "Explain which ports PostgreSQL is listening on by default.",
  "Explain how to see the packages installed on Ubuntu.",
  "Explain which Kubernetes daemons are running on a typical worker node.",
  "Explain the Docker pattern for listing active containers.",
  "Explain what the memory store in Redux is.",
  "Explain what the dispatch store in Flux is.",
  "Explain what a concept graph in knowledge representation is.",
  "Show a bash script that lists systemd units.",
  "Explain what the trace store in an OpenTelemetry collector holds.",
];

describe("T2: general-knowledge questions do not trip the local-state gate (no local target, whatever the words)", () => {
  for (const goal of GENERAL_KNOWLEDGE) {
    test(goal, async () => {
      judgeCalls = 0;
      const v = await verifyGoalReached(goal, LLM_ONLY, "1 step: llm_completion_dispatch", llmOnly(goal, "Here is a direct, committed answer to the question asked."), undefined, undefined, undefined, ["llm_completion"]);
      expect(v?.reason ?? "").not.toMatch(/unsourced-local-state/);
      expect(v?.reason).toBe(JUDGE_REASON);
      expect(v?.judge_verdict_before_pregate).toBeUndefined();
    }, 20_000);
  }
});

describe("T4: a question about this system, answered from model memory, is not reached", () => {
  test("the filesystem-from-root goal, targeting a local read this substrate serves, answered by one llm step → unsourced-local-state; the shadow judge is recorded and unrewarded", async () => {
    judgeCalls = 0;
    const before = rewardBufferEntries();
    const v = await verifyGoalReached(FS_GOAL, LLM_ONLY, "1 step: llm_completion_dispatch", llmOnly(FS_GOAL, GENERIC_TREE), undefined, undefined, undefined, ["shellResult"]);
    expect(v?.reached).toBe(false);
    expect(v?.reason).toMatch(/^deterministic:unsourced-local-state /);
    expect(judgeCalls).toBe(1);
    expect(v?.judge_verdict_before_pregate).toEqual({ reached: true, reason: JUDGE_REASON });
    expect(rewardBufferEntries()).toBe(before);
  }, 20_000);

  test("control: the same goal whose only local-read target is served by a federated PEER → not this system: the judge decides", async () => {
    const v = await verifyGoalReached(FS_GOAL, LLM_ONLY, "1 step: llm_completion_dispatch", llmOnly(FS_GOAL, GENERIC_TREE), undefined, undefined, undefined, ["peerInventory"]);
    expect(v?.reason).toBe(JUDGE_REASON);
  }, 20_000);

  test("control: the same goal with a shellResult read in the chain → the judge decides", async () => {
    const shapes = ["goal", "dispatch_id", "shellResult", "llm_completion_dispatch"];
    const dig = `${llmOnly(FS_GOAL, GENERIC_TREE)}\n- shellResult: {"stdout":"bin\\netc\\nhome","exit_code":0}`;
    const v = await verifyGoalReached(FS_GOAL, shapes, "2 steps", dig, undefined, undefined, undefined, ["shellResult"]);
    expect(v?.reason).toBe(JUDGE_REASON);
  }, 20_000);
});

describe("local reads are a POSITIVE role set (files, code, shell), not 'anything else'", () => {
  test("a web_resource or memoryNote step in the chain is not a local read of this host → still unsourced-local-state", async () => {
    for (const extra of ["web_resource", "memoryNote"]) {
      const shapes = ["goal", "dispatch_id", extra, "llm_completion_dispatch"];
      const v = await verifyGoalReached(FS_GOAL, shapes, "2 steps", `${llmOnly(FS_GOAL, GENERIC_TREE)}\n- ${extra}: {"content":"..."}`, undefined, undefined, undefined, ["shellResult"]);
      expect(v?.reason).toMatch(/^deterministic:unsourced-local-state /);
    }
  }, 20_000);

  test("a goal whose own-served target is memoryNote or web_resource is not a local-state question → the judge decides", async () => {
    for (const target of ["memoryNote", "web_resource"]) {
      const v = await verifyGoalReached("Summarise what the notes say about release planning.", LLM_ONLY, "1 step", llmOnly("Summarise what the notes say about release planning.", "They say to plan releases weekly."), undefined, undefined, undefined, [target]);
      expect(v?.reason).toBe(JUDGE_REASON);
    }
  }, 20_000);

  test("discovery unreachable for a local target → the rule is off for the call, and says so", async () => {
    const warn = console.warn; const seen: string[] = [];
    console.warn = (...a: unknown[]) => { seen.push(a.map(String).join(" ")); };
    try {
      const v = await verifyGoalReached(FS_GOAL, LLM_ONLY, "1 step", llmOnly(FS_GOAL, GENERIC_TREE), undefined, undefined, undefined, ["fileContent"]);
      expect(v?.reason).toBe(JUDGE_REASON);
    } finally { console.warn = warn; }
    expect(seen.some((l) => l.includes("[local-state] discovery unreachable") && l.includes("fail-open"))).toBe(true);
  }, 20_000);
});

// T6 at the REAL floor call shape (index.ts universalToolFallback): the floor passes produced = floorJudgedShapes(
// targetShapes, writes, executed), deliverables undefined, and writeEvidence { targets: targetShapes, surface: "floor" }.
describe("T6: the floor's executed reads are evidence (the real floor call shape)", () => {
  const floorGate = (goal: string, targets: string[], executed: Array<{ tool: string; ok: boolean }>, digest: string) =>
    (verifyGoalReached as unknown as (...a: unknown[]) => Promise<Verdict | null>)(
      goal, floorJudgedShapes(targets, new Set(), executed),
      `universal ReAct fallback: ${executed.filter((e) => e.ok).length}/${executed.length} tool call(s) OK [${executed.map((e) => e.tool + (e.ok ? "" : "!")).join(", ")}]`,
      digest, undefined, undefined, undefined, undefined, undefined, { persistedWrites: [], targets, surface: "floor" }, "floor");
  const NEWS = "Summarise this week's news on semiconductor supply chains.";
  const NEWS_ANSWER = "Chipmakers announced capacity expansions and several governments discussed export controls.";

  test("a floor that EXECUTED a web search for a current-information goal passes the current-information rule", async () => {
    const v = await floorGate(NEWS, ["llm_completion"], [{ tool: "webSearchResult", ok: true }], NEWS_ANSWER);
    expect(v?.reason ?? "").not.toMatch(/unsourced-current-information/);
    expect(v?.reason).toBe(JUDGE_REASON);
  }, 20_000);

  test("control: a floor that executed NO tool for it → unsourced-current-information", async () => {
    const v = await floorGate(NEWS, ["llm_completion"], [], NEWS_ANSWER);
    expect(v?.reason).toMatch(/^deterministic:unsourced-current-information /);
  }, 20_000);

  test("control: a floor whose web search FAILED made no read → unsourced-current-information", async () => {
    const v = await floorGate(NEWS, ["llm_completion"], [{ tool: "webSearchResult", ok: false }], NEWS_ANSWER);
    expect(v?.reason).toMatch(/^deterministic:unsourced-current-information /);
  }, 20_000);

  test("a floor that EXECUTED fs_read for a local-state goal passes the local-state gate (NOTE: it would pass without the read too — the floor's targets are in its produced shapes; named debt)", async () => {
    const v = await floorGate(FS_GOAL, ["shellResult"], [{ tool: "fs_read", ok: true }], `${GENERIC_TREE}\n\n--- grounded tool outputs ---\nTOOL fs_read => bin etc home`);
    expect(v?.reason ?? "").not.toMatch(/unsourced-local-state/);
  }, 20_000);
});
