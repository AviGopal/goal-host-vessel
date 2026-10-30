// BANK PERSISTENCE: A PERSON'S "ACHIEVED" ON A DEFERRED JUDGE-ONLY REACH BANKS THE WALK'S REACHED COMMAND.
//
// The walk's reached commands are walk-scoped and in memory; a judge-only reach is not banked at walk end (the bank gate
// needs a deterministic oracle or two independent observers). The walk now keeps the judge-only reach's bank candidate
// (pickBankCandidate, the walk's own bank loop as a function) and the deferral carries it, bounded. A PERSON's
// "achieved" banks it with basis "concurring" (judge + person) and the person's provenance.
//
//   [MUST-FAIL] a person "achieved" banks the candidate: cache entry + one appended line, basis concurring, provenance
//   [CONTROL]   the judge alone never banks: the walk's bank gate is unchanged and a judge-only reach is only captured
//   [CONTROL]   not_achieved / partial / expiry bank nothing, and clear the candidate (pruned with the deferral)
//   [CONTROL]   observe never banks: no candidate captured, and an observe deferral banks nothing
//   [CONTROL]   a second person label is a no-op (no second bank)
//   [CONTROL]   NO OVERWRITE: an entry the goal already has (a deterministic bank made since) is left as it is
//   [CONTROL]   TOMBSTONES: a tombstone written after the walk is not resurrected; an earlier one does not block
//   [CONTROL]   an oversize command is not carried; the bounds hold
//   [CONTROL]   the deterministic bank is unchanged: pickBankCandidate equals the walk's inline loop on every fixture
//               (full toEqual), and the walk's own bank site is byte-identical
//   [CONTROL]   provenance is additive: an old-format line and a provenance line both load
//   [CONTROL]   EXPOSURE: the command and goal text appear in no reader's output, no /reach body and no log line
//
// Fixture from a fresh 5-word draw (draw-words.sh):
//   2026-10-29T23:46:26Z seed=1793317586533094107 words=trophy stimulus pacify resupply payee
// The index.ts cases run in a CHILD bun process with the reached-command store and the dispatch store pointed at a
// temp dir, so no live state file is ever written; fetch is stubbed there.
import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as RS from "../src/reached-command-store";
import * as PV from "../src/person-verdict";

const R = RS as Record<string, any>;
const P = PV as Record<string, any>;
const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
const GOAL = "Total the resupply payments due to each payee before the trophy stimulus round.";
const CMD = "awk -F, 'NR>1{t[$1]+=$2} END{for(k in t) print k, t[k]}' /tmp/resupply.csv";
const CHILD_TIMEOUT_MS = 60_000;

/** The walk's inline bank loop as it stands in index.ts, as an independent oracle for pickBankCandidate. */
function inlineLoop(commands: Array<[string, string]>, produced: Set<string>, goal: string, mode?: string) {
  for (const [sh, cmd] of commands) {
    if (typeof cmd === "string" && /\becho\b[^|;]*\\[nrt]/.test(cmd)) continue;
    if (mode !== "observe" && produced.has(sh) && typeof cmd === "string" && cmd.trim()) {
      const field = ["sql", "script", "cmd"].find((f) => new RegExp(`(^|[_-])${f}([_-]|$)`, "i").test(sh)) ?? "command";
      return { command: cmd, field, shape: sh, targetShapes: [...produced], goalText: goal };
    }
  }
  return null;
}

describe("the deterministic bank is unchanged", () => {
  it("[CONTROL] pickBankCandidate equals the walk's inline loop on every fixture (full toEqual)", () => {
    const cases: Array<[Array<[string, string]>, string[], string | undefined]> = [
      [[["shellResult", CMD]], ["goal", "shellResult"], undefined],
      [[["shellResult", 'echo "a\\nb"'], ["sql_query", "select 1"]], ["shellResult", "sql_query"], undefined],
      [[["notProduced", CMD], ["script_run", "  "], ["shellResult", CMD]], ["shellResult", "script_run"], undefined],
      [[["shellResult", CMD]], ["shellResult"], "observe"],
      [[["x_cmd_y", "ls"]], ["x_cmd_y"], "learn"],
      [[], ["shellResult"], undefined],
    ];
    for (const [cmds, prod, mode] of cases) {
      const skipped: string[] = [];
      expect(R["pickBankCandidate"]?.(cmds, new Set(prod), GOAL, mode, (s: string) => skipped.push(s)) ?? null).toEqual(inlineLoop(cmds, new Set(prod), GOAL, mode));
    }
    // the shell-dependent skip is reported in order, as the walk's tap was
    const skipped: string[] = [];
    R["pickBankCandidate"]?.([["shellResult", 'echo "a\\nb"'], ["sql_query", "select 1"]], new Set(["sql_query"]), GOAL, undefined, (s: string) => skipped.push(s));
    expect(skipped).toEqual(["shellResult"]);
  });

  it("[CONTROL] the walk's own bank site is the parent's, byte for byte; the judge-only capture is a separate block", () => {
    expect(SRC).toContain('const _field = ["sql", "script", "cmd"].find((f) => new RegExp(`(^|[_-])${f}([_-]|$)`, "i").test(sh)) ?? "command";');
    expect(SRC).toContain("reachedCommandCache.set(goalHashOf(goal), { command: cmd, field: _field, shape: sh, targetShapes: [...producedShapes], goalText: goal, basis: _bankBasis, strikes: 0 });");
    expect(SRC).toContain("persistReachedCommand(goalHashOf(goal), { command: cmd, field: _field, shape: sh, targetShapes: [...producedShapes], goalText: goal, basis: _bankBasis }); // durable known-command library");
    // the judge alone never banks: the capture block only records a candidate, never writes the library
    const cap = SRC.indexOf('if (!_bankBasis && reached && opts.learningMode !== "observe" && lastTrace?.id) {');
    expect(cap).toBeGreaterThan(0);
    const block = SRC.slice(cap, SRC.indexOf("\n    }\n", cap));
    expect(block).toContain("opts.bankCandidates?.set(lastTrace.id, _cand);");
    expect(block).not.toContain("persistReachedCommand(");
    expect(block).not.toContain("reachedCommandCache.set(");
  });
});

describe("the store and the bounds", () => {
  it("[CONTROL] provenance is additive: an old-format line and a provenance line both load", () => {
    const old = JSON.stringify({ hash: "h1", command: "ls", field: "command", shape: "shellResult", targetShapes: ["shellResult"], goalText: "g", basis: "deterministic" });
    const neu = JSON.stringify({ hash: "h2", command: "ls", field: "command", shape: "shellResult", targetShapes: ["shellResult"], goalText: "g", basis: "concurring", provenance: { decided_by: "person", label_execution_id: "e1" } });
    const { entries, applied } = RS.applyReachedCommandLines([old, neu]);
    expect(applied).toBe(2);
    expect(entries.get("h1")).toEqual({ command: "ls", field: "command", shape: "shellResult", targetShapes: ["shellResult"], goalText: "g", basis: "deterministic" });
    expect(entries.get("h2")).toEqual({ command: "ls", field: "command", shape: "shellResult", targetShapes: ["shellResult"], goalText: "g", basis: "concurring" });
  });

  it("[CONTROL] lastWordFor reads the loader's own rule", () => {
    const bank = JSON.stringify({ hash: "h", command: "ls", field: "command", shape: "s", basis: "concurring" });
    const tomb = JSON.stringify({ hash: "h", tombstone: true, reason: "x" });
    expect(R["lastWordFor"]?.([bank, tomb], "h")).toBe("tombstone");
    expect(R["lastWordFor"]?.([tomb, bank], "h")).toBe("bank");
    expect(R["lastWordFor"]?.([tomb, "not json", ""], "other")).toBeNull();
    // a bank line without a basis is not a bank (the loader does not replay it)
    expect(R["lastWordFor"]?.([JSON.stringify({ hash: "h", command: "ls", field: "command", shape: "s" })], "h")).toBeNull();
  });

  it("[CONTROL] an oversize command is not carried; the bounds hold", () => {
    const big = { command: "x".repeat(4_001), field: "command", shape: "shellResult", targetShapes: [], goalText: GOAL };
    expect(P["boundBankCandidate"]?.(big) ?? null).toBeNull();
    const b = P["boundBankCandidate"]?.({ command: CMD, field: "command", shape: "shellResult", targetShapes: Array.from({ length: 40 }, (_, i) => `s${i}`), goalText: "g".repeat(3_000) });
    expect(b?.targetShapes.length).toBe(32);
    expect(b?.goalText.length).toBe(2_000);
    expect(b?.command).toBe(CMD);
    // expiry clears the candidate
    const d = P["openDeferral"]?.({ executionId: "e", completionShapes: [], reason: null, goalHash: "g", betaWithheldReason: null, bank: b }, 0);
    expect(P["expireDeferral"]?.(d, 1)).toBe(true);
    expect(d?.bank ?? null).toBeNull();
  });
});

type Out = Record<string, any>;
function probe(): Out {
  const dir = mkdtempSync(join(tmpdir(), "pv-bank-"));
  try {
    const p = join(dir, "probe.test.ts");
    const src = (f: string) => JSON.stringify(join(import.meta.dir, "..", "src", f));
    const store = join(dir, "reached.jsonl");
    writeFileSync(p, `
      import { test } from "bun:test";
      import { readFileSync, writeFileSync, appendFileSync, statSync, existsSync } from "node:fs";
      test("probe", async () => {
        const m = await import(${src("index.ts")});
        const pv = await import(${src("person-verdict.ts")});
        const consumer = await import(${src("oracle-label-consumer.ts")});
        const STORE = ${JSON.stringify(store)};
        const CMD = ${JSON.stringify(CMD)}, GOAL = ${JSON.stringify(GOAL)};
        const logs = []; const ol = console.log, ow = console.warn;
        console.log = (...a) => logs.push(a.map(String).join(" ")); console.warn = (...a) => logs.push(a.map(String).join(" "));
        const fetched = [];
        globalThis.fetch = (async (u, init) => { fetched.push(String(u) + " " + String(init?.body ?? "")); return new Response(JSON.stringify({ updated: 1, error: "not served" }), { status: String(u).includes("/reach") ? 200 : 404, headers: { "Content-Type": "application/json" } }); });
        const cache = m.__reachedCommandCacheForTests();
        const lines = () => existsSync(STORE) ? readFileSync(STORE, "utf8").split("\\n").filter(Boolean) : [];
        const mark = () => existsSync(STORE) ? statSync(STORE).size : 0;
        const cand = { command: CMD, field: "command", shape: "shellResult", targetShapes: ["goal", "shellResult"], goalText: GOAL };
        const rec = (hash, mode, id) => ({ dispatchId: "d-" + id, status: "completed", executionId: "exec-" + id, goal: GOAL, reached: true, goalReachReason: "judge: fine", learning: { oracleLabelWritten: false },
          deferredReach: pv.openDeferral({ executionId: "exec-" + id, completionShapes: ["shellResult"], reason: "judge: fine", goalHash: hash, betaWithheldReason: null, learningMode: mode, bank: pv.boundBankCandidate(cand), bankStoreMark: mark() }, Date.now()) });
        const person = (verdict) => ({ verdict, labeler: "human", labeled_by_principal: { user_id: "person-1", caller_type: "session" } });
        const labelFetch = (rows) => (async () => new Response(JSON.stringify({ success: true, content: JSON.stringify(rows) }), { status: 200 }));
        const decide = async (r, rows) => consumer.consumeOracleLabel(r, { activityApiEndpoint: "http://act.test", devVesselEndpoint: "http://dev.test", apiKey: "", fetchImpl: labelFetch(rows), decideDeferredReach: (_x, d) => m.decideDeferredReach(r, d) });
        const settle = () => new Promise((res) => setTimeout(res, 60));
        const out = {};
        // MF: person achieved banks
        let r = rec("hash-a", "learn", "a"); await decide(r, [person("achieved")]); await settle();
        out.achieved = { entry: cache.get("hash-a") ?? null, lines: lines().map((l) => JSON.parse(l)).filter((l) => l.hash === "hash-a"), bankAfter: r.deferredReach.bank ?? null };
        // second label: no second bank
        await decide(r, [person("achieved"), person("achieved")]); await settle();
        out.second = lines().filter((l) => JSON.parse(l).hash === "hash-a").length;
        // not achieved / partial: nothing, cleared
        r = rec("hash-b", "learn", "b"); await decide(r, [person("not_achieved")]); await settle();
        out.notAchieved = { has: cache.has("hash-b"), bank: r.deferredReach.bank ?? null };
        r = rec("hash-c", "learn", "c"); await decide(r, [person("partial")]); await settle();
        out.partial = { has: cache.has("hash-c"), bank: r.deferredReach.bank ?? null };
        // observe: nothing
        r = rec("hash-d", "observe", "d"); await decide(r, [person("achieved")]); await settle();
        out.observe = { has: cache.has("hash-d"), lines: lines().filter((l) => JSON.parse(l).hash === "hash-d").length };
        // no overwrite: a deterministic entry made in the interim stays
        r = rec("hash-e", "learn", "e");
        const det = { command: "ls -1 | wc -l", field: "command", shape: "shellResult", targetShapes: ["shellResult"], goalText: "other", basis: "deterministic", strikes: 0 };
        cache.set("hash-e", { ...det });
        await decide(r, [person("achieved")]); await settle();
        out.noOverwrite = { entry: cache.get("hash-e"), lines: lines().filter((l) => JSON.parse(l).hash === "hash-e").length };
        // tombstone written after the walk: not resurrected
        r = rec("hash-f", "learn", "f");
        appendFileSync(STORE, JSON.stringify({ hash: "hash-f", tombstone: true, reason: "reach graded false" }) + "\\n");
        await decide(r, [person("achieved")]); await settle();
        out.tombAfter = { has: cache.has("hash-f"), banks: lines().filter((l) => { const j = JSON.parse(l); return j.hash === "hash-f" && !j.tombstone; }).length };
        // a tombstone BEFORE the walk does not block (a fresh concurring reach re-banks, as the store allows)
        appendFileSync(STORE, JSON.stringify({ hash: "hash-g", tombstone: true, reason: "old" }) + "\\n");
        r = rec("hash-g", "learn", "g"); await decide(r, [person("achieved")]); await settle();
        out.tombBefore = { has: cache.has("hash-g") };
        // exposure: the command and goal text in no log line and no /reach body
        console.log = ol; console.warn = ow;
        out.logLeak = logs.filter((l) => l.includes(CMD) || l.includes(GOAL)).length;
        out.logs = logs.filter((l) => l.includes("person bank") || l.includes("bank candidate")).slice(0, 12);
        out.reachLeak = fetched.filter((f) => f.includes("/reach") && (f.includes(CMD) || f.includes(GOAL))).length;
        out.reachCount = fetched.filter((f) => f.includes("/reach")).length;
        process.stdout.write("RESULT " + JSON.stringify(out) + "\\n");
      });
    `);
    const r = Bun.spawnSync([process.execPath, "test", p], {
      cwd: dir,
      env: { HOME: process.env.HOME ?? "/tmp", PATH: process.env.PATH ?? "", NODE_ENV: "test", LLM_VESSEL_ENDPOINT: "http://llm.test.invalid",
        REACHED_CMD_CACHE_PATH: store, GOAL_HOST_DISPATCH_STORE_PATH: join(dir, "dispatches.json"), WORKSPACE_ROOT: dir, ACTIVITY_API_ENDPOINT: "http://act.test", DEV_VESSEL_ENDPOINT: "http://dev.test", DISCOVERY_VESSEL_ENDPOINT: "http://127.0.0.1:9" },
      stdout: "pipe", stderr: "pipe",
    });
    const line = r.stdout.toString().split("\n").find((l) => l.startsWith("RESULT "));
    if (!line) throw new Error(`probe produced no result: ${r.stderr.toString().slice(-2000)}`);
    return JSON.parse(line.slice("RESULT ".length));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("a person's verdict banks a deferred judge-only reach (index.ts, child process)", () => {
  let o: Out;
  beforeAll(() => { o = probe(); }, CHILD_TIMEOUT_MS);

  it("[MUST-FAIL] a person achieved banks the candidate, basis concurring, with the person's provenance", () => {
    expect(o.achieved.entry).toEqual({ command: CMD, field: "command", shape: "shellResult", targetShapes: ["goal", "shellResult"], goalText: GOAL, basis: "concurring", strikes: 0 });
    expect(o.achieved.lines).toEqual([{ hash: "hash-a", command: CMD, field: "command", shape: "shellResult", targetShapes: ["goal", "shellResult"], goalText: GOAL, basis: "concurring", provenance: { decided_by: "person", label_execution_id: "exec-a" } }]);
    expect(o.achieved.bankAfter).toBeNull();
  });
  it("[CONTROL] a second person label is a no-op", () => { expect(o.second).toBe(1); });
  it("[CONTROL] not achieved and partial bank nothing and clear the candidate", () => {
    expect(o.notAchieved).toEqual({ has: false, bank: null });
    expect(o.partial).toEqual({ has: false, bank: null });
  });
  it("[CONTROL] observe never banks", () => { expect(o.observe).toEqual({ has: false, lines: 0 }); });
  it("[CONTROL] NO OVERWRITE: the entry the goal already had stays, no line appended", () => {
    expect(o.noOverwrite.entry).toEqual({ command: "ls -1 | wc -l", field: "command", shape: "shellResult", targetShapes: ["shellResult"], goalText: "other", basis: "deterministic", strikes: 0 });
    expect(o.noOverwrite.lines).toBe(0);
  });
  it("[CONTROL] TOMBSTONES: one written after the walk is not resurrected; an earlier one does not block", () => {
    expect(o.tombAfter).toEqual({ has: false, banks: 0 });
    expect(o.tombBefore).toEqual({ has: true });
  });
  it("[CONTROL] EXPOSURE: the command and goal text appear in no log line and no /reach body; logs name length and shape", () => {
    expect(o.logLeak).toBe(0);
    expect(o.reachLeak).toBe(0);
    expect(o.reachCount).toBeGreaterThan(0);
    expect(o.logs.some((l: string) => /person bank APPLIED .*shape=shellResult command_len=\d+ basis=concurring/.test(l))).toBe(true);
  });
  it("[CONTROL] EXPOSURE: no reader serves the deferral (GET /executions/:id and goalWalkState are built key by key)", () => {
    const ex = SRC.slice(SRC.indexOf('if (req.method === "GET" && url.pathname.startsWith("/executions/")) {'));
    const exBody = ex.slice(0, ex.indexOf("\n      });\n"));
    expect(exBody.length).toBeGreaterThan(200);
    expect(exBody).not.toContain("deferredReach");
    expect(exBody).not.toContain("...record");
    const ws = SRC.slice(SRC.indexOf('shape: "goalWalkState",\n      body: { dispatchId: rec.dispatchId'));
    expect(ws.slice(0, 2000)).not.toContain("deferredReach");
    // the walk-end lines name length and shape only
    expect(SRC).toContain("shape=${record.deferredReach.bank.shape} command_len=${record.deferredReach.bank.command.length}");
    expect(SRC).not.toMatch(/\$\{[^}]*bank\.command\}/);
    expect(SRC).not.toMatch(/\$\{[^}]*bank\.goalText/);
    // the deferral's compact trace copy (deferral-row.ts) is never served or logged either: no reader names it, and no
    // template literal interpolates it
    expect(exBody).not.toContain("reinsert");
    expect(ws.slice(0, 2000)).not.toContain("reinsert");
    expect(SRC).not.toMatch(/\$\{[^}]*\.reinsert\b[^}]*\}/);
    expect(SRC).not.toMatch(/\$\{[^}]*_reinsertCopy[^}]*\}/);
  });
});
