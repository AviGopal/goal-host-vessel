// VERDICT-DIFF RUNNER — spawns one hermetic child per scenario (child.ts) against a goal-host tree
// and collects the canonical outputs. Used by run.ts (golden generation, tree-vs-tree diff) and by
// test/judge-split/verdict-diff.check.ts (tree vs committed golden).
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const HARNESS_DIR = import.meta.dir;
export const SCENARIO_DIR = join(HARNESS_DIR, "scenarios");
export const GOLDEN_DIR = join(HARNESS_DIR, "golden");
export const DEFAULTS_PATH = join(HARNESS_DIR, "fleet-defaults.json");
export const ENVIRONMENT_PATH = join(HARNESS_DIR, "golden-environment.json");

/**
 * What the golden depends on besides goal-host's own source: the executor library (its engine runs
 * pinned templates, its trace sink builds the execution-trace bodies, its adapter sends recommend)
 * and the runtime. The build hash is recorded; the byte comparison is pinned to the executor
 * version; a different build of the same version warns and is still compared (see verdict-diff.check.ts).
 */
export function environmentOf(tree: string): { bun: string; ias_executor_version: string | null; ias_executor_dist_sha256: string | null } {
  const pkgDir = join(tree, "node_modules", "@avigopal", "ias-executor-ts");
  let version: string | null = null;
  let digest: string | null = null;
  try {
    version = String((JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version?: string }).version ?? null);
    const root = realpathSync(join(pkgDir, "dist"));
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d).sort()) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".js") || p.endsWith(".json")) files.push(p);
      }
    };
    walk(root);
    const h = new Bun.CryptoHasher("sha256");
    for (const f of files) { h.update(f.slice(root.length)); h.update("\0"); h.update(readFileSync(f)); h.update("\0"); }
    digest = h.digest("hex");
  } catch { /* unreadable: reported as null */ }
  return { bun: Bun.version, ias_executor_version: version, ias_executor_dist_sha256: digest };
}

/** Fixed child environment: an allowlist, never inherited (bun test sets its own variables). */
export function childEnv(ws: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: ws,
    TZ: "UTC",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    WORKSPACE_ROOT: ws,
    // Every endpoint is a non-resolvable test host; the fetch stub answers them all.
    ACTIVITY_API_ENDPOINT: "http://activity-api.test.invalid",
    PRODUCER_DISCOVERY_ENDPOINT: "http://activity-api.test.invalid",
    EVENT_BUS_ENDPOINT: "http://activity-api.test.invalid",
    DISCOVERY_VESSEL_ENDPOINT: "http://discovery.test.invalid",
    DEVELOPMENT_VESSEL_ENDPOINT: "http://dev-vessel.test.invalid",
    LLM_VESSEL_ENDPOINT: "http://llm.test.invalid",
    LLM_ROUTER_API_ENDPOINT: "http://activity-api.test.invalid",
    // One LLM endpoint, no Thompson routing over arms: the router lives in llm-router.ts and is
    // the same on both trees; disabling it keeps every LLM call a single recorded request.
    LLM_ROUTER_DISABLED: "1",
    GOAL_HOST_VESSEL_API_KEY: "verdict-diff-key",
    // THE INBOUND DOOR (src/inbound-auth.ts) authenticates /run-goal and the dispatching /resolve types by asking
    // identity. Identity is a stubbed service like every other here: this loopback literal (no DNS lookup) is answered
    // by the fetch stub from fleet-defaults.json, which authenticates the child's fixture credential (child.ts) and
    // the operator scenarios' key, and refuses anything else. The door's code is unchanged.
    IDENTITY_VESSEL_URL: "http://127.0.0.1:59190",
    ANTHROPIC_API_KEY: "verdict-diff-unused",
    VESSEL_ID: "goal-host-vessel",
    GOAL_HOST_VESSEL_ID: "goal-host-vessel",
    PORT: "18999",
    GOAL_HOST_WS_SUBSCRIBER: "off",
    // Durable state the module would otherwise put under /workspace (redirected anyway).
    REACH_VERDICT_SPOOL_PATH: `${ws}/state/reach-spool.jsonl`,
    REACHED_CMD_CACHE_PATH: `${ws}/state/reached-commands.json`,
    GOAL_FAILURE_MEMORY_PATH: `${ws}/state/goal-failure-memory.json`,
    MEM_DUMP_PATH: `${ws}/state/mem-dump.json`,
    SUBSTRATE_STATE_DIR: `${ws}/state`,
    QUIESCE_DIR: `${ws}/quiesce`,
    IAS_BUS_DROP_LOG_PATH: `${ws}/state/bus-drop.log`,
    ...extra,
  };
}

export function listScenarios(filter?: string): string[] {
  return readdirSync(SCENARIO_DIR).filter((f) => f.endsWith(".json")).sort()
    .map((f) => f.replace(/\.json$/, ""))
    .filter((id) => !filter || id.includes(filter));
}

export interface ScenarioResult { id: string; json: string; log: string; exitCode: number; stderr: string }

export async function runScenario(tree: string, id: string): Promise<ScenarioResult> {
  const ws = mkdtempSync(join(tmpdir(), "verdict-diff-"));
  const out = join(ws, "out.json");
  try {
    const scenario = JSON.parse(readFileSync(join(SCENARIO_DIR, `${id}.json`), "utf8")) as { env?: Record<string, string> };
    const proc = Bun.spawn([process.execPath, join(HARNESS_DIR, "child.ts"), resolve(tree), join(SCENARIO_DIR, `${id}.json`), DEFAULTS_PATH, out], {
      cwd: ws, env: childEnv(ws, scenario.env ?? {}), stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, , stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const json = existsSync(out) ? readFileSync(out, "utf8") : JSON.stringify({ scenario: id, fatal: `no output (exit ${exitCode})` }) + "\n";
    const logPath = out.replace(/\.json$/, ".log.json");
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    return { id, json, log, exitCode, stderr: stderr.split(ws).join("<WS>") };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

export async function runAll(tree: string, ids: string[], concurrency = Number(process.env["VD_CONCURRENCY"] ?? 4)): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = new Array(ids.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= ids.length) return;
      results[i] = await runScenario(tree, ids[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return results;
}

/** First differing line between two texts, for a readable failure message. */
export function firstDiff(a: string, b: string): string | null {
  if (a === b) return null;
  const la = a.split("\n"), lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return `line ${i + 1}:\n  golden: ${(la[i] ?? "<eof>").slice(0, 300)}\n  actual: ${(lb[i] ?? "<eof>").slice(0, 300)}`;
  }
  return "differs";
}
