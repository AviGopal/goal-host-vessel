// A HOST WHOSE STATE DIR IS OFF /workspace NEVER RUNS ON /workspace STORES.
//
// Tests Bun.spawn src/index.ts as a real host with a REPLACED env, so the gate's scrubbed_env redirect does not reach
// it. Every store path the host reads from the env with a /workspace default then resolves to the LIVE file inside a
// substrate container: such a host restored the live dispatch store, could re-grade, requeue and resume its
// interrupted dispatches against a mock fleet, and persisted back over it every 5 s.
//
// The guard reads only EXISTING env reads (no new switch: law 1). A real deployment keeps its state where the source
// defaults it, under /workspace (no unit template, gen-env line, profile or rendered unit sets SUBSTRATE_STATE_DIR), and
// the gate's scrubbed_env moves EVERY such path, the state dir included, to its throwaway root. So a state dir OFF
// /workspace while another store path still resolves UNDER it is a half-redirected host: a test's spawned host that
// missed a path. That host refuses to boot (before any store is touched), and a host with its state dir off /workspace
// skips the boot reconcile that reads the hard-coded /workspace/proposals compose reports (no env redirects those).
// Production defaults (every path unset) never trip either.

/** Every env-overridable store path the host's source defaults to /workspace (each key's default is under it). The
 *  list is pinned equal to a grep of src/ by test/host-spawn-state-env.test.ts. */
export const WORKSPACE_DEFAULTED_STATE_KEYS = [
  "GOAL_FAILURE_MEMORY_PATH",
  "GOAL_HOST_DISPATCH_STORE_PATH",
  "IAS_BUS_DROP_LOG_PATH",
  "MEM_DUMP_PATH",
  "QUIESCE_DIR",
  "REACHED_CMD_CACHE_PATH",
  "REACH_VERDICT_SPOOL_PATH",
  "SUBSTRATE_STATE_DIR",
  "WORKSPACE_ROOT",
] as const;

const STATE_DIR_DEFAULT = "/workspace/state";
const underWorkspace = (p: string): boolean => p === "/workspace" || p.startsWith("/workspace/");
const resolved = (v: string | undefined): string | null => (v === undefined || v === "" ? null : v);

type Env = Record<string, string | undefined>;

/** Each key read BY NAME (every name is already an env read of the host, pinned in the env-read ratchet): no dynamic
 *  env read and no new name. */
function storePaths(env: Env): Record<(typeof WORKSPACE_DEFAULTED_STATE_KEYS)[number], string | undefined> {
  return {
    GOAL_FAILURE_MEMORY_PATH: env.GOAL_FAILURE_MEMORY_PATH,
    GOAL_HOST_DISPATCH_STORE_PATH: env.GOAL_HOST_DISPATCH_STORE_PATH,
    IAS_BUS_DROP_LOG_PATH: env.IAS_BUS_DROP_LOG_PATH,
    MEM_DUMP_PATH: env.MEM_DUMP_PATH,
    QUIESCE_DIR: env.QUIESCE_DIR,
    REACHED_CMD_CACHE_PATH: env.REACHED_CMD_CACHE_PATH,
    REACH_VERDICT_SPOOL_PATH: env.REACH_VERDICT_SPOOL_PATH,
    SUBSTRATE_STATE_DIR: env.SUBSTRATE_STATE_DIR,
    WORKSPACE_ROOT: env.WORKSPACE_ROOT,
  };
}

/** Is the host's state dir (SUBSTRATE_STATE_DIR, default /workspace/state) off /workspace? */
export function stateDirOffWorkspace(env: Env = process.env): boolean {
  return !underWorkspace(resolved(storePaths(env).SUBSTRATE_STATE_DIR) ?? STATE_DIR_DEFAULT);
}

/** The store keys (besides the state dir) whose resolved path is under /workspace: unset (its default is) or set there. */
export function workspaceStateViolations(env: Env = process.env): string[] {
  const paths = storePaths(env);
  return WORKSPACE_DEFAULTED_STATE_KEYS.filter((k) => k !== "SUBSTRATE_STATE_DIR").filter((k) => {
    const v = resolved(paths[k]);
    return v === null || underWorkspace(v);
  });
}

/** A half-redirected host (state dir off /workspace, another store under it): the refusal line, else null. */
export function testHostRefusal(env: Env = process.env): string | null {
  if (!stateDirOffWorkspace(env)) return null;
  const bad = workspaceStateViolations(env);
  return bad.length === 0 ? null
    : `[goal-host-vessel] REFUSING TO BOOT: the state dir (SUBSTRATE_STATE_DIR=${storePaths(env).SUBSTRATE_STATE_DIR}) is off /workspace but these store paths still resolve under /workspace (live state): ${bad.join(", ")}`;
}
