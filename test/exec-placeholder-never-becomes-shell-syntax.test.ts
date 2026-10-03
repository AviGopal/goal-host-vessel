import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { interpolateExecPlaceholders } from "../src/exec-placeholder";

// A POOL VALUE SPLICED INTO AN EXECUTOR COMMAND MUST NEVER BECOME SHELL SYNTAX.
// Gap: exec-placeholder-interpolation-ignores-quote-context-so-pool-content-executes-inside-double-quotes.
//
// The walk threads produced pool content (web search results, fetched bodies, LLM output) into an
// LLM-written executor command through {{shape}} placeholders, then sends the command to the shell
// resolver (local-tools: `bash -c`, root in the substrate container). The splice wrapped every value
// in single quotes WITHOUT looking at where the placeholder sits:
//   - inside double quotes the single quotes are literal, so `$( )` and backticks in the value run;
//   - inside single quotes the wrapping quotes CLOSE the surrounding quote, leaving the value bare;
//   - inside a nested program (`sh -c "…"`, an awk body, `| sh`) the value is parsed again as code.
//
// These tests drive the extracted splice and run whatever command it produces through a REAL shell
// (`sh -c` and `bash -c`, the resolver's shell) confined to a per-case sandbox under this test's
// own directory, so an injection is observable as a sentinel file. The shell is a stub only in
// where it runs. A splice may also REFUSE a command it cannot make safe; a refused command never
// reaches a shell.

const TEST_DIR = import.meta.dir;
let tmpRoot = "";
let sandbox = "";
const spawned: string[] = [];

// ── guards: no network, no process except the confined stub shell, no writes outside tmp ──
const realFetch = globalThis.fetch;
const realSpawn = Bun.spawn;
const realSpawnSync = Bun.spawnSync;
let allowStubShell = false;
const SHELLS = ["sh", "bash"] as const;
type Shell = (typeof SHELLS)[number];

beforeAll(() => {
  tmpRoot = mkdtempSync(join(TEST_DIR, ".tmp-exec-placeholder-"));
  globalThis.fetch = (async () => { throw new Error("exec-placeholder test: network is forbidden"); }) as unknown as typeof fetch;
  (Bun as unknown as Record<string, unknown>).spawn = () => { throw new Error("exec-placeholder test: Bun.spawn is forbidden"); };
  (Bun as unknown as Record<string, unknown>).spawnSync = (cmd: string[], opts: { cwd?: string }) => {
    if (!allowStubShell || !(SHELLS as readonly string[]).includes(cmd[0]) || cmd[1] !== "-c" || !opts?.cwd?.startsWith(tmpRoot)) {
      throw new Error(`exec-placeholder test: process forbidden: ${JSON.stringify(cmd)}`);
    }
    return realSpawnSync(cmd, opts as Parameters<typeof realSpawnSync>[1]);
  };
});

afterAll(() => {
  globalThis.fetch = realFetch;
  (Bun as unknown as Record<string, unknown>).spawn = realSpawn;
  (Bun as unknown as Record<string, unknown>).spawnSync = realSpawnSync;
  if (tmpRoot.startsWith(join(TEST_DIR, ".tmp-exec-placeholder-"))) rmSync(tmpRoot, { recursive: true, force: true });
});

let caseNo = 0;
const newSandbox = () => {
  sandbox = join(tmpRoot, `case-${++caseNo}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(sandbox);
};
beforeEach(() => { newSandbox(); spawned.length = 0; });
afterEach(() => { sandbox = ""; });

/** The stub shell: a real `sh -c` / `bash -c`, confined to the sandbox (cwd and HOME). */
function stubShell(shell: Shell, command: string): { stdout: string; exit_code: number } {
  spawned.push(command);
  allowStubShell = true;
  try {
    const r = Bun.spawnSync([shell, "-c", command], {
      cwd: sandbox,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: sandbox },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { stdout: r.stdout.toString(), exit_code: r.exitCode ?? -1 };
  } finally {
    allowStubShell = false;
  }
}

/** The splice's outcome, whether it returns the command text or a refusal. */
type Spliced = { ok: true; command: string } | { ok: false; reason: string };
function splice(template: string, vars: Record<string, unknown>): Spliced {
  const r = interpolateExecPlaceholders(template, vars) as unknown;
  if (typeof r === "string") return { ok: true, command: r };
  const o = r as Record<string, unknown>;
  if (o && o.ok === true && typeof o.command === "string") return { ok: true, command: o.command };
  return { ok: false, reason: String(o?.reason ?? "refused") };
}

/** Run the spliced command the way the walk would, in a FRESH sandbox per shell. */
function runEach(template: string, value: unknown): Array<{ shell: Shell; spliced: Spliced; stdout: string | null; files: string[] }> {
  return SHELLS.map((shell) => {
    newSandbox();
    const spliced = splice(template, { x: value });
    const stdout = spliced.ok ? stubShell(shell, spliced.command).stdout : null;
    return { shell, spliced, stdout, files: readdirSync(sandbox) };
  });
}

// Payloads a pool impulse (a search snippet, a fetched page, an LLM answer) can carry.
const DOLLAR_PAREN = "$(touch${IFS}PWNED)";
const BACKTICKS = "`touch${IFS}PWNED`";
const QUOTE_BREAK = "it'$(touch${IFS}PWNED)'s";
const PAYLOADS: Array<[string, string]> = [
  ["dollar-paren", DOLLAR_PAREN],
  ["backticks", BACKTICKS],
  ["single-quote breakout", QUOTE_BREAK],
];

describe("exec-placeholder: the stub shells are a live positive control", () => {
  for (const shell of SHELLS) {
    test(`exec-placeholder control: the confined ${shell} really executes command substitution inside double quotes`, () => {
      // Without this, a missing sentinel could mean the harness cannot observe injection at all.
      stubShell(shell, `printf %s "${DOLLAR_PAREN}"`);
      expect(existsSync(join(sandbox, "PWNED"))).toBe(true);
    });
  }
});

describe("exec-placeholder: a pool value never executes in any quote context (MUST-FAIL at base)", () => {
  // (a) inside double quotes, (b) inside single quotes, (c) bare: the command is still produced and
  // prints the value LITERALLY; nothing executes.
  const contexts: Array<[string, string]> = [
    ["double-quoted", `printf %s "{{x}}"`],
    ["double-quoted mid-string", `printf %s "pre {{x}} post"`],
    ["single-quoted", `printf %s '{{x}}'`],
    ["single-quoted mid-string", `printf %s 'pre {{x}} post'`],
    ["bare", `printf %s {{x}}`],
  ];
  for (const [ctxName, template] of contexts) {
    for (const [payloadName, payload] of PAYLOADS) {
      test(`exec-placeholder: ${ctxName} placeholder with a ${payloadName} value creates no sentinel and prints the value literally`, () => {
        const expected = template.replace(/^printf %s ["']?/, "").replace(/["']$/, "").replace("{{x}}", payload);
        for (const r of runEach(template, payload)) {
          expect({ shell: r.shell, files: r.files }).toEqual({ shell: r.shell, files: [] });
          expect({ shell: r.shell, ok: r.spliced.ok, stdout: r.stdout }).toEqual({ shell: r.shell, ok: true, stdout: expected });
        }
      });
    }
  }

  // (d) and kin: the value would be parsed AGAIN by a nested interpreter. These cannot be made
  // safe by quoting at the outer level, so the command is refused and never reaches a shell.
  const nested: Array<[string, string, string]> = [
    ["sh -c double-quoted program", `sh -c "printf %s {{x}}"`, DOLLAR_PAREN],
    ["sh -c double-quoted program with backticks", `sh -c "printf %s {{x}}"`, BACKTICKS],
    ["bash -c single-quoted program", `bash -c 'printf %s {{x}}'`, DOLLAR_PAREN],
    ["bash -c single-quoted program with backticks", `bash -c 'printf %s {{x}}'`, BACKTICKS],
    ["value piped into sh", `printf %s {{x}} | sh`, "touch PWNED"],
    ["eval", `eval printf %s {{x}}`, DOLLAR_PAREN],
    ["awk program body", `awk 'BEGIN{print "{{x}}"}'`, `"; system("touch PWNED"); "`],
    ["bash arithmetic test", `[[ {{x}} -eq 1 ]] && echo one`, "a[$(touch${IFS}PWNED)]"],
    ["arithmetic expansion", `echo $(( {{x}} + 1 ))`, "a[$(touch${IFS}PWNED)]"],
    ["value redirected then piped into sh", `echo {{x}} 2>&1 | sh`, "touch PWNED"],
    ["value from a brace group piped into sh", `{ echo {{x}}; } | sh`, "touch PWNED"],
    ["value from a subshell piped into sh", `(echo {{x}}) | sh`, "touch PWNED"],
    ["value piped into a wrapped interpreter", `echo {{x}} | sudo -u root sh`, "touch PWNED"],
    ["wrapper takes the value as its command", `timeout 5 {{x}} PWNED`, "touch"],
    ["nice wrapper takes the value as its command", `nice -n 5 {{x}} PWNED`, "touch"],
    ["let evaluates the value as arithmetic", `let "z = {{x}}"`, "a[$(touch${IFS}PWNED)]"],
    ["ansi-c dollar-quoting", `printf %s $'{{x}}'`, "x'$(touch${IFS}PWNED)'y"],
    ["heredoc body carrying a value", `cat <<EOF\nval: {{x}}\nEOF`, DOLLAR_PAREN],
    ["trap action string single-quoted", `trap '{{x}}' EXIT`, "touch PWNED"],
    ["trap action string double-quoted", `trap "{{x}}" EXIT`, "touch PWNED"],
    ["declare evaluates a subscript", `declare {{x}}`, "a[$(touch${IFS}PWNED)]=1"],
    ["read evaluates a subscript", `read {{x}}`, "a[$(touch${IFS}PWNED)]"],
    ["printf -v evaluates a target subscript", `printf -v {{x}} %s hi`, "a[$(touch${IFS}PWNED)]"],
  ];
  for (const [ctxName, template, payload] of nested) {
    test(`exec-placeholder: ${ctxName} with a pool value is refused and creates no sentinel`, () => {
      for (const r of runEach(template, payload)) {
        expect({ shell: r.shell, files: r.files }).toEqual({ shell: r.shell, files: [] });
        expect({ shell: r.shell, refused: !r.spliced.ok }).toEqual({ shell: r.shell, refused: true });
      }
    });
  }

  test("exec-placeholder: program bodies of jq sed and python with a pool value are refused", () => {
    for (const t of [
      `jq -r '.items[] | select(.name == "{{x}}")' data.json`,
      `sed -e 's/a/{{x}}/' file.txt`,
      `python3 -c 'print("{{x}}")'`,
    ]) {
      expect({ t, refused: !splice(t, { x: "v" }).ok }).toEqual({ t, refused: true });
    }
  });

  test("exec-placeholder: a placeholder in command position or in a heredoc body is refused", () => {
    for (const t of [`{{x}} --version`, `cat <<EOF\n{{x}}\nEOF`, `X={{x}} printf %s hi`]) {
      expect({ t, refused: !splice(t, { x: "v" }).ok }).toEqual({ t, refused: true });
    }
  });

  test("exec-placeholder: benign values round-trip literally inside double and single quotes", () => {
    for (const v of ["hello world", "1,234.5", "it's", "line one\nline two", "back\\slash and dq\" too"]) {
      for (const template of [`printf %s "{{x}}"`, `printf %s '{{x}}'`]) {
        for (const r of runEach(template, v)) {
          expect({ shell: r.shell, template, v, ok: r.spliced.ok, stdout: r.stdout }).toEqual({ shell: r.shell, template, v, ok: true, stdout: v });
        }
      }
    }
  });
});

describe("exec-placeholder: benign values still flow (CONTROL, green at base and fix)", () => {
  test("exec-placeholder control: benign values round-trip literally as a bare argument", () => {
    for (const v of ["hello world", "1,234.5", "it's", "line one\nline two"]) {
      for (const r of runEach(`printf %s {{x}}`, v)) {
        expect({ shell: r.shell, v, ok: r.spliced.ok, stdout: r.stdout }).toEqual({ shell: r.shell, v, ok: true, stdout: v });
      }
    }
  });

  test("exec-placeholder control: a value piped as data into a filter is still produced and runs", () => {
    for (const r of runEach(`printf %s {{x}} | tr a-z A-Z`, "hello world")) {
      expect({ shell: r.shell, ok: r.spliced.ok, stdout: r.stdout }).toEqual({ shell: r.shell, ok: true, stdout: "HELLO WORLD" });
    }
  });

  test("exec-placeholder control: a value in a fetch arg piped as DATA into a program filter is produced", () => {
    // The value is in curl's own argv (safe), not jq's program; jq reads DATA on stdin.
    const r = splice(`curl -s "{{x}}" | jq -r .name`, { x: "http://example.invalid/a" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.command).toBe(`curl -s ""'http://example.invalid/a'"" | jq -r .name`);
  });

  test("exec-placeholder control: a command whose only placeholder is unbound is returned unchanged even beside an expansion", () => {
    // Regression: the safety lexer must not refuse a command that carries no value to splice.
    const t = `echo "$(date +%s)" {{unbound}}`;
    const r = splice(t, { x: "v" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.command).toBe(t);
  });

  test("exec-placeholder control: object fields and content keys are threaded", () => {
    for (const r of runEach(`printf %s {{x.stdout}}`, { stdout: "42", stderr: "" })) {
      expect({ shell: r.shell, stdout: r.stdout }).toEqual({ shell: r.shell, stdout: "42" });
    }
    for (const r of runEach(`printf %s {{x}}`, { content: "body text" })) {
      expect({ shell: r.shell, stdout: r.stdout }).toEqual({ shell: r.shell, stdout: "body text" });
    }
  });

  test("exec-placeholder control: unknown and null placeholders are left intact", () => {
    const a = splice(`printf %s {{nope}} {{x}}`, { x: "v" });
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.command).toBe(`printf %s {{nope}} 'v'`);
    const b = splice(`printf %s {{x}}`, { x: null });
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.command).toBe(`printf %s {{x}}`);
  });

  test("exec-placeholder control: a command with no placeholder is returned unchanged", () => {
    const t = `sh -c "echo hi" && awk 'BEGIN{print 1}'`;
    const r = splice(t, { x: "v" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.command).toBe(t);
  });
});
