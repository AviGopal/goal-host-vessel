// Pins the origin rule of the read-only shell gate (src/independent-recompute.ts
// `isReadOnlyShellCommand`) and its wiring into every caller in src/index.ts. The end-to-end replays
// through the real walk are in test/read-only-gate-egress-loop.test.ts; this file is pure and runs
// anywhere, including the container.
//
// The gate is the only check in front of the verifier's independent derivations and the learned
// family recipes, and it admitted curl to any host. The rule: every network origin the command names
// (parsed by src/command-egress.ts) is loopback — 127.0.0.1 ≡ localhost ≡ [::1], any port — or is
// named by the original inputs of the call (the goal text). With no inputs, only loopback.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isReadOnlyShellCommand } from "../src/independent-recompute";

// The gate decides; it must never perform I/O. Any fetch or spawn while these tests run fails them.
const realFetch = globalThis.fetch;
const realSpawn = Bun.spawn;
let io = 0;
beforeAll(() => {
  globalThis.fetch = (async () => { io++; throw new Error("read-only gate test: no network"); }) as unknown as typeof fetch;
  (Bun as { spawn: unknown }).spawn = () => { io++; throw new Error("read-only gate test: no spawn"); };
});
afterAll(() => {
  globalThis.fetch = realFetch;
  (Bun as { spawn: unknown }).spawn = realSpawn;
  expect(io).toBe(0);
});

const GOAL = "How many shapes does the discovery registry advertise?";

describe("an external origin the goal did not name is refused", () => {
  test("(a) curl to api.merlonix.com: the CommandRefusal names the rule and the origin", () => {
    const r = isReadOnlyShellCommand("curl -s https://api.merlonix.com/v1/x | jq .n", [GOAL]);
    expect(r).toEqual({ ok: false, reason: "network origin(s) neither loopback nor named by the goal: https://api.merlonix.com:443" });
  });
  test("scheme-less targets, proxies and other clients are refused too (command-egress parses them)", () => {
    for (const cmd of [
      "curl -s api.merlonix.com/v1/x | jq .n",
      "curl -s -x evil.example:3128 http://127.0.0.1:8100/x | jq length",
      "https_proxy=evil.example:3128 curl -s http://127.0.0.1:8100/x | jq length",
      "git ls-remote https://github.com/x/y.git | wc -l",
      "nc evil.example 80 | wc -l",
    ]) expect(isReadOnlyShellCommand(cmd, [GOAL]).ok).toBe(false);
  });
  test("with no inputs only loopback passes (a caller that omits them fails closed)", () => {
    expect(isReadOnlyShellCommand("curl -s https://api.merlonix.com/v1/x | jq .n").ok).toBe(false);
    expect(isReadOnlyShellCommand("curl -s http://127.0.0.1:8100/v2/registry/shapes | jq '.shapes|length'").ok).toBe(true);
  });
  test("a host built at run time is refused", () => {
    expect(isReadOnlyShellCommand("curl -s https://$(cat host)/x | jq .n", [GOAL]).ok).toBe(false);
  });
});

describe("loopback and goal-named origins are allowed", () => {
  test("(b) the registry on 127.0.0.1:8100", () => {
    expect(isReadOnlyShellCommand("curl -s http://127.0.0.1:8100/v2/registry/shapes | jq '.shapes|length'", [GOAL])).toEqual({ ok: true });
  });
  test("loopback aliases on any port: localhost, [::1]", () => {
    expect(isReadOnlyShellCommand("curl -s http://localhost:18100/v2/registry/shapes | jq '.shapes | length'", [GOAL]).ok).toBe(true);
    expect(isReadOnlyShellCommand("curl -s http://[::1]:8260/concepts | jq length", [GOAL]).ok).toBe(true);
  });
  test("(d) an external host the goal names, bare or as a URL", () => {
    const cmd = "curl -s https://api.merlonix.com/v1/x | jq .n";
    expect(isReadOnlyShellCommand(cmd, ["How many records does api.merlonix.com report?"]).ok).toBe(true);
    expect(isReadOnlyShellCommand(cmd, ["How many records does https://api.merlonix.com/v1/x return?"]).ok).toBe(true);
    // A URL literal admits exactly its own origin, not another port on the same host.
    expect(isReadOnlyShellCommand("curl -s https://api.merlonix.com:8443/v1/x | jq .n", ["How many records does https://api.merlonix.com/v1/x return?"]).ok).toBe(false);
  });
  test("commands with no network origin are unaffected", () => {
    expect(isReadOnlyShellCommand("find /workspace/git/vessels/activity-api/src -name '*.ts' | wc -l", []).ok).toBe(true);
    expect(isReadOnlyShellCommand("git -C /workspace/git/vessels/concept-db log --since=30.days --oneline | wc -l", [GOAL]).ok).toBe(true);
  });
  test("the earlier rules still fire first, with their own reasons", () => {
    expect(isReadOnlyShellCommand("rm -rf /workspace/git", [GOAL])).toEqual({ ok: false, reason: "mutating command" });
    expect(isReadOnlyShellCommand("curl -s https://api.merlonix.com/x > /tmp/o", [GOAL])).toEqual({ ok: false, reason: "output redirection writes to disk" });
  });
});

describe("index.ts passes the goal at every call of the gate, and every recipe run goes through it", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
  test("every call site passes [goal] (none relies on the loopback-only default)", () => {
    const calls = src.match(/isReadOnlyShellCommand\([^)]*\)/g) ?? [];
    expect(calls).toEqual([
      "isReadOnlyShellCommand(cmd, [goal])",      // recipeCommandFor
      "isReadOnlyShellCommand(command, [goal])",  // recomputeIndependently: authored derivation
      "isReadOnlyShellCommand(cmd, [goal])",      // recomputeIndependently: recipe derivation
    ]);
  });
  test("recipeCommandFor returns a command only after the gate passed, and says when it refuses", () => {
    const body = src.slice(src.indexOf("function recipeCommandFor(goal: string): string | null {"), src.indexOf("async function recomputeIndependently("));
    const gate = body.indexOf("const gate = isReadOnlyShellCommand(cmd, [goal]);");
    expect(gate).toBeGreaterThan(0);
    expect(body.indexOf("if (!gate.ok) {", gate)).toBeGreaterThan(gate);
    expect(body.indexOf("return cmd;")).toBeGreaterThan(gate);
    expect(body).toContain("REFUSED by the read-only gate");
  });
  test("each recompute derivation is gated before ufExecuteTool runs it", () => {
    const rec = src.slice(src.indexOf("async function recomputeIndependently("));
    const authored = rec.indexOf("const gate = isReadOnlyShellCommand(command, [goal]);");
    expect(authored).toBeGreaterThan(0);
    expect(rec.indexOf('await ufExecuteTool("shellResult", { command }', authored)).toBeGreaterThan(authored);
    const recipe = rec.indexOf("const gate = isReadOnlyShellCommand(cmd, [goal]);");
    expect(recipe).toBeGreaterThan(0);
    expect(rec.indexOf('await ufExecuteTool("shellResult", { command: cmd }', recipe)).toBeGreaterThan(recipe);
  });
  test("a recipe is instantiated only in recipeCommandFor and the gated recipe derivation", () => {
    // Any other instantiateRecipe( call would be a recipe run that bypasses the gate.
    expect((src.match(/instantiateRecipe\(/g) ?? []).length).toBe(2);
    // The recipe sites (walk answer, floor seed, executor recovery) take their command from recipeCommandFor.
    expect(src).toContain("const _rc = recipeCommandFor(goal)!;");
    expect(src).toContain("const rc = recipeCommandFor(goal);");
    expect(src).toContain("const _recovery = recipeCommandFor(goal);");
  });
});
