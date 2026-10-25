/**
 * Test isolation for the dispatch store.
 *
 * src/index.ts reads DISPATCH_STORE_PATH ONCE, at module load, from GOAL_HOST_DISPATCH_STORE_PATH with the live default
 * /workspace/goal-host-dispatches.json, and /run-goal persists the whole executionStore there. A test file that seeds
 * fixture dispatches redirects the path before its own import (inbound-auth-gate, request-queue-resolve, ...), but in a
 * multi-file `bun test` process the module is loaded by whichever file imports it FIRST, and most importers set no
 * path. Run without a scrubbed environment, the first importer fixed the live path, the fixture files' redirects then
 * changed nothing, and their fixtures were persisted over the live store: a restart found 6 records, all fixtures,
 * requeued "inbound-auth-running-dispatch" and walked it live for 25 minutes.
 *
 * Preloaded via bunfig.toml, so every `bun test` in this tree (a child `bun test` spawned from the repo cwd included)
 * starts with the path at a temp file unless it already names a file outside /workspace. A test that sets its own path
 * still does so after this runs.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const current = process.env["GOAL_HOST_DISPATCH_STORE_PATH"];
if (!current || current.startsWith("/workspace/")) {
  process.env["GOAL_HOST_DISPATCH_STORE_PATH"] = join(mkdtempSync(join(tmpdir(), "goal-host-dispatch-store-")), "goal-host-dispatches.json");
}
