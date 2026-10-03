import { afterAll, beforeAll, describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// NAMESPACE import on purpose: the gate does not exist at base, and a named import of a missing
// export fails the whole file at link time, which would turn the base-green controls red too.
import * as rp from "../src/resolve-pointer";
import ts from "typescript";

/**
 * A PRODUCER'S REQUIRED INPUTS ARE BOUND BEFORE THE WALK INVOKES IT (check-first).
 *
 * Gap: the-walk-invokes-llm-completion-dispatch-with-no-prompt-so-every-floor-llm-call-from-a-
 * satisfier-fails-before-any-provider.
 *
 * MEASURED, node 1, 2026-10-03. The walk ran the learned satisfier template for
 * `llm_completion_dispatch` with input impulses = the goal plus bookkeeping and NO `prompt`. The
 * template's task resolved through `buildProxyResolver`, whose pointer is
 * `buildResolvePointer(shape, variables, config)` — the goal, the dispatch id, nothing named
 * `prompt`. development-vessel passed that pointer straight to resolveLlmCompletionDispatch
 * (`prompt: pointer.prompt` = undefined), llm-resolver refused "body must include non-empty
 * 'prompt' string" before any provider call, and the learned template was graded as failed (~71
 * executions, 0 successes). The walk's DIRECT path (rawResolve) starts prompt-less the same way
 * and is rescued only by the arg-correction round trip after the resolver refuses.
 *
 * THE CLASS IS A BINDING CONTRACT, NOT A PROMPT SPECIAL CASE. A producer's REQUIRED inputs must be
 * bound before the walk invokes it. For each required input the walk either
 *   (a) finds it bound in the pointer it built, or
 *   (b) SYNTHESIZES it from what it has, when the producer declares how that input may be
 *       synthesized (for an LLM leg: the goal plus bound upstream content), or
 *   (c) does NOT invoke the producer, and records "unbindable required input: <name>".
 * This must hold on the FIRST invocation — no refusal / arg-correction round trip.
 *
 * WHERE REQUIRED INPUTS ARE DECLARED (pinned here, because for this shape no declaration exists
 * at base). The declaration channel is the owning vessel's `resolver_schema` answer, read at
 * invocation time through discovery — the same answer `llmExtractPointerArgs` already reads to
 * feed `bindArgsFromPool` (index.ts, "AUTHORITATIVE PAYLOAD CONTRACT"):
 *
 *     { shape, known: boolean, envelope?: string,
 *       fields: [{ name, required: boolean, type, synthesize_from?: "goal_and_upstream" }] }
 *
 * Two things are missing at base and are pinned by this file and its development-vessel twin:
 *   1. development-vessel's CONTRACTS map has no entry for `llm_completion_dispatch`, so it
 *      answers known:false — nothing says `prompt` is required.
 *   2. Nothing in a contract says HOW a missing required field may be synthesized. The per-field
 *      `synthesize_from` provenance is that declaration. It is what makes "an LLM leg gets the goal
 *      plus upstream content" a DECLARED rule rather than a name match on "prompt": a field is
 *      synthesized because its producer says it may be, never because of what it is called.
 *      NOT a hardcoded per-shape list in goal-host, and not a frozen constant (law 1).
 *   A contract that is unknown (known:false / unreachable) cannot be judged: the gate invokes the
 *   pointer unchanged, exactly as today. Declaring a contract is the owning vessel's job.
 *
 * THE SEAM (pinned):
 *   resolve-pointer.ts exports
 *     bindRequiredInputs({ shape, pointer, contract, goal, upstream })
 *       -> { invoke: true,  pointer }                       (bound or synthesized)
 *        | { invoke: false, reason, missing: string[] }     (reason "unbindable required input: <name>")
 *   `pointer` is buildResolvePointer's output; `upstream` is the step's bound input impulses
 *   ({metadata.shape, content}); bookkeeping-only content (isBookkeepingOnly) is not content.
 *   index.ts calls it between buildResolvePointer and the producer POST at ALL THREE invocation
 *   sites — rawResolve (walk direct path), buildProxyResolver (the path the measured template
 *   took) and buildDiscoveryProxyResolver — with the contract read at use time by
 *   `requiredInputContract(shape)` (a `resolver_schema` resolve). On refusal rawResolve records the
 *   reason with noteRawResolveFailure and returns null; the proxies throw the reason so the engine
 *   records it as the task's failure.
 *
 * CONTROLS are written against what exists at base and must survive the fix: buildResolvePointer
 * leaves a fully-bound pointer unchanged, and every site builds its pointer with it.
 */

type Field = { name: string; required: boolean; type: string; synthesize_from?: string };
type Contract = { shape: string; known: boolean; envelope?: string; fields?: Field[] };
type Decision =
  | { invoke: true; pointer: Record<string, unknown> }
  | { invoke: false; reason: string; missing: string[] };
type Gate = (a: {
  shape: string;
  pointer: Record<string, unknown>;
  contract: Contract | null;
  goal: string;
  upstream: ReadonlyArray<{ metadata?: { shape?: string }; content?: unknown }>;
}) => Decision;

function gate(): Gate {
  const g = (rp as Record<string, unknown>)["bindRequiredInputs"];
  expect(typeof g, "resolve-pointer.ts must export bindRequiredInputs (the required-input binding gate)").toBe("function");
  return g as Gate;
}

const GOAL = "Summarise which vessels restarted in the last hour and why";
const DISPATCH = "dispatch-7f3a";

// What the measured pointer looked like: pool defaults (goal + bookkeeping), no prompt.
const goalImpulse = { metadata: { shape: "goal" }, content: { goal: GOAL } };
const bookkeeping = { metadata: { shape: "execution_receipt" }, content: { executionId: "exec-1", producedBy: "walk", timestamp: "2026-10-03T10:00:00Z" } };
const upstreamData = { metadata: { shape: "vesselRestartLog" }, content: "concept-db restarted 09:41 (OOM); goal-host restarted 09:58 (deploy)" };

// ── CROSS-REPO CONTRACT FIXTURES ────────────────────────────────────────────────────────────────
// Vessels cannot import the super-repo's packages/ (packages/verdict-token/verdict-token.ts says so;
// none of the four ends has a file: dependency on packages/, and each repo's CI clones it alone).
// Until the shared definition exists, each end asserts against a FIXTURE copied verbatim from the
// emitter's test. Blocks are delimited so a super-repo check can compare them byte for byte.
// CONTRACT-FIXTURE synthesize_from BEGIN (emitter: development-vessel test/resolvers/llm-completion-dispatch-refuses-a-missing-prompt.test.ts)
const SYNTHESIZE_FROM_GOAL_AND_UPSTREAM = "goal_and_upstream";
// CONTRACT-FIXTURE synthesize_from END
// CONTRACT-FIXTURE malformed_request_carrier BEGIN (emitter: goal-host-vessel test/required-inputs-are-bound-before-a-producer-is-invoked.test.ts)
const CARRIER_FORMAT = "dev-vessel <shape> resolver returned structuredError (failure_mode=<token>): <detail>";
const formatCarrier = (shape: string, token: string, detail: string): string =>
  CARRIER_FORMAT.replace("<shape>", () => shape).replace("<token>", () => token).replace("<detail>", () => detail);
const carrierToken = (reason: string): string | null =>
  /\bresolver returned structuredError \(failure_mode=([a-z0-9_]+)\)/.exec(reason)?.[1] ?? null;
// CONTRACT-FIXTURE malformed_request_carrier END

// The contract development-vessel must serve for llm_completion_dispatch (pinned by its twin test).
const LLM_DISPATCH_CONTRACT: Contract = {
  shape: "llm_completion_dispatch",
  known: true,
  fields: [
    { name: "prompt", required: true, type: "string", synthesize_from: SYNTHESIZE_FROM_GOAL_AND_UPSTREAM },
    { name: "system_prompt", required: false, type: "string" },
    { name: "max_tokens", required: false, type: "number" },
  ],
};

// ── STRUCTURAL PINS READ THE SYNTAX TREE, NOT THE TEXT ──────────────────────────────────────────
// Order and presence are judged on TypeScript AST positions of CALLS inside the named function, so
// whitespace, comments, local renames and line moves do not matter; only the calls and their order do.
const INDEX_PATH = new URL("../src/index.ts", import.meta.url).pathname;
const GATE_PATH = new URL("../src/resolve-pointer.ts", import.meta.url).pathname;
const _sf = new Map<string, ts.SourceFile>();
function sourceOf(path: string): ts.SourceFile {
  let sf = _sf.get(path);
  if (!sf) { sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS); _sf.set(path, sf); }
  return sf;
}
function walk(node: ts.Node, visit: (n: ts.Node) => void): void { visit(node); node.forEachChild((c) => walk(c, visit)); }
/** The function named `name`: a function declaration, or a const bound to an arrow/function expression. */
function fnNamed(path: string, name: string): ts.Node {
  let found: ts.Node | undefined;
  walk(sourceOf(path), (n) => {
    if (found) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer
      && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) found = n.initializer;
  });
  expect(found !== undefined, `function '${name}' must exist in ${path.split("/").slice(-2).join("/")}`).toBe(true);
  return found!;
}
const calleeName = (c: ts.CallExpression | ts.NewExpression): string => {
  const e = c.expression;
  return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : "";
};
/** Start positions of every call to `callee` inside `fn`, in source order. */
function callsTo(fn: ts.Node, callee: string): number[] {
  const out: number[] = [];
  walk(fn, (n) => { if (ts.isCallExpression(n) && calleeName(n) === callee) out.push(n.getStart()); });
  return out;
}
/** The producer POST: the LAST fetch call in the site (the discovery proxy fetches discovery first). */
const producerPost = (fn: ts.Node): number => {
  const f = callsTo(fn, "fetch");
  expect(f.length, "the site must POST to its producer").toBeGreaterThan(0);
  return f[f.length - 1]!;
};
const SITES = ["rawResolve", "buildProxyResolver", "buildDiscoveryProxyResolver"];

describe("CONTROL — a fully bound pointer is invoked as built (base behaviour the fix must keep)", () => {
  it("buildResolvePointer leaves a fully bound pointer unchanged (pool < args, shape last)", () => {
    const base = { goal: GOAL, dispatch_id: DISPATCH };
    const args = { prompt: "Summarise the restart log", max_tokens: 900 };
    expect(rp.buildResolvePointer("llm_completion_dispatch", base, args)).toEqual({
      goal: GOAL, dispatch_id: DISPATCH, prompt: "Summarise the restart log", max_tokens: 900, type: "llm_completion_dispatch",
    });
  });

  it("every invocation site builds its producer pointer with buildResolvePointer before the POST", () => {
    for (const name of SITES) {
      const fn = fnNamed(INDEX_PATH, name);
      const b = callsTo(fn, "buildResolvePointer");
      expect(b.length > 0 && b[0]! < producerPost(fn), `${name} must build its pointer with buildResolvePointer before the POST`).toBe(true);
    }
  });
});

describe("MUST-FAIL — the walk never invokes a producer whose declared required input is unbound", () => {
  it("a producer with all required inputs bound is invoked with its pointer unchanged", () => {
    const pointer = rp.buildResolvePointer("llm_completion_dispatch", { goal: GOAL, dispatch_id: DISPATCH }, { prompt: "Summarise the restart log" });
    const before = structuredClone(pointer);
    const d = gate()({ shape: "llm_completion_dispatch", pointer, contract: LLM_DISPATCH_CONTRACT, goal: GOAL, upstream: [goalImpulse, upstreamData] });
    expect(d.invoke).toBe(true);
    if (d.invoke) expect(d.pointer).toEqual(before);
    expect(pointer).toEqual(before); // the caller's pointer is not mutated either
  });

  it("an unbound required input with no declared synthesis is NOT invoked and is recorded as 'unbindable required input: <name>'", () => {
    const contract: Contract = { shape: "gitCommitResult", known: true, fields: [
      { name: "repo", required: true, type: "string" },
      { name: "message", required: true, type: "string" },
    ] };
    const pointer = rp.buildResolvePointer("gitCommitResult", { goal: GOAL }, { repo: "goal-host-vessel" });
    const d = gate()({ shape: "gitCommitResult", pointer, contract, goal: GOAL, upstream: [goalImpulse, bookkeeping] });
    expect(d.invoke).toBe(false);
    if (!d.invoke) {
      expect(d.reason).toContain("unbindable required input: message");
      expect(d.missing).toEqual(["message"]);
    }
  });

  it("an empty or whitespace value does not count as bound", () => {
    const contract: Contract = { shape: "gitCommitResult", known: true, fields: [{ name: "message", required: true, type: "string" }] };
    const pointer = rp.buildResolvePointer("gitCommitResult", {}, { message: "   " });
    const d = gate()({ shape: "gitCommitResult", pointer, contract, goal: GOAL, upstream: [] });
    expect(d.invoke).toBe(false);
  });

  it("an enveloped contract is judged inside its envelope (bound fields under the envelope are bound)", () => {
    const contract: Contract = { shape: "substrateGap_write", known: true, envelope: "gap", fields: [
      { name: "id", required: true, type: "string" },
      { name: "summary", required: true, type: "string" },
    ] };
    const pointer = rp.buildResolvePointer("substrateGap_write", { goal: GOAL }, { gap: { id: "g-1", summary: "a real summary" } });
    const before = structuredClone(pointer);
    const d = gate()({ shape: "substrateGap_write", pointer, contract, goal: GOAL, upstream: [] });
    expect(d.invoke).toBe(true);
    if (d.invoke) expect(d.pointer).toEqual(before);
  });

  it("an undeclared contract (known:false or unreadable) cannot be judged: the pointer is invoked unchanged", () => {
    const pointer = rp.buildResolvePointer("webSearchResult", { goal: GOAL }, { query: "x" });
    const before = structuredClone(pointer);
    for (const contract of [{ shape: "webSearchResult", known: false } as Contract, null]) {
      const d = gate()({ shape: "webSearchResult", pointer, contract, goal: GOAL, upstream: [] });
      expect(d.invoke).toBe(true);
      if (d.invoke) expect(d.pointer).toEqual(before);
    }
  });
});

describe("MUST-FAIL — an LLM-completion need with no prompt impulse carries a bound prompt on its FIRST invocation", () => {
  // Exactly the measured inputs: the goal plus bookkeeping, no prompt anywhere.
  const pointer = rp.buildResolvePointer("llm_completion_dispatch", { goal: GOAL, dispatch_id: DISPATCH, execution_receipt: bookkeeping.content }, {});

  it("the invocation carries a non-empty prompt that contains the goal text", () => {
    const d = gate()({ shape: "llm_completion_dispatch", pointer, contract: LLM_DISPATCH_CONTRACT, goal: GOAL, upstream: [goalImpulse, bookkeeping] });
    expect(d.invoke).toBe(true);
    if (d.invoke) {
      expect(typeof d.pointer.prompt).toBe("string");
      expect((d.pointer.prompt as string).trim().length).toBeGreaterThan(0);
      expect(d.pointer.prompt as string).toContain(GOAL);
      expect(d.pointer.type).toBe("llm_completion_dispatch"); // the shape is never re-routed
    }
  });

  it("bound upstream content is threaded into the prompt; bookkeeping is not", () => {
    const d = gate()({ shape: "llm_completion_dispatch", pointer, contract: LLM_DISPATCH_CONTRACT, goal: GOAL, upstream: [goalImpulse, bookkeeping, upstreamData] });
    expect(d.invoke).toBe(true);
    if (d.invoke) {
      expect(d.pointer.prompt as string).toContain(GOAL);
      expect(d.pointer.prompt as string).toContain("concept-db restarted 09:41 (OOM)");
      expect(d.pointer.prompt as string).not.toContain("exec-1");
    }
  });

  it("a whitespace-only prompt is unbound and is synthesized, not passed through", () => {
    const p2 = rp.buildResolvePointer("llm_completion_dispatch", { goal: GOAL }, { prompt: "  \n " });
    const d = gate()({ shape: "llm_completion_dispatch", pointer: p2, contract: LLM_DISPATCH_CONTRACT, goal: GOAL, upstream: [goalImpulse] });
    expect(d.invoke).toBe(true);
    if (d.invoke) expect(d.pointer.prompt as string).toContain(GOAL);
  });
});

describe("GENERALITY — the same contract with an invented shape and invented input names", () => {
  // If a fix special-cases "prompt" or "llm_completion", these fail.
  const SYN: Contract = {
    shape: "zq_orbit_digest",
    known: true,
    fields: [
      { name: "brief_for_reasoner", required: true, type: "string", synthesize_from: SYNTHESIZE_FROM_GOAL_AND_UPSTREAM },
      { name: "epoch_selector", required: true, type: "string" },
      { name: "verbosity", required: false, type: "number" },
    ],
  };

  it("a declared-synthesizable invented input is synthesized from the goal plus upstream content", () => {
    const pointer = rp.buildResolvePointer("zq_orbit_digest", { goal: GOAL }, { epoch_selector: "J2000" });
    const d = gate()({ shape: "zq_orbit_digest", pointer, contract: SYN, goal: GOAL, upstream: [goalImpulse, bookkeeping, upstreamData] });
    expect(d.invoke).toBe(true);
    if (d.invoke) {
      expect(d.pointer.brief_for_reasoner as string).toContain(GOAL);
      expect(d.pointer.brief_for_reasoner as string).toContain("goal-host restarted 09:58 (deploy)");
      expect(d.pointer.epoch_selector).toBe("J2000");
      expect("prompt" in d.pointer).toBe(false); // no stray prompt key
    }
  });

  it("an invented required input with no declared synthesis and no value is refused by name", () => {
    const pointer = rp.buildResolvePointer("zq_orbit_digest", { goal: GOAL }, {});
    const d = gate()({ shape: "zq_orbit_digest", pointer, contract: SYN, goal: GOAL, upstream: [goalImpulse] });
    expect(d.invoke).toBe(false);
    if (!d.invoke) {
      expect(d.reason).toContain("unbindable required input: epoch_selector");
      expect(d.missing).toEqual(["epoch_selector"]);
    }
  });

  it("a synthesizable input with nothing to synthesize from (no goal, no upstream content) is refused, not sent empty", () => {
    const pointer = rp.buildResolvePointer("zq_orbit_digest", {}, { epoch_selector: "J2000" });
    const d = gate()({ shape: "zq_orbit_digest", pointer, contract: SYN, goal: "", upstream: [bookkeeping] });
    expect(d.invoke).toBe(false);
    if (!d.invoke) expect(d.reason).toContain("unbindable required input: brief_for_reasoner");
  });

  it("the gate's source names no shape or field: no 'prompt' or 'llm_completion' literal in resolve-pointer.ts", () => {
    fnNamed(GATE_PATH, "bindRequiredInputs"); // presence
    // Every literal and every name in the module (comments are not code and are ignored).
    const named: string[] = [];
    walk(sourceOf(GATE_PATH), (n) => {
      if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) named.push(n.text);
      else if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) named.push(n.text);
    });
    expect(named.filter((t) => t === "prompt"), "no 'prompt' literal or name in the gate").toEqual([]);
    expect(named.filter((t) => /llm_?completion/i.test(t)), "no llm_completion literal or name in the gate").toEqual([]);
  });
});

describe("MUST-FAIL — wiring: every invocation site gates before its producer POST", () => {
  it("each of rawResolve, buildProxyResolver and buildDiscoveryProxyResolver calls bindRequiredInputs after buildResolvePointer and before the POST", () => {
    for (const name of SITES) {
      const fn = fnNamed(INDEX_PATH, name);
      const b = callsTo(fn, "buildResolvePointer")[0] ?? -1;
      const g = callsTo(fn, "bindRequiredInputs");
      const post = producerPost(fn);
      expect(g.length > 0, `${name} must call bindRequiredInputs`).toBe(true);
      expect(g.some((p) => p > b && p < post), `${name} must gate AFTER building the pointer and BEFORE the producer POST`).toBe(true);
    }
  });

  it("each site reads the contract at use time through requiredInputContract, which resolves resolver_schema", () => {
    for (const name of SITES) {
      const fn = fnNamed(INDEX_PATH, name);
      expect(callsTo(fn, "requiredInputContract").some((p) => p < producerPost(fn)), `${name} must read the contract via requiredInputContract before the POST`).toBe(true);
    }
    const reader = fnNamed(INDEX_PATH, "requiredInputContract");
    const literals: string[] = [];
    walk(reader, (n) => { if (ts.isStringLiteralLike(n)) literals.push(n.text); });
    expect(literals.includes("resolver_schema"), "requiredInputContract must resolve resolver_schema").toBe(true);
  });

  it("on refusal rawResolve records the reason via noteRawResolveFailure and returns null; the proxies throw it", () => {
    const isReason = (e: ts.Node | undefined): boolean => !!e && ts.isPropertyAccessExpression(e) && e.name.text === "reason";
    // rawResolve: an `if` between the gate and the POST whose branch records <x>.reason and returns null.
    const raw = fnNamed(INDEX_PATH, "rawResolve");
    const gate0 = callsTo(raw, "bindRequiredInputs")[0] ?? Number.MAX_SAFE_INTEGER;
    const post = producerPost(raw);
    let rawOk = false;
    walk(raw, (n) => {
      if (rawOk || !ts.isIfStatement(n) || n.getStart() < gate0 || n.getStart() > post) return;
      let records = false; let returnsNull = false;
      walk(n.thenStatement, (m) => {
        if (ts.isCallExpression(m) && calleeName(m) === "noteRawResolveFailure" && m.arguments.some((a) => isReason(a))) records = true;
        if (ts.isReturnStatement(m) && m.expression?.kind === ts.SyntaxKind.NullKeyword) returnsNull = true;
      });
      rawOk = records && returnsNull;
    });
    expect(rawOk, "rawResolve must record the refusal reason and return null before the POST").toBe(true);
    // proxies: `throw new Error(<x>.reason)` between the gate and the POST.
    for (const name of SITES.slice(1)) {
      const fn = fnNamed(INDEX_PATH, name);
      const g = callsTo(fn, "bindRequiredInputs")[0] ?? Number.MAX_SAFE_INTEGER;
      const p = producerPost(fn);
      let throws = false;
      walk(fn, (n) => {
        if (ts.isThrowStatement(n) && n.getStart() > g && n.getStart() < p && n.expression && ts.isNewExpression(n.expression)
          && calleeName(n.expression) === "Error" && isReason(n.expression.arguments?.[0])) throws = true;
      });
      expect(throws, `${name} must throw the refusal reason before the POST`).toBe(true);
    }
  });
});

describe("CONTRACT CONFORMANCE (green at base) — goal-host emits the malformed_request carrier in the fixture's format", () => {
  it("buildProxyResolver's structuredError throw has the fixture's skeleton, and its reason is failure_mode=<token>", () => {
    const fn = fnNamed(INDEX_PATH, "buildProxyResolver");
    const skeleton = (t: ts.TemplateExpression): string => t.head.text + t.templateSpans.map((sp) => "${}" + sp.literal.text).join("");
    const throws: string[] = []; const reasons: string[] = [];
    walk(fn, (n) => {
      if (ts.isThrowStatement(n) && n.expression && ts.isNewExpression(n.expression) && n.expression.arguments?.[0] && ts.isTemplateExpression(n.expression.arguments[0])) throws.push(skeleton(n.expression.arguments[0]));
      if (ts.isTemplateExpression(n) && n.head.text === "failure_mode=") reasons.push(skeleton(n));
    });
    const want = CARRIER_FORMAT.replace("<shape>", "${}").replace("failure_mode=<token>", "${}").replace("<detail>", "${}");
    expect(throws).toContain(want);
    expect(reasons).toContain("failure_mode=${}");
  });

  it("the fixture's formatter and parser round-trip", () => {
    const r = formatCarrier("llm_completion_dispatch", "malformed_request", "pointer must include a non-empty 'prompt' string");
    expect(r).toBe("dev-vessel llm_completion_dispatch resolver returned structuredError (failure_mode=malformed_request): pointer must include a non-empty 'prompt' string");
    expect(carrierToken(r)).toBe("malformed_request");
    expect(carrierToken("dev-vessel x resolver returned structuredError (status=500): boom")).toBeNull();
  });
});

/**
 * END TO END, FIRST INVOCATION. The real goal-host (src/index.ts, spawned as a child) against an
 * in-process mock fleet, harness as in verbatim-read-fresh-fleet.test.ts: discovery advertises
 * llm_completion_dispatch, the owning vessel answers resolver_schema with the contract pinned
 * above, and the "LLM" answers nothing parseable — so arg extraction cannot rescue the pointer.
 * An explanatory goal routes deterministically to llm_completion_dispatch (goal-target-inference's
 * prose route). The FIRST llm_completion_dispatch the walk POSTs must already carry a non-empty
 * prompt containing the goal: no refusal, no arg-correction round trip.
 */
const E2E_GOAL = "Explain why the sky looks blue during the day";
const E2E_SHAPES = ["llm_completion_dispatch", "resolver_schema", "memoryNote", "substrateGap"];
let mock: ReturnType<typeof Bun.serve> | null = null;
let host: ReturnType<typeof Bun.spawn> | null = null;
let hostPort = 0;
let stateDir = "";
const dispatchPointers: Array<Record<string, unknown>> = [];

describe("END TO END — the walk's first llm_completion_dispatch carries a bound prompt", () => {
  beforeAll(async () => {
    mock = Bun.serve({
      port: 0,
      async fetch(req) {
        const p = new URL(req.url).pathname;
        const body: any = req.method === "POST" ? await req.json().catch(() => null) : null;
        const me = `http://127.0.0.1:${mock!.port}`;
        if (p === "/health") return Response.json({ ok: true });
        if (p === "/registry/shapes") return Response.json({ shapes: E2E_SHAPES });
        if (p === "/registry/stats") return Response.json({ totalVessels: 1, totalShapes: E2E_SHAPES.length, healthyCount: 1 });
        if (p === "/resolve") {
          const t = body?.pointer?.type;
          const row = { id: "development-vessel", endpoint: me, resolve_endpoint: "/v2/impulses/resolve", shapes: E2E_SHAPES };
          if (t === "vesselRegistry") return Response.json({ content: { vessels: [row] } });
          if (t === "vesselCapability") return Response.json({ content: { vessels: E2E_SHAPES.includes(body?.pointer?.shape) ? [row] : [] } });
          return Response.json({ content: null });
        }
        if (p === "/v2/impulses/resolve") {
          const ptr = body?.impulse?.pointer ?? {};
          if (ptr.type === "resolver_schema") {
            if (ptr.shape === "llm_completion_dispatch") return Response.json({ success: true, shape: "resolver_schema", body: LLM_DISPATCH_CONTRACT });
            return Response.json({ success: true, shape: "resolver_schema", body: { shape: ptr.shape, known: false } });
          }
          if (ptr.type === "llm_completion_dispatch") {
            dispatchPointers.push(ptr);
            if (!(typeof ptr.prompt === "string" && ptr.prompt.trim())) {
              return Response.json({ success: true, shape: "structuredError", body: { resolver: "llm_completion_dispatch", failure_mode: "verifier_negative", detail: "body must include non-empty 'prompt' string" } });
            }
            return Response.json({ success: true, shape: "llmTextCompletion", body: { text: "Sunlight scatters off air molecules; shorter blue wavelengths scatter most (Rayleigh scattering), so the sky looks blue." } });
          }
          return Response.json({ error: `mock: no resolver for ${ptr.type}` }, { status: 404 });
        }
        if (p === "/v2/activities" && req.method === "GET") return Response.json([]);
        if (p.endsWith("/recommend")) return Response.json({ recommendations: [] });
        if (req.method === "GET") return Response.json({}, { status: 404 });
        return Response.json({ ok: true });
      },
    });
    const E = `http://127.0.0.1:${mock.port}`;
    stateDir = mkdtempSync(join(tmpdir(), "gh-required-inputs-"));
    hostPort = 20_000 + Math.floor(Math.random() * 20_000);
    host = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "index.ts")], {
      env: {
        PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
        PORT: String(hostPort), METABOB_API_KEY: "test-key", GOAL_HOST_VESSEL_API_KEY: "test-key",
        DISCOVERY_VESSEL_ENDPOINT: E, ACTIVITY_API_ENDPOINT: E, PRODUCER_DISCOVERY_ENDPOINT: E,
        DEVELOPMENT_VESSEL_ENDPOINT: E, EVENT_BUS_ENDPOINT: E, LLM_VESSEL_ENDPOINT: E,
        GOAL_HOST_DISABLE_SUBSCRIBERS: "1", GOAL_HOST_WS_SUBSCRIBER: "0", SUBSTRATE_STATE_DIR: stateDir,
        WORKSPACE_ROOT: stateDir,
        REACHED_CMD_CACHE_PATH: join(stateDir, "rc.json"), GOAL_FAILURE_MEMORY_PATH: join(stateDir, "fm.json"),
        REACH_VERDICT_SPOOL_PATH: join(stateDir, "spool"),
      },
      stdout: process.env.GH_TEST_LOG ? Bun.file(process.env.GH_TEST_LOG) : "ignore",
      stderr: process.env.GH_TEST_LOG ? Bun.file(process.env.GH_TEST_LOG) : "ignore",
    });
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(`http://127.0.0.1:${hostPort}/health`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* booting */ }
      await Bun.sleep(250);
    }
    throw new Error("goal-host did not come up");
  }, 60_000);

  afterAll(() => {
    host?.kill(); // the child this file spawned, by handle
    mock?.stop(true);
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  });

  it("the first llm_completion_dispatch POST carries a non-empty prompt containing the goal, and none is prompt-less", async () => {
    const r = await fetch(`http://127.0.0.1:${hostPort}/run-goal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "ApiKey test-key" },
      body: JSON.stringify({ goal: E2E_GOAL, tags: ["operator:test"] }),
    });
    const { dispatchId } = await r.json() as { dispatchId: string };
    expect(typeof dispatchId).toBe("string");
    for (let i = 0; i < 240; i++) {
      const rec: any = await (await fetch(`http://127.0.0.1:${hostPort}/executions/${dispatchId}`)).json().catch(() => null);
      if (rec && rec.status && rec.status !== "running") break;
      await Bun.sleep(250);
    }
    // Instrument guard: the walk did reach the producer (else this test proves nothing).
    expect(dispatchPointers.length, "the walk must have invoked llm_completion_dispatch at least once").toBeGreaterThan(0);
    const first = dispatchPointers[0]!;
    expect(typeof first.prompt === "string" && (first.prompt as string).trim().length > 0, `first invocation carried prompt=${JSON.stringify(first.prompt)}`).toBe(true);
    expect(String(first.prompt)).toContain(E2E_GOAL);
    // Not invoking is allowed (the walk may decline an unbindable producer and the floor may ask
    // instead); invoking WITHOUT the required input never is.
    const promptless = dispatchPointers.filter((p) => !(typeof p.prompt === "string" && (p.prompt as string).trim()));
    expect(promptless.length, `${promptless.length} of ${dispatchPointers.length} invocations carried no prompt`).toBe(0);
  }, 90_000);
});
