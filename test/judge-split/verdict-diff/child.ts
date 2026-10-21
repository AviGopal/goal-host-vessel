// VERDICT-DIFF CHILD — runs ONE scenario against ONE goal-host tree, hermetically, in its own process.
//
// Usage (spawned by runner.ts, never by hand unless debugging):
//   bun test/judge-split/verdict-diff/child.ts <tree-root> <scenario.json> <defaults.json> <out.json>
//
// WHY A PROCESS PER SCENARIO. src/index.ts holds ~40 module-level maps and caches (executionStore,
// goalFailureMemory, reachedCommandCache, inferredTarget*Cache, shapeEndpointMap, the oracle-abstain
// tally, the reach spool flag, ...). Re-importing a module does not reset them, so two scenarios in
// one process would leak state into each other. A fresh `bun` per scenario is the only isolation
// that holds on BOTH the base tree and the split tree without the harness knowing where each map
// lives. Import costs ~0.1 s, so this is cheap.
//
// WHAT IS STUBBED (everything that leaves the process or reads the clock):
//   - fetch: answered from the scenario's routes, then fleet-defaults.json; every call is recorded.
//   - Bun.spawn / Bun.spawnSync / node:child_process spawn*/exec*: answered from the scenario's
//     `spawn` rules (default: exit 128, empty output); every call is recorded (git landing probes).
//   - fs (node:fs, node:fs/promises, Bun.file, Bun.write): paths under /workspace and /vessels are
//     REDIRECTED into <WORKSPACE_ROOT>/__root/..., so a scenario can seed a dispatch store, a clone
//     or a compose report, and nothing outside the scratch dir is ever read or written.
//   - clock: Date / Date.now / performance.now are virtual. setTimeout is a virtual timer queue
//     that fires only when the process is idle (no microtasks, no in-flight stubbed I/O); each
//     fetch/spawn advances the clock by a fixed cost so `while (Date.now() < until)` loops end.
//     setInterval callbacks are recorded but NEVER fired: every module-level interval in
//     index.ts is maintenance (mem probe, gc tick, dispatch-store persist, expectation watchdog).
//   - Math.random: seeded (mulberry32). crypto.randomUUID: a counter.
//
// HOW index.ts IS IMPORTED. Its boot (Bun.serve, proxy registration, the WS subscriber and three
// top-level awaits) is inside `if (import.meta.main)`, which is false here. The remaining top-level
// await (reading /workspace/goal-host-dispatches.json, redirected) and the trace-store discovery
// await run under the stubs. A Bun loader plugin appends ONE line to the module text:
//   export { handleRunGoal as __vd_handleRunGoal, ... };
// The names it needs (NEEDED_NAMES below) are all composition-root names that stay in index.ts
// after the judge/walk split (as definitions or as imports), so the same line works on both trees.
// The source file on disk is never modified.

import * as nodeFs from "node:fs";
import { inspect } from "node:util";

const [TREE, SCENARIO_PATH, DEFAULTS_PATH, OUT_PATH] = process.argv.slice(2);
if (!TREE || !SCENARIO_PATH || !DEFAULTS_PATH || !OUT_PATH) {
  console.error("usage: child.ts <tree-root> <scenario.json> <defaults.json> <out.json>");
  process.exit(2);
}
const WS = process.env["WORKSPACE_ROOT"] ?? "";
if (!WS || !WS.startsWith("/")) { console.error("child.ts: WORKSPACE_ROOT must be an absolute scratch dir"); process.exit(2); }

// ── hermetic precondition ──────────────────────────────────────────────────────────────────────
// The redirect below covers /workspace and /vessels, but a host that HAS them could still leak
// through a path this harness does not intercept. Refuse rather than produce a non-hermetic golden.
for (const p of ["/workspace", "/vessels"]) {
  if (nodeFs.existsSync(p)) { console.error(`child.ts: NOT HERMETIC — ${p} exists on this host`); process.exit(3); }
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
/** The fixture credential the child presents on the requests it drives. The stubbed identity (fleet-defaults.json,
 *  route default:identity-caller-key) authenticates it as an ordinary key: read and write, no operator scope. A step's
 *  own headers override it (the operator-credential scenarios). */
const FIXTURE_CREDENTIAL = "ApiKey verdict-diff-caller-key";
const callerCredential = (): Record<string, string> => ({ Authorization: FIXTURE_CREDENTIAL });
interface Respond { status?: number; json?: Json; text?: string; llm?: string; throw?: string; headers?: Record<string, string> }
interface Route {
  id: string;
  method?: string;
  url?: string;           // substring of the full URL
  urlRegex?: string;
  type?: string;          // the request's impulse/pointer type (exact)
  caller?: string;        // the request's `caller` field, top level or in impulse.pointer (exact)
  body?: string[];        // every substring must be present in the request body
  bodyNot?: string[];     // none may be present
  times?: number;         // consume after N matches (default: unlimited)
  respond?: Respond;
  sequence?: Respond[];   // successive matches take successive entries; the last repeats
}
interface SpawnRule { id: string; argsInclude?: string[]; stdout?: string; stderr?: string; exitCode?: number; times?: number }
interface FleetVessel { id: string; endpoint: string; resolve_endpoint?: string; shapes: string[]; owned_repos?: string[]; protocol?: string }
interface Fleet { vessels?: FleetVessel[]; replace?: boolean }
interface Step { op: "runGoal" | "resolve" | "settle"; body?: Record<string, unknown>; headers?: Record<string, string>; label?: string; settleMs?: number }
interface Scenario {
  id: string;
  description?: string;
  covers?: string[];
  seed?: number;
  env?: Record<string, string>;
  files?: Record<string, string>;       // path (absolute /workspace/... or WS-relative) -> content
  routes?: Route[];
  spawn?: SpawnRule[];
  fleet?: Fleet;
  /** The oracle-label corpus, newest first, served for goal_verification_label reads (see labelAnswer). */
  labels?: Array<Record<string, unknown>>;
  steps: Step[];
  maxVirtualMs?: number;
}
const scenario = JSON.parse(nodeFs.readFileSync(SCENARIO_PATH, "utf8")) as Scenario;
const defaults = JSON.parse(nodeFs.readFileSync(DEFAULTS_PATH, "utf8")) as { routes: Route[]; spawn?: SpawnRule[]; fleet?: Fleet };
// The fleet: which vessel serves which shape. Discovery's three reads (vesselRegistry,
// vesselCapability <shape>, /registry/shapes) and dev-vessel's /shapes are answered from it, so a
// scenario states "who serves what" once instead of as a dozen routes. A scenario's vessels are
// added to the defaults' (same id replaces) unless the scenario sets fleet.replace.
const fleetVessels: FleetVessel[] = (() => {
  const base = scenario.fleet?.replace ? [] : (defaults.fleet?.vessels ?? []);
  const extra = scenario.fleet?.vessels ?? [];
  const ids = new Set(extra.map((v) => v.id));
  return [...base.filter((v) => !ids.has(v.id)), ...extra];
})();

// ── real primitives the harness itself keeps using ─────────────────────────────────────────────
const realSetImmediate = globalThis.setImmediate.bind(globalThis);
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const RealDate = Date;

// ── runaway guards (real time and memory, independent of the virtual clock) ────────────────────
// A scenario that loops without ever going idle would otherwise grow the request log without
// bound. Each guard writes a fatal output and exits, so the runner reports the scenario as failed.
const WALL_LIMIT_MS = Number(process.env["VD_CHILD_WALL_MS"] ?? 120_000);
const RSS_LIMIT = Number(process.env["VD_CHILD_RSS_MB"] ?? 2048) * 1024 * 1024;
const MAX_REQUESTS = 20_000;
function fatalExit(why: string): never {
  try { nodeFs.writeFileSync(OUT_PATH!, JSON.stringify({ scenario: SCENARIO_PATH, fatal: `runaway guard: ${why}` }, null, 2) + "\n"); } catch { /* ignore */ }
  process.exit(4);
}
realSetTimeout(() => fatalExit(`wall clock over ${WALL_LIMIT_MS} ms`), WALL_LIMIT_MS).unref();

// ── virtual clock ──────────────────────────────────────────────────────────────────────────────
const EPOCH = RealDate.UTC(2026, 9, 10, 12, 0, 0); // 2026-10-10T12:00:00Z, fixed
let now = EPOCH;
const FETCH_COST_MS = 5;
let activity = 0;       // bumps on anything that can wake code: timers, fetch, fs, spawn
let pendingIo = 0;      // in-flight real fs operations (their completion is not a microtask)

class VDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(now);
    else super(...(args as [string | number | Date]));
  }
  static override now(): number { return now; }
}
(globalThis as { Date: DateConstructor }).Date = VDate as unknown as DateConstructor;
const perf = globalThis.performance as { now: () => number };
perf.now = () => now - EPOCH;

interface VTimer { id: number; at: number; seq: number; cb: (...a: unknown[]) => void; args: unknown[]; interval: boolean; cleared: boolean }
const timers = new Map<number, VTimer>();
let timerSeq = 0;
let intervalsRegistered = 0;
function timerHandle(t: VTimer): unknown {
  const h = {
    id: t.id,
    unref() { return h; }, ref() { return h; }, hasRef() { return true; },
    refresh() { t.at = now; return h; },
    [Symbol.toPrimitive]() { return t.id; },
  };
  return h;
}
function idOf(h: unknown): number | undefined {
  if (typeof h === "number") return h;
  if (h && typeof h === "object" && "id" in h) return (h as { id: number }).id;
  return undefined;
}
(globalThis as Record<string, unknown>).setTimeout = ((cb: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
  const t: VTimer = { id: ++timerSeq, at: now + Math.max(0, Number(ms) || 0), seq: timerSeq, cb, args, interval: false, cleared: false };
  timers.set(t.id, t);
  activity++;
  return timerHandle(t);
}) as unknown;
(globalThis as Record<string, unknown>).clearTimeout = ((h: unknown) => {
  const id = idOf(h);
  if (id !== undefined) { const t = timers.get(id); if (t) { t.cleared = true; timers.delete(id); } }
}) as unknown;
(globalThis as Record<string, unknown>).setInterval = ((_cb: unknown, _ms?: number) => {
  // Recorded, never fired (see header). A handle is still returned for .unref()/clearInterval.
  intervalsRegistered++;
  const t: VTimer = { id: ++timerSeq, at: Number.POSITIVE_INFINITY, seq: timerSeq, cb: () => {}, args: [], interval: true, cleared: false };
  return timerHandle(t);
}) as unknown;
(globalThis as Record<string, unknown>).clearInterval = (() => {}) as unknown;
// Bun.sleep is a timer too.
(Bun as unknown as { sleep: (ms: number) => Promise<void> }).sleep = (ms: number) =>
  new Promise<void>((res) => { (globalThis.setTimeout as unknown as (cb: () => void, ms: number) => void)(res, ms); });

// ── seeded randomness and ids ──────────────────────────────────────────────────────────────────
let rngState = (scenario.seed ?? 0x5eed) >>> 0;
Math.random = () => {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
let uuidSeq = 0;
const vdUuid = (): string => {
  uuidSeq++;
  const hex = uuidSeq.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
};
try { Object.defineProperty(globalThis.crypto, "randomUUID", { value: vdUuid, configurable: true, writable: true }); } catch { /* fall through */ }
try { (require("node:crypto") as { randomUUID: () => string }).randomUUID = vdUuid; } catch { /* fall through */ }

// ── output accumulators ────────────────────────────────────────────────────────────────────────
interface ReqRec { seq: number; phase: string; kind: string; method: string; url: string; auth: boolean; headers: Record<string, string>; body: Json | string; route: string; status: number | string }
const requests: ReqRec[] = [];
const busEvents: string[] = [];
const spawns: Array<{ seq: number; phase: string; argv: string[]; rule: string; exitCode: number }> = [];
const logs: string[] = [];
let phase = "import";
let reqSeq = 0;

const scrub = (s: string): string => s.split(WS).join("<WS>");

// ── fs redirect ────────────────────────────────────────────────────────────────────────────────
const REDIRECT_ROOT = `${WS}/__root`;
const redirect = (p: unknown): unknown => {
  if (typeof p === "string" && (p === "/workspace" || p.startsWith("/workspace/") || p === "/vessels" || p.startsWith("/vessels/"))) return REDIRECT_ROOT + p;
  if (p instanceof URL && p.protocol === "file:") return redirect(p.pathname);
  return p;
};
const fsMod = require("node:fs") as Record<string, unknown>;
const fspMod = require("node:fs/promises") as Record<string, unknown>;
const SYNC_FNS = ["readFileSync", "writeFileSync", "appendFileSync", "existsSync", "statSync", "lstatSync", "readdirSync", "mkdirSync", "rmSync", "unlinkSync", "renameSync", "openSync", "accessSync", "realpathSync"];
for (const name of SYNC_FNS) {
  const orig = fsMod[name];
  if (typeof orig !== "function") continue;
  fsMod[name] = (...a: unknown[]) => {
    a[0] = redirect(a[0]);
    if (name === "renameSync") a[1] = redirect(a[1]);
    return (orig as (...x: unknown[]) => unknown)(...a);
  };
}
const ASYNC_FNS = ["readFile", "writeFile", "appendFile", "stat", "lstat", "readdir", "mkdir", "rm", "unlink", "rename", "access", "open", "realpath"];
for (const name of ASYNC_FNS) {
  const orig = fspMod[name];
  if (typeof orig !== "function") continue;
  fspMod[name] = async (...a: unknown[]) => {
    a[0] = redirect(a[0]);
    if (name === "rename") a[1] = redirect(a[1]);
    pendingIo++; activity++;
    try { return await (orig as (...x: unknown[]) => Promise<unknown>)(...a); }
    finally { pendingIo--; activity++; }
  };
}
const realBunFile = Bun.file.bind(Bun);
const realBunWrite = Bun.write.bind(Bun);
(Bun as unknown as { file: unknown }).file = ((p: unknown, o?: unknown) => {
  const f = realBunFile(redirect(p) as string, o as never);
  // Track the async reads so idle detection waits for them.
  const wrap = <K extends "text" | "json" | "exists" | "arrayBuffer">(k: K) => {
    const orig = (f as unknown as Record<string, () => Promise<unknown>>)[k]!.bind(f);
    (f as unknown as Record<string, unknown>)[k] = async () => { pendingIo++; activity++; try { return await orig(); } finally { pendingIo--; activity++; } };
  };
  try { wrap("text"); wrap("json"); wrap("exists"); wrap("arrayBuffer"); } catch { /* read-only on some versions */ }
  return f;
}) as unknown;
(Bun as unknown as { write: unknown }).write = (async (dest: unknown, data: unknown, ...rest: unknown[]) => {
  pendingIo++; activity++;
  try {
    const d = redirect(dest);
    if (typeof d === "string") { try { nodeFs.mkdirSync(d.slice(0, d.lastIndexOf("/")), { recursive: true }); } catch { /* best effort */ } }
    return await (realBunWrite as (...x: unknown[]) => Promise<number>)(d, data, ...rest);
  } finally { pendingIo--; activity++; }
}) as unknown;

// Seed scenario files.
for (const [p, content] of Object.entries(scenario.files ?? {})) {
  const real = p.startsWith("/") ? (redirect(p) as string) : `${WS}/${p}`;
  if (!real.startsWith(WS)) throw new Error(`scenario file outside the scratch dir: ${p}`);
  nodeFs.mkdirSync(real.slice(0, real.lastIndexOf("/")), { recursive: true });
  nodeFs.writeFileSync(real, content);
  // A fixed mtime (one minute before the virtual epoch): boot reconciliation compares a report's
  // lastModified with a record's startedAt, and a real mtime would make that comparison depend on
  // the day the harness runs.
  const fixed = new RealDate(EPOCH - 60_000);
  nodeFs.utimesSync(real, fixed, fixed);
}

// ── spawn stubs ────────────────────────────────────────────────────────────────────────────────
const spawnRules: SpawnRule[] = [...(scenario.spawn ?? []), ...(defaults.spawn ?? [])];
const spawnUses = new Map<string, number>();
// Spawn stdout may carry two templates: {{grep}} (the value of a --grep= argument, so a landing
// probe's commit carries the Gap: trailer it greps for) and {{now_s}} (virtual epoch seconds, so the
// commit is newer than the dispatch start).
function expand(t: string, argv: string[]): string {
  const grep = argv.find((a) => a.startsWith("--grep="))?.slice("--grep=".length) ?? "";
  return t.split("{{grep}}").join(grep).split("{{now_s}}").join(String(Math.floor(now / 1000)));
}
function pickSpawn(argv: string[]): { rule: string; stdout: string; stderr: string; exitCode: number } {
  const joined = argv.join(" ");
  for (const r of spawnRules) {
    if (r.argsInclude && !r.argsInclude.every((s) => joined.includes(s))) continue;
    const used = spawnUses.get(r.id) ?? 0;
    if (r.times !== undefined && used >= r.times) continue;
    spawnUses.set(r.id, used + 1);
    return { rule: r.id, stdout: expand(r.stdout ?? "", argv), stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
  }
  return { rule: "unmatched", stdout: "", stderr: "verdict-diff: no spawn stub", exitCode: 128 };
}
function recordSpawn(argv: string[]): { stdout: string; stderr: string; exitCode: number } {
  now += FETCH_COST_MS; activity++;
  const r = pickSpawn(argv);
  spawns.push({ seq: ++reqSeq, phase, argv: argv.map(scrub), rule: r.rule, exitCode: r.exitCode });
  return r;
}
const streamOf = (s: string): ReadableStream<Uint8Array> => new ReadableStream({ start(c) { if (s) c.enqueue(new TextEncoder().encode(s)); c.close(); } });
(Bun as unknown as { spawn: unknown }).spawn = ((cmdOrOpts: unknown, maybeOpts?: unknown) => {
  const argv = Array.isArray(cmdOrOpts) ? (cmdOrOpts as string[]) : ((cmdOrOpts as { cmd?: string[] })?.cmd ?? []);
  void maybeOpts;
  const r = recordSpawn(argv.map(String));
  return {
    pid: 4242, stdout: streamOf(r.stdout), stderr: streamOf(r.stderr), stdin: undefined,
    exited: Promise.resolve(r.exitCode), exitCode: r.exitCode, signalCode: null, killed: false,
    kill() {}, ref() {}, unref() {},
  };
}) as unknown;
(Bun as unknown as { spawnSync: unknown }).spawnSync = ((cmdOrOpts: unknown) => {
  const argv = Array.isArray(cmdOrOpts) ? (cmdOrOpts as string[]) : ((cmdOrOpts as { cmd?: string[] })?.cmd ?? []);
  const r = recordSpawn(argv.map(String));
  return { stdout: Buffer.from(r.stdout), stderr: Buffer.from(r.stderr), exitCode: r.exitCode, success: r.exitCode === 0, pid: 4242 };
}) as unknown;
const cp = require("node:child_process") as Record<string, unknown>;
cp["spawnSync"] = (cmd: string, args?: string[], opts?: { encoding?: string }) => {
  const r = recordSpawn([cmd, ...(args ?? [])].map(String));
  const enc = opts?.encoding;
  return { status: r.exitCode, signal: null, pid: 4242, output: [null, r.stdout, r.stderr], stdout: enc ? r.stdout : Buffer.from(r.stdout), stderr: enc ? r.stderr : Buffer.from(r.stderr) };
};
cp["execSync"] = (cmd: string) => {
  const r = recordSpawn(["sh", "-c", String(cmd)]);
  if (r.exitCode !== 0) { const e = new Error(`Command failed: ${cmd}`) as Error & { status: number }; e.status = r.exitCode; throw e; }
  return Buffer.from(r.stdout);
};
cp["execFileSync"] = (file: string, args?: string[]) => {
  const r = recordSpawn([file, ...(args ?? [])].map(String));
  if (r.exitCode !== 0) { const e = new Error(`Command failed: ${file}`) as Error & { status: number }; e.status = r.exitCode; throw e; }
  return Buffer.from(r.stdout);
};
for (const name of ["spawn", "exec", "execFile", "fork"]) {
  cp[name] = (...a: unknown[]) => { recordSpawn([String(a[0]), ...(Array.isArray(a[1]) ? (a[1] as string[]) : [])].map(String)); throw new Error(`verdict-diff: child_process.${name} is not stubbed`); };
}

// ── fetch stub ─────────────────────────────────────────────────────────────────────────────────
const allRoutes: Route[] = [...(scenario.routes ?? []), ...defaults.routes];
const routeUses = new Map<string, number>();
// A SINK is a write whose content or trigger can be a verdict or credit (DESIGN §1 sink rule), or
// any *_write / compose / escalation request. Everything else is a read. Classification is only a
// label for readability: the golden records EVERY request in order, whatever its kind.
const SINK_PATH = /\/execution-traces(\/reach)?$|\/feedback$|\/v2\/goal-paths$|\/templates(\/[^/]+)?$|\/v2\/activities$/;
const SINK_TYPE = /_write$|^feature_compose$|^patch_with_tools$|^obsidian:write_note$/;

function canonical(v: unknown): Json {
  if (v === null || typeof v !== "object") return (typeof v === "string" ? scrub(v) : (v as Json)) ?? null;
  if (Array.isArray(v)) return v.map(canonical);
  const out: Record<string, Json> = {};
  for (const k of Object.keys(v as object).sort()) out[k] = canonical((v as Record<string, unknown>)[k]);
  return out;
}
function bodyText(b: unknown): string {
  if (b === undefined || b === null) return "";
  if (typeof b === "string") return b;
  if (b instanceof URLSearchParams) return b.toString();
  if (b instanceof Uint8Array || b instanceof ArrayBuffer) return new TextDecoder().decode(b as Uint8Array);
  return String(b);
}
function typeOf(parsed: unknown): string {
  const p = parsed as Record<string, any> | null;
  return String(p?.impulse?.pointer?.type ?? p?.impulse?.type ?? p?.pointer?.type ?? p?.type ?? "");
}
function classify(method: string, url: string, parsed: unknown): string {
  if (/\/v2\/events\/publish\b/.test(url)) return "bus";
  if (url.startsWith(String(process.env["LLM_VESSEL_ENDPOINT"] ?? "\u0000"))) return "llm";
  if (method === "GET") return "read";
  const t = typeOf(parsed);
  if (t === "llm_completion") return "llm";
  let path = url;
  try { path = new URL(url).pathname; } catch { /* keep the raw url */ }
  if (SINK_TYPE.test(t) || SINK_PATH.test(path)) return "sink";
  return "read";
}
function callerOf(parsed: unknown): string {
  const p = parsed as Record<string, any> | null;
  return String(p?.caller ?? p?.impulse?.pointer?.caller ?? p?.pointer?.caller ?? "");
}
function matchRoute(method: string, url: string, body: string, parsed: unknown, from: number, to: number): Route | undefined {
  for (const r of allRoutes.slice(from, to)) {
    if (r.method && r.method !== method) continue;
    if (r.type !== undefined && typeOf(parsed) !== r.type) continue;
    if (r.caller !== undefined && callerOf(parsed) !== r.caller) continue;
    if (r.url && !url.includes(r.url)) continue;
    if (r.urlRegex && !new RegExp(r.urlRegex).test(url)) continue;
    if (r.body && !r.body.every((s) => body.includes(s))) continue;
    if (r.bodyNot && r.bodyNot.some((s) => body.includes(s))) continue;
    const used = routeUses.get(r.id) ?? 0;
    if (r.times !== undefined && used >= r.times) continue;
    routeUses.set(r.id, used + 1);
    return r;
  }
  return undefined;
}
function fleetAnswer(method: string, url: string, parsed: unknown): { id: string; respond: Respond } | undefined {
  const disc = String(process.env["DISCOVERY_VESSEL_ENDPOINT"] ?? "");
  const dev = String(process.env["DEVELOPMENT_VESSEL_ENDPOINT"] ?? "");
  const row = (v: FleetVessel) => ({ id: v.id, vesselId: v.id, endpoint: v.endpoint, resolve_endpoint: v.resolve_endpoint ?? "/v2/impulses/resolve", shapes: v.shapes, protocol: v.protocol ?? "http", ...(v.owned_repos ? { owned_repos: v.owned_repos } : {}) });
  if (method === "GET" && url === `${disc}/registry/shapes`) {
    return { id: "fleet:registry-shapes", respond: { json: { shapes: [...new Set(fleetVessels.flatMap((v) => v.shapes))].sort() } } };
  }
  if (method === "GET" && url === `${dev}/shapes`) {
    const d = fleetVessels.find((v) => v.endpoint === dev);
    return { id: "fleet:dev-shapes", respond: d ? { json: { shapes: d.shapes } } : { status: 404, json: { error: "no dev-vessel" } } };
  }
  if (method === "POST" && url === `${disc}/resolve`) {
    const ptr = ((parsed as Record<string, any> | null)?.pointer ?? (parsed as Record<string, any> | null)?.impulse?.pointer ?? {}) as Record<string, unknown>;
    if (ptr["type"] === "vesselRegistry") return { id: "fleet:vesselRegistry", respond: { json: { content: { vessels: fleetVessels.map(row) } } } };
    if (ptr["type"] === "vesselCapability") {
      const shape = String(ptr["shape"] ?? "");
      return { id: "fleet:vesselCapability", respond: { json: { content: { vessels: fleetVessels.filter((v) => v.shapes.includes(shape)).map(row) } } } };
    }
  }
  return undefined;
}
// The oracle-label corpus, answered with activity-api's read semantics (newest first, rows whose
// purpose equals exclude_purpose dropped, then `limit`), so a scenario states the corpus once and
// stays valid whatever limit or exclusion the consumer under test asks for.
function labelAnswer(method: string, parsed: unknown): { id: string; respond: Respond } | undefined {
  if (method !== "POST" || !scenario.labels) return undefined;
  const ptr = ((parsed as Record<string, any> | null)?.pointer ?? (parsed as Record<string, any> | null)?.impulse?.pointer ?? {}) as Record<string, unknown>;
  if (ptr["type"] !== "goal_verification_label") return undefined;
  const ex = typeof ptr["exclude_purpose"] === "string" ? ptr["exclude_purpose"] : null;
  const lim = typeof ptr["limit"] === "number" ? ptr["limit"] : scenario.labels.length;
  const rows = scenario.labels.filter((r) => !ex || r["purpose"] !== ex).slice(0, lim);
  return { id: "labels:corpus", respond: { json: { content: JSON.stringify(rows) } } };
}
function makeResponse(spec: Respond): Response {
  if (spec.throw) throw new TypeError(spec.throw);
  let text: string;
  if (spec.llm !== undefined) text = JSON.stringify({ content: { body: { content: spec.llm } }, body: { content: spec.llm } });
  else if (spec.json !== undefined) text = JSON.stringify(spec.json);
  else text = spec.text ?? "";
  const status = spec.status ?? 200;
  const res = new Response(status === 204 ? null : text, { status, headers: { "Content-Type": "application/json", ...(spec.headers ?? {}) } });
  // Body reads resolve as microtasks, so idle detection never races a stubbed body.
  Object.defineProperty(res, "text", { value: async () => text });
  Object.defineProperty(res, "json", { value: async () => JSON.parse(text) });
  return res;
}
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  now += FETCH_COST_MS; activity++;
  let url: string; let method: string; let raw: string; let headers: Headers;
  if (input instanceof Request) {
    url = input.url; method = (init?.method ?? input.method ?? "GET").toUpperCase();
    raw = init?.body !== undefined ? bodyText(init.body) : await input.clone().text();
    headers = new Headers(init?.headers ?? input.headers);
  } else {
    url = String(input); method = (init?.method ?? "GET").toUpperCase();
    raw = bodyText(init?.body); headers = new Headers(init?.headers ?? {});
  }
  let parsed: unknown = raw;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
  const kind = classify(method, url, parsed);
  // Order: the scenario's own routes, then the fleet, then fleet-defaults.json routes.
  const nScenario = scenario.routes?.length ?? 0;
  let route = matchRoute(method, url, raw, parsed, 0, nScenario);
  const fleet = route ? undefined : (fleetAnswer(method, url, parsed) ?? labelAnswer(method, parsed));
  if (!route && !fleet) route = matchRoute(method, url, raw, parsed, nScenario, allRoutes.length);
  let spec: Respond = fleet ? fleet.respond : { status: 404, json: { error: "verdict-diff: not served" } };
  if (route) {
    if (route.sequence && route.sequence.length > 0) {
      const used = (routeUses.get(route.id) ?? 1) - 1;
      spec = route.sequence[Math.min(used, route.sequence.length - 1)]!;
    } else if (route.respond) spec = route.respond;
  }
  if (requests.length >= MAX_REQUESTS) fatalExit(`more than ${MAX_REQUESTS} requests`);
  if (kind === "bus") {
    busEvents.push(String((parsed as Record<string, unknown> | null)?.["type"] ?? "?"));
  } else {
    // LLM prompts are long and repeat the goal many times; the golden keeps their caller, length and
    // a sha256 of the canonical body, which is just as byte-sensitive. VD_FULL_BODIES=1 keeps them
    // whole (for localizing a diff by hand).
    const canon = typeof parsed === "string" ? scrub(parsed) : canonical(parsed);
    const canonText = JSON.stringify(canon);
    const body: Json | string = kind === "llm" && process.env["VD_FULL_BODIES"] !== "1"
      ? { caller: callerOf(parsed) || null, type: typeOf(parsed) || null, chars: canonText.length, sha256: new Bun.CryptoHasher("sha256").update(canonText).digest("hex") }
      : canon;
    // Headers other than Content-Type and Authorization are recorded by value (hop and credential
    // forwarding headers are gate inputs); Authorization only by presence.
    const hdrs: Record<string, string> = {};
    headers.forEach((v, k) => { if (k !== "content-type" && k !== "authorization") hdrs[k] = scrub(v); });
    requests.push({
      seq: ++reqSeq, phase, kind, method, url: scrub(url),
      auth: headers.has("authorization"),
      headers: canonical(hdrs) as Record<string, string>,
      body,
      route: route?.id ?? fleet?.id ?? "unmatched",
      status: spec.throw ? `throw:${spec.throw}` : (spec.status ?? 200),
    });
  }
  await Promise.resolve();
  activity++;
  return makeResponse(spec);
}) as typeof fetch;

// ── console capture ────────────────────────────────────────────────────────────────────────────
// Stack frames carry absolute paths and line numbers of the tree under test, which differ between
// the base and the split tree by construction; they are dropped from every captured log line.
const fmt = (a: unknown[]): string => a.map((x) => (typeof x === "string" ? x : inspect(x, { depth: 4, breakLength: Infinity })))
  .join(" ").split("\n").filter((l) => !/^\s+at\s/.test(l)).join("\n");
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  (console as unknown as Record<string, unknown>)[level] = (...a: unknown[]) => { logs.push(`[${level}] ${scrub(fmt(a))}`); };
}

// ── idle detection and the timer driver ────────────────────────────────────────────────────────
const IDLE_TURNS = 6;
let idleTurns = 0;
async function idle(): Promise<void> {
  let quiet = 0; let last = activity;
  while (quiet < IDLE_TURNS) {
    await new Promise<void>((r) => realSetImmediate(r));
    if (++idleTurns % 2000 === 0 && process.memoryUsage().rss > RSS_LIMIT) fatalExit(`rss over ${RSS_LIMIT} bytes`);
    if (pendingIo > 0 || activity !== last) { quiet = 0; last = activity; } else quiet++;
  }
}
const MAX_VIRTUAL_MS = scenario.maxVirtualMs ?? 6 * 3600_000;
const MAX_FIRES = 50_000;
let fires = 0;
let aborted: string | null = null;
function nextTimer(): VTimer | undefined {
  let best: VTimer | undefined;
  for (const t of timers.values()) if (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq)) best = t;
  return best;
}
async function fireOne(limitAt: number): Promise<boolean> {
  const t = nextTimer();
  if (!t || t.at > limitAt) return false;
  timers.delete(t.id);
  if (t.at > now) now = t.at;
  fires++; activity++;
  try { t.cb(...t.args); } catch (e) { logs.push(`[timer-error] ${scrub(String((e as Error)?.message ?? e))}`); }
  return true;
}
/** Run until `done()` holds at an idle point, firing virtual timers in (at, seq) order. */
async function driveUntil(done: () => boolean, label: string): Promise<string> {
  for (;;) {
    await idle();
    if (done()) return "done";
    if (now - EPOCH > MAX_VIRTUAL_MS) { aborted = `${label}: virtual time exceeded`; return "virtual-time-exceeded"; }
    if (fires > MAX_FIRES) { aborted = `${label}: timer fire cap`; return "fire-cap"; }
    if (!(await fireOne(Number.POSITIVE_INFINITY))) return "stalled";
  }
}
/** After a step terminates, let its tail (fire-and-forget sinks, short retries) run out. */
async function settle(ms: number): Promise<void> {
  const until = now + ms;
  for (;;) {
    await idle();
    if (!(await fireOne(until))) return;
  }
}
function drivePromise<T>(p: Promise<T>, label: string): Promise<{ value?: T; error?: string; drive: string }> {
  let state: { value?: T; error?: string } | null = null;
  p.then((v) => { state = { value: v }; }, (e) => { state = { error: String((e as Error)?.message ?? e) }; });
  return driveUntil(() => state !== null, label).then((drive) => ({ ...(state ?? {}), drive }));
}

// ── import the tree ────────────────────────────────────────────────────────────────────────────
const NEEDED_NAMES = ["handleRunGoal", "handleResolve", "executionStore", "registerBuiltinResolvers", "registerDevVesselProxies", "registerDiscoveryProxies"];
const INDEX_PATH = `${TREE.replace(/\/+$/, "")}/src/index.ts`;
const escaped = INDEX_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
Bun.plugin({
  name: "verdict-diff-exports",
  setup(build) {
    build.onLoad({ filter: new RegExp(`^${escaped}$`) }, (args) => {
      const text = nodeFs.readFileSync(args.path, "utf8");
      return { contents: `${text}\nexport { ${NEEDED_NAMES.map((n) => `${n} as __vd_${n}`).join(", ")} };\n`, loader: "ts" };
    });
  },
});

type Mod = {
  __vd_handleRunGoal: (r: Request) => Promise<Response>;
  __vd_handleResolve: (r: Request) => Promise<Response>;
  __vd_executionStore: Map<string, Record<string, unknown>>;
  __vd_registerBuiltinResolvers: () => void;
  __vd_registerDevVesselProxies: () => Promise<unknown>;
  __vd_registerDiscoveryProxies: () => Promise<unknown>;
};

const RECORD_FIELDS = ["status", "reached", "goalReachReason", "selectedTemplateId", "executionId", "completionShapes", "attempts", "attemptCount", "executionPath", "abstain", "learning", "answerBody", "humanGraded", "humanReachNotes", "error", "trigger", "stage", "grounded", "inferenceConfidence", "requeueOf", "routeArounds"];
const MARKERS: Array<[string, RegExp]> = [
  ["edit-intent", /EDIT-INTENT|edit-intent|FAVORABLE|UNFAVORABLE|feature_compose/],
  ["landed", /LANDED|landed-probe|landed probe|LATCH/i],
  ["hollow", /HOLLOW/],
  ["beta-withheld", /β WITHHELD|beta_withheld|β withheld/i],
  ["abstain", /ABSTAIN|abstain:/],
  ["floor", /FABRICATED TOOL TRANSCRIPT|universal[- ]tool[- ]fallback|\bfloor\b/i],
  ["route-around", /ROUTE-AROUND|route-around|routeAround/i],
  ["reframe", /re-?fram/i],
  ["failure-recall", /FAILURE MEMORY|failure memory|prior verdict|PRIOR FAILURE|recalled \d+ prior/i],
  ["oracle-label", /\[oracle-label\]/],
  ["no-pick", /no producer|NO-PICK|no pick|no candidate/i],
  ["refused", /REFUS/],
  ["reached", /REACHED|reached:true|NOT REACHED/],
  ["mint", /\bmint/i],
  ["credit", /alpha-credit|α-credit|credit/i],
];

function snapshot(rec: Record<string, unknown> | undefined): Record<string, Json> {
  if (!rec) return { missing: true };
  const out: Record<string, unknown> = {};
  for (const k of RECORD_FIELDS) if (rec[k] !== undefined) out[k] = rec[k];
  return canonical(out) as Record<string, Json>;
}
function reasonClass(reason: unknown): string | null {
  const m = /^(?:\[human override:[^\]]*\]\s*)?((?:deterministic|abstain|floor|hollow)[:\w.-]*)/i.exec(String(reason ?? ""));
  return m ? m[1]!.replace(/[\s—].*$/, "") : null;
}

async function main(): Promise<void> {
  const mod = (await drivePromise(import(INDEX_PATH) as Promise<Mod>, "import")).value;
  if (!mod) throw new Error("index.ts import did not settle");
  // THE VERDICT-CORPUS STATUS FIXTURE. The golden records walk and judge behaviour from BEFORE any credit hold
  // existed, and this harness is a move-equivalence tool, so it compares like with like: the tree's credit hold
  // (the same module instance index.ts imported) is given a fresh runner status that holds nothing
  // (deterministic: a fixed run_at and a period no virtual run outlives), through its own test seam, whatever the
  // tree reads its status from (a file or the pool). The hold's own behaviour (fail-closed with no status, holds
  // from red cases) is pinned by test/verdict-corpus/, not by this golden. A tree without the module is unchanged.
  const CREDIT_HOLD_PATH = `${TREE.replace(/\/+$/, "")}/src/judge/credit-hold.ts`;
  if (nodeFs.existsSync(CREDIT_HOLD_PATH)) {
    const ch = (await import(CREDIT_HOLD_PATH)) as { configureCreditHold?: (o: { reader?: () => Record<string, unknown> | null }) => void };
    const FRESH_EMPTY_STATUS = {
      schema: 1, node: "verdict-diff", judge_sha: "", deployed_sha: null, corpus: { n: 0, link: "0".repeat(64) }, fidelity: {},
      run_at: "2026-01-01T00:00:00.000Z", period_s: 3_153_600_000, ever_green: "absent (fail closed)", state: "ok",
      green: [], flips: [], known_red: [], entry_missing: [], holds: [], live_shadow: { sampled: 0, mismatched: 0 },
    };
    if (typeof ch.configureCreditHold !== "function") throw new Error("src/judge/credit-hold.ts exposes no configureCreditHold: the status fixture cannot be applied");
    ch.configureCreditHold({ reader: () => FRESH_EMPTY_STATUS });
  }
  for (const n of NEEDED_NAMES) if (!(`__vd_${n}` in mod)) throw new Error(`index.ts does not expose ${n}`);
  const store = mod.__vd_executionStore;

  phase = "boot";
  mod.__vd_registerBuiltinResolvers();
  await drivePromise(mod.__vd_registerDevVesselProxies(), "boot:dev-vessel-proxies");
  await drivePromise(mod.__vd_registerDiscoveryProxies(), "boot:discovery-proxies");
  await settle(1_000);

  const stepsOut: Array<Record<string, Json>> = [];
  let lastDispatch: string | undefined;
  let logCursor = logs.length;
  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i]!;
    phase = `step${i + 1}:${step.op}${step.label ? `:${step.label}` : ""}`;
    const reqStart = requests.length;
    const entry: Record<string, unknown> = { step: i + 1, op: step.op, label: step.label ?? null };
    if (step.op === "runGoal") {
      const req = new Request("http://goal-host.test.invalid/run-goal", { method: "POST", headers: { "Content-Type": "application/json", ...callerCredential(), ...(step.headers ?? {}) }, body: JSON.stringify(step.body ?? {}) });
      const r = await drivePromise(mod.__vd_handleRunGoal(req), phase);
      const res = r.value;
      const json = res ? await res.json().catch(() => null) : null;
      entry["http"] = { status: res?.status ?? null, body: json, error: r.error ?? null };
      const did = (json as { dispatchId?: string } | null)?.dispatchId;
      if (did && res?.status === 202) {
        lastDispatch = did;
        entry["drive"] = await driveUntil(() => (store.get(did)?.["status"] ?? "running") !== "running", phase);
        await settle(step.settleMs ?? 600_000);
        const rec = store.get(did);
        entry["record"] = snapshot(rec);
        entry["walkLog"] = (Array.isArray(rec?.["walkLog"]) ? (rec!["walkLog"] as unknown[]) : []).map((l) => scrub(String(l)));
      } else entry["drive"] = r.drive;
    } else if (step.op === "resolve") {
      const body = JSON.parse(JSON.stringify(step.body ?? {}).split("$last").join(lastDispatch ?? ""));
      if (typeof body["dispatchId"] === "string" && body["dispatchId"]) lastDispatch = body["dispatchId"] as string;
      const req = new Request("http://goal-host.test.invalid/resolve", { method: "POST", headers: { "Content-Type": "application/json", ...callerCredential() }, body: JSON.stringify(body) });
      const r = await drivePromise(mod.__vd_handleResolve(req), phase);
      await settle(step.settleMs ?? 60_000);
      const json = r.value ? await r.value.json().catch(() => null) : null;
      const b = (json as { body?: Record<string, unknown> } | null)?.body;
      entry["http"] = { status: r.value?.status ?? null, error: r.error ?? null, reached: (b?.["reached"] as Json) ?? null, humanGraded: (b?.["humanGraded"] as Json) ?? null, goalReachReason: (b?.["goalReachReason"] as Json) ?? null };
      entry["drive"] = r.drive;
      if (lastDispatch) entry["record"] = snapshot(store.get(lastDispatch));
    } else if (step.op === "settle") {
      await settle(step.settleMs ?? 60_000);
    }
    const stepReqs = requests.slice(reqStart);
    const reach = stepReqs.filter((q) => /\/reach\b/.test(q.url) && q.method === "POST").map((q) => q.body);
    const rec = (entry["record"] ?? {}) as Record<string, Json>;
    // Markers come from the captured console only: every walk-log line is also tapped to the console,
    // so reading both would list each decision twice.
    const stepLogs = logs.slice(logCursor);
    logCursor = logs.length;
    entry["verdict"] = {
      reached: rec["reached"] ?? null,
      status: rec["status"] ?? null,
      reasonClass: reasonClass(rec["goalReachReason"]),
      reachDeliveries: reach as Json,
      betaWithheld: reach.filter((b) => (b as Record<string, Json> | null)?.["beta_withheld"] === true).map((b) => (b as Record<string, Json>)["execution_id"] ?? null),
      sinks: stepReqs.filter((q) => q.kind === "sink").map((q) => `${q.method} ${q.url.replace(/^https?:\/\/[^/]+/, "")} ${typeOf(q.body)}`.trim()),
    };
    entry["markers"] = stepLogs.flatMap((l) => {
      const hits = MARKERS.filter(([, re]) => re.test(l)).map(([n]) => n);
      return hits.length ? [`${hits.join(",")} :: ${l.slice(0, 240)}`] : [];
    });
    stepsOut.push(canonical(entry) as Record<string, Json>);
  }

  const out = canonical({
    scenario: scenario.id,
    covers: scenario.covers ?? [],
    steps: stepsOut,
    requests,
    spawns,
    busEvents: { count: busEvents.length, types: [...new Set(busEvents)].sort() },
    intervalsRegistered,
    harness: { aborted, virtualMsElapsed: now - EPOCH, timerFires: fires, pendingTimers: timers.size },
  });
  const logsOut = { scenario: scenario.id, logs };
  nodeFs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n");
  nodeFs.writeFileSync(OUT_PATH.replace(/\.json$/, ".log.json"), JSON.stringify(logsOut, null, 2) + "\n");
}

main().then(() => process.exit(0), (e) => {
  try { nodeFs.writeFileSync(OUT_PATH, JSON.stringify({ scenario: scenario.id, fatal: scrub(String((e as Error)?.stack ?? e)), logs: logs.slice(-50) }, null, 2) + "\n"); } catch { /* ignore */ }
  process.exit(1);
});
