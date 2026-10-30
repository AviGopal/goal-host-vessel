// THE STATE ENV A TEST'S SPAWNED GOAL-HOST RUNS UNDER: every store path the host defaults to /workspace/* points into
// the test's own state dir.
//
// A test that Bun.spawns src/index.ts as a host with a REPLACED env does not inherit the gate's scrubbed_env redirect
// (substrate-pull-sync scrubbed_env points each `process.env.X ?? "/workspace/..."` default at a throwaway root), so a
// default it leaves out is the LIVE file inside a substrate container. GOAL_HOST_DISPATCH_STORE_PATH was left out by
// three such tests: in-container their host restored and persisted /workspace/goal-host-dispatches.json, the live
// dispatch store, and their result followed live state. The list is src/test-host-guard.ts's (pinned complete by
// test/host-spawn-state-env.test.ts, which re-derives it from the source).
import { join } from "node:path";
import { WORKSPACE_DEFAULTED_STATE_KEYS } from "../../src/test-host-guard";

export const HOST_STATE_ENV_KEYS = WORKSPACE_DEFAULTED_STATE_KEYS;

/** Every /workspace-defaulting store path of the host, under `stateDir`. With the state dir off /workspace, a host
 *  that still resolves any of these under /workspace refuses to boot (src/test-host-guard.ts). */
export function hostStateEnv(stateDir: string): Record<(typeof HOST_STATE_ENV_KEYS)[number], string> {
  return {
    GOAL_FAILURE_MEMORY_PATH: join(stateDir, "fm.json"),
    GOAL_HOST_DISPATCH_STORE_PATH: join(stateDir, "goal-host-dispatches.json"),
    IAS_BUS_DROP_LOG_PATH: join(stateDir, "dispatch-dropped.jsonl"),
    MEM_DUMP_PATH: join(stateDir, "mem-dump.json"),
    QUIESCE_DIR: join(stateDir, "quiesce"),
    REACHED_CMD_CACHE_PATH: join(stateDir, "rc.json"),
    REACH_VERDICT_SPOOL_PATH: join(stateDir, "spool"),
    SUBSTRATE_STATE_DIR: stateDir,
    WORKSPACE_ROOT: stateDir,
  };
}
