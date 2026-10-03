import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fetchPrefixIsReRunnable, planFetchedValueStep } from "../src/fetched-value";

// FETCHED TEXT MUST NEVER REACH A SHELL.
// Gap: goal-host-echoes-llm-extracted-http-content-through-a-shell-so-fetched-text-executes.
//
// The executor correction loop asks the LLM for the single value in a FETCHED API/web body and
// accepts it if it occurs verbatim there. It then bound that value as `echo "<value>"` and RAN it
// through the shell resolver (local-tools, as root in the substrate container). `$(` and backticks
// execute inside double quotes, so a fetched body carrying `$(touch${IFS}x)1` passed every check
// (has a digit, <= 40 chars, no whitespace, verbatim in the body) and executed. Arbitrary web
// content became arbitrary code.
//
// These tests drive the extracted step. If the step still produces a shell command it is run
// through a REAL `sh -c` confined to a temp dir under this test's own directory, so an injection
// would be observable as a sentinel file. The shell is a stub only in where it runs.

const TEST_DIR = import.meta.dir;
let tmpRoot = "";
let sandbox = "";
const spawned: string[] = [];

// ── guards: no network, no process except the confined stub shell, no writes outside tmp ──
const realFetch = globalThis.fetch;
const realSpawn = Bun.spawn;
const realSpawnSync = Bun.spawnSync;
let allowStubShell = false;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(TEST_DIR, ".tmp-fetched-value-"));
  globalThis.fetch = (async () => { throw new Error("fetched-value test: network is forbidden"); }) as unknown as typeof fetch;
  (Bun as unknown as Record<string, unknown>).spawn = () => { throw new Error("fetched-value test: Bun.spawn is forbidden"); };
  (Bun as unknown as Record<string, unknown>).spawnSync = (cmd: string[], opts: { cwd?: string }) => {
    if (!allowStubShell || cmd[0] !== "sh" || cmd[1] !== "-c" || !opts?.cwd?.startsWith(tmpRoot)) {
      throw new Error(`fetched-value test: process forbidden: ${JSON.stringify(cmd)}`);
    }
    return realSpawnSync(cmd, opts as Parameters<typeof realSpawnSync>[1]);
  };
});

afterAll(() => {
  globalThis.fetch = realFetch;
  (Bun as unknown as Record<string, unknown>).spawn = realSpawn;
  (Bun as unknown as Record<string, unknown>).spawnSync = realSpawnSync;
  if (tmpRoot.startsWith(join(TEST_DIR, ".tmp-fetched-value-"))) rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  sandbox = join(tmpRoot, `case-${Math.random().toString(36).slice(2, 10)}`);
  mkdirSync(sandbox);
  spawned.length = 0;
});
afterEach(() => { sandbox = ""; });

const sentinel = () => join(sandbox, "PWNED");

/** The stub shell: a real `sh -c`, confined to the sandbox, with SENTINEL pointing inside it. */
function stubShell(command: string): { stdout: string; exit_code: number } {
  spawned.push(command);
  allowStubShell = true;
  try {
    const r = Bun.spawnSync(["sh", "-c", command], {
      cwd: sandbox,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: sandbox, SENTINEL: sentinel() },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { stdout: r.stdout.toString(), exit_code: r.exitCode ?? -1 };
  } finally {
    allowStubShell = false;
  }
}

/** Run the planned step the way the walk would: a command goes to the shell; an impulse is data. */
function realise(step: Record<string, unknown>): { value: string | null } {
  if (typeof step.command === "string") return { value: stubShell(step.command).stdout.trim() };
  const imp = step.impulse as Record<string, unknown> | undefined;
  if (imp && typeof imp.stdout === "string") return { value: imp.stdout.trim() };
  return { value: null };
}

const step = (llm: string, body: string) => planFetchedValueStep(llm, body) as unknown as Record<string, unknown>;

describe("fetched-value: the stub shell is a live positive control", () => {
  test("fetched-value: the confined stub shell really executes $( ) inside double quotes", () => {
    // Without this, a missing sentinel could mean the harness cannot observe injection at all.
    stubShell(`echo "$(touch\${IFS}$SENTINEL)1"`);
    expect(existsSync(sentinel())).toBe(true);
  });
});

describe("fetched-value: injection in a fetched body never executes (MUST-FAIL at base)", () => {
  test("fetched-value: $(…) in the fetched body creates no sentinel file", () => {
    const payload = "$(touch${IFS}$SENTINEL)1";
    const body = `{"result":"${payload}","note":"${"x".repeat(240)}"}`;
    realise(step(payload, body));
    expect(existsSync(sentinel())).toBe(false);
    expect(readdirSync(sandbox)).toEqual([]);
  });

  test("fetched-value: backticks in the fetched body create no sentinel file", () => {
    const payload = "1`touch${IFS}$SENTINEL`1";
    const body = `<td>${payload}</td>${"y".repeat(240)}`;
    realise(step(payload, body));
    expect(existsSync(sentinel())).toBe(false);
    expect(readdirSync(sandbox)).toEqual([]);
  });

  test("fetched-value: no shell command is produced from an extracted value at all", () => {
    for (const [llm, body] of [
      ["$(touch${IFS}$SENTINEL)1", "a $(touch${IFS}$SENTINEL)1 b"],
      ["1`id`", "x 1`id` y"],
      ["1,234.5", "price: 1,234.5 USD"],
    ] as const) {
      const s = step(llm, body);
      expect(s.command).toBeUndefined();
    }
    expect(spawned).toEqual([]);
  });

  test("fetched-value: a value outside the strict numeric charset is refused, never run", () => {
    for (const v of ["12:30:00", "1;id", "1|id", "1&id", "4'2", "1\\x"]) {
      const s = step(v, `body ${v} body`);
      expect(s.kind).toBe("rejected");
      expect(s.command).toBeUndefined();
    }
    expect(spawned).toEqual([]);
  });

  test("fetched-value: a fetch prefix with $( or backticks inside double quotes is not re-runnable", () => {
    expect(fetchPrefixIsReRunnable('curl -s "https://example.invalid/$(touch${IFS}x)"')).toBe(false);
    expect(fetchPrefixIsReRunnable('curl -s "https://example.invalid/`id`"')).toBe(false);
  });
});

describe("fetched-value: real values still flow (CONTROL, green at base and fix)", () => {
  test("fetched-value: a real numeric value flows through as the result value", () => {
    const s = step(' "1,234.5" ', `{"price":"1,234.5","currency":"USD"}`);
    expect(s.kind).not.toBe("rejected");
    expect(realise(s).value).toBe("1,234.5");
    expect(existsSync(sentinel())).toBe(false);
  });

  test("fetched-value: scientific, signed and percent values flow through", () => {
    for (const v of ["-4.1999e+02", "+0.997", "12.5%", "2026-10-03"]) {
      expect(realise(step(v, `x ${v} y`)).value).toBe(v);
    }
  });

  test("fetched-value: NONE, digitless and non-verbatim answers are rejected", () => {
    expect(step("NONE", "anything 1").kind).toBe("rejected");
    expect(step("unknown", "unknown").kind).toBe("rejected");
    expect(step("5.204", "the body says 5.2").kind).toBe("rejected");
  });

  test("fetched-value: a single-quoted URL with & is still re-runnable; operators outside quotes are not", () => {
    expect(fetchPrefixIsReRunnable("curl -s 'https://ssd.example/api?a=1&b=2'")).toBe(true);
    expect(fetchPrefixIsReRunnable('curl -s "https://ssd.example/api?a=1&b=2"')).toBe(true);
    expect(fetchPrefixIsReRunnable("curl -s 'https://x/' ; id")).toBe(false);
    expect(fetchPrefixIsReRunnable("curl -s https://x/$(id)")).toBe(false);
  });
});
