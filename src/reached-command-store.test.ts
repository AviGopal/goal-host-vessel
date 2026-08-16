import { describe, expect, test } from "bun:test";
import { applyReachedCommandLines } from "./reached-command-store";

// The property under test is that a FALSE verdict can un-bank what a TRUE verdict banked, and
// that it survives a restart. Before the tombstone, the loader only ever created entries, so an
// in-memory delete was erased on the next boot and a command from a reach that later graded false
// was replayed byte-identical. A library that can only grow is the same one-way ratchet as a
// posterior that can only rise.

const bank = (hash: string, command: string) =>
  JSON.stringify({ hash, command, field: "command", shape: "shellResult", targetShapes: ["shellResult"], goalText: "g" });
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
