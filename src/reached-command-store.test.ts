import { describe, expect, test } from "bun:test";
// A namespace import, so on a tree without shouldBank the file still loads and only the tests that need it fail.
import * as store from "./reached-command-store";
const { applyReachedCommandLines } = store;

// The property under test is that a FALSE verdict can un-bank what a TRUE verdict banked, and
// that it survives a restart. Before the tombstone, the loader only ever created entries, so an
// in-memory delete was erased on the next boot and a command from a reach that later graded false
// was replayed byte-identical. A library that can only grow is the same one-way ratchet as a
// posterior that can only rise.

// Bank lines carry their bank basis, as every line written since the bank gate does (the legacy case is below).
const bank = (hash: string, command: string, basis: string | null = "deterministic") =>
  JSON.stringify({ hash, command, field: "command", shape: "shellResult", targetShapes: ["shellResult"], goalText: "g", ...(basis ? { basis } : {}) });
const tomb = (hash: string, reason = "reach graded false") =>
  JSON.stringify({ hash, tombstone: true, reason });

describe("applyReachedCommandLines", () => {
  test("banks a command", () => {
    const { entries, applied } = applyReachedCommandLines([bank("h1", "curl a")]);
    expect(entries.get("h1")?.command).toBe("curl a");
    expect(applied).toBe(1);
  });

  test("A TOMBSTONE REMOVES A BANKED COMMAND — the regression this exists to prevent", () => {
    const { entries, tombstoned } = applyReachedCommandLines([bank("h1", "curl bad"), tomb("h1")]);
    expect(entries.has("h1")).toBe(false);
    expect(tombstoned).toBe(1);
  });

  test("the eviction survives replay of the whole file, not just the tail", () => {
    const lines = [bank("h1", "curl bad"), bank("h2", "curl ok"), tomb("h1"), bank("h3", "curl x")];
    const { entries } = applyReachedCommandLines(lines);
    expect(entries.has("h1")).toBe(false);
    expect(entries.get("h2")?.command).toBe("curl ok");
    expect(entries.get("h3")?.command).toBe("curl x");
  });

  test("recency decides: a re-bank AFTER a tombstone restores the entry", () => {
    const { entries } = applyReachedCommandLines([bank("h1", "curl bad"), tomb("h1"), bank("h1", "curl fixed")]);
    expect(entries.get("h1")?.command).toBe("curl fixed");
  });

  test("recency decides the other way: a tombstone AFTER a re-bank still evicts", () => {
    const { entries } = applyReachedCommandLines([bank("h1", "a"), tomb("h1"), bank("h1", "b"), tomb("h1")]);
    expect(entries.has("h1")).toBe(false);
  });

  test("a tombstone for a hash never banked is harmless", () => {
    const { entries } = applyReachedCommandLines([tomb("ghost")]);
    expect(entries.size).toBe(0);
  });

  test("a tombstone only affects its own hash", () => {
    const { entries } = applyReachedCommandLines([bank("h1", "a"), bank("h2", "b"), tomb("h1")]);
    expect(entries.has("h1")).toBe(false);
    expect(entries.get("h2")?.command).toBe("b");
  });

  test("malformed and empty lines are skipped, not fatal", () => {
    const { entries } = applyReachedCommandLines(["", "   ", "{not json", "{}", bank("h1", "a")]);
    expect(entries.get("h1")?.command).toBe("a");
    expect(entries.size).toBe(1);
  });

  test("an entry missing required fields is not banked", () => {
    const { entries } = applyReachedCommandLines([JSON.stringify({ hash: "h1", command: "curl a" })]);
    expect(entries.size).toBe(0);
  });

  test("tombstones count as applied work — eviction must not read as a no-op in the boot log", () => {
    const { applied, tombstoned } = applyReachedCommandLines([bank("h1", "a"), tomb("h1")]);
    expect(applied).toBe(2);
    expect(tombstoned).toBe(1);
  });
});

// THE BANK GATE. One judge "yes" banked a command, and the retry of the same failed dispatch replayed it: the wrong
// answer came back at attempt 2. Only a deterministic oracle's reach, or two independent observers concurring, banks.
describe("bank basis", () => {
  test("[MUST-FAIL on parent] a judge-only reach is not banked", () => {
    expect(store.shouldBank({ deterministic: false, independentConcurring: false })).toBeNull();
  });
  test("[MUST-FAIL on parent] an untagged pre-gate entry is not returned for replay", () => {
    const { entries, legacy } = applyReachedCommandLines([bank("h1", "curl judged-once", null)]);
    expect(entries.has("h1")).toBe(false);
    expect(legacy).toBe(1);
  });
  test("[MUST-FAIL on parent] an untagged entry comes back only through a fresh tagged re-bank", () => {
    const { entries } = applyReachedCommandLines([bank("h1", "old", null), bank("h1", "rebanked", "deterministic")]);
    expect(entries.get("h1")?.command).toBe("rebanked");
    expect(entries.get("h1")?.basis).toBe("deterministic");
  });
  test("[MUST-FAIL on parent] a deterministic reach banks under the deterministic basis", () => {
    expect(store.shouldBank({ deterministic: true, independentConcurring: false })).toBe("deterministic");
  });
  test("[MUST-FAIL on parent] two independent concurring observers bank under the concurring basis", () => {
    expect(store.shouldBank({ deterministic: false, independentConcurring: true })).toBe("concurring");
  });
  test("[MUST-FAIL on parent] an unknown basis value is treated as untagged", () => {
    const { entries } = applyReachedCommandLines([bank("h1", "a", "judge")]);
    expect(entries.has("h1")).toBe(false);
  });
  test("control: a deterministic-tagged line replays on the next boot (a fresh dispatch)", () => {
    const { entries } = applyReachedCommandLines([bank("h1", "curl verified", "deterministic")]);
    expect(entries.get("h1")?.command).toBe("curl verified");
  });
  test("control: a concurring-tagged line replays", () => {
    const { entries } = applyReachedCommandLines([bank("h2", "curl agreed", "concurring")]);
    expect(entries.get("h2")?.command).toBe("curl agreed");
  });
});

// A RETRY SKIPS ONLY WHAT FAILED. A retry after an in-dispatch failure used to run with ablation.disableReuse, which
// turned off every replay: on a feedback retry a VERIFIED http_fetch (200, 5.7k chars) was discarded and re-derived
// cold. Now the walk reads each banked replay against its success ledger, and the next attempt skips only the
// replays that failed, keyed by shape + command.
describe("failed bank replays", () => {
  const X = "curl -s http://127.0.0.1:1/broken | jq .n";
  const Y = "curl -s https://example.org/page";
  test("[MUST-FAIL on parent] a banked command whose replay produced nothing is recorded failed, and blocked on the retry", () => {
    const failed = store.failedBankReplays(new Map([["shellResult", X]]), new Map());
    expect(failed).toEqual([{ shape: "shellResult", command: X, why: "its replay produced no usable result" }]);
    expect(store.replayBlocked(failed, "shellResult", X)?.command).toBe(X);
  });
  test("[MUST-FAIL on parent] a replay the walk had to correct to another command is recorded failed", () => {
    const failed = store.failedBankReplays(new Map([["shellResult", X]]), new Map([["shellResult", "curl -s http://127.0.0.1:2/fixed"]]));
    expect(failed.map((f) => f.command)).toEqual([X]);
    expect(failed[0]!.why).toContain("corrected");
  });
  // The "no disableReuse ablation" half is pinned on the retry call sites in test/reached-command-bank-wiring.test.ts.
  test("[MUST-FAIL on parent] on the same retry a banked command that SUCCEEDED in the attempt stays reusable", () => {
    const failed = store.failedBankReplays(new Map([["shellResult", X], ["http_fetch", Y]]), new Map([["http_fetch", Y]]));
    expect(failed.map((f) => f.shape)).toEqual(["shellResult"]);
    expect(store.replayBlocked(failed, "http_fetch", Y)).toBeUndefined();
    expect(store.replayBlocked(failed, "shellResult", X)).toBeDefined();
  });
  test("[MUST-FAIL on parent] the block is keyed by shape AND command", () => {
    const failed = store.failedBankReplays(new Map([["shellResult", X]]), new Map());
    expect(store.replayBlocked(failed, "shellResult", Y)).toBeUndefined();
    expect(store.replayBlocked(failed, "http_fetch", X)).toBeUndefined();
  });
  test("[MUST-FAIL on parent] a first attempt carries no failure list, so nothing is blocked", () => {
    expect(store.replayBlocked(undefined, "shellResult", X)).toBeUndefined();
    expect(store.replayBlocked([], "shellResult", X)).toBeUndefined();
  });
  test("[MUST-FAIL on parent] a walk that replayed nothing records nothing", () => {
    expect(store.failedBankReplays(new Map(), new Map([["shellResult", X]]))).toEqual([]);
  });
});

// The family recipe goes through the same two functions: its replay is noted like a banked command's.
describe("family recipe replays", () => {
  const R = "find /workspace -name '*.ts' | wc -l";
  test("control (green on 0fdd24c): a recipe replay that failed is blocked on the retry", () => {
    const failed = store.failedBankReplays(new Map([["shellResult", R]]), new Map());
    expect(store.replayBlocked(failed, "shellResult", R)?.command).toBe(R);
  });
  // The floor seed reads the same list with the same key: a recipe that succeeded is still seeded.
  test("control: a recipe that succeeded is still seeded into the floor", () => {
    const failed = store.failedBankReplays(new Map([["shellResult", R]]), new Map([["shellResult", R]]));
    expect(store.replayBlocked(failed, "shellResult", R)).toBeUndefined();
    expect(store.replayBlocked(undefined, "shellResult", R)).toBeUndefined(); // the pre-walk (reuse) floor passes no list
  });
  test("control: a recipe replay that succeeded is reused", () => {
    const failed = store.failedBankReplays(new Map([["shellResult", R]]), new Map([["shellResult", R]]));
    expect(failed).toEqual([]);
    expect(store.replayBlocked(failed, "shellResult", R)).toBeUndefined();
  });
});
