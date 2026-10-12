// THE CORPUS RUNNER PUBLISHES UNDER ITS OWN IDENTITY (src/judge/corpus-publish.ts). goal-host's process-wide key
// goes out on every walk egress, so it must not be the credential development-vessel's runner grant admits for the
// verdictCorpusStatus write. Pinned here:
//   (1) the publish sends the runner's key, never the process-wide key, read at use time;
//   (2) an absent or empty runner key refuses before any request (no fallback to the process-wide key);
//   (3) a refusal by development-vessel still throws (the runner reports itself failed: the existing hold path);
//   (4) the walk has no edge to the runner key: only the publish module reads it, only the runner sink calls it.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { CORPUS_RUNNER_KEY_MISSING, CORPUS_RUNNER_PRINCIPAL, CORPUS_RUNNER_SCOPES, publishVerdictCorpusStatusAsRunner } from "../src/judge/corpus-publish";
import type { VerdictCorpusStatus } from "../src/judge/credit-hold";

const REPO = join(import.meta.dir, "..");
const SRC_DIR = join(REPO, "src");
const ENV_NAME = "GOAL_HOST_CORPUS_RUNNER_API_KEY";
const MAIN_KEY_NAMES = ["GOAL_HOST_VESSEL_API_KEY", "METABOB_API_KEY"];

const status = { schema: 1, node: "n", judge_sha: "j", deployed_sha: null, corpus: { n: 1, link: "l" }, fidelity: {}, run_at: "2026-01-01T00:00:00.000Z", period_s: 21600, ever_green: "present", state: "ok", green: [], flips: [], known_red: [], entry_missing: [], holds: [], live_shadow: { sampled: 0, mismatched: 0 } } as VerdictCorpusStatus;

let calls: Array<{ url: string; auth: string | null; body: any }> = [];
let answer: () => Response = () => new Response(JSON.stringify({ success: true, shape: "poolImpulse_write", body: { ok: true, id: "verdictCorpusStatus" } }), { status: 200 });
let refreshes = 0;
const deps = { devVesselEndpoint: "http://dv.test", refresh: async () => { refreshes++; return { ok: true }; } };
const realFetch = globalThis.fetch;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  calls = []; refreshes = 0;
  answer = () => new Response(JSON.stringify({ success: true, shape: "poolImpulse_write", body: { ok: true, id: "verdictCorpusStatus" } }), { status: 200 });
  for (const n of [ENV_NAME, ...MAIN_KEY_NAMES]) saved[n] = process.env[n];
  for (const n of MAIN_KEY_NAMES) process.env[n] = "main-process-key";
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    calls.push({ url: String(url), auth: h.get("Authorization"), body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    return answer();
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [n, v] of Object.entries(saved)) { if (v === undefined) delete process.env[n]; else process.env[n] = v; }
});

async function outcome(): Promise<string> {
  try { await publishVerdictCorpusStatusAsRunner(status, deps); return "published"; } catch (e) { return `threw: ${(e as Error).message}`; }
}

describe("(1) the publish uses the runner's own credential", () => {
  it("MUST-FAIL: Authorization is the runner key, never the process-wide key; the write is the status row", async () => {
    process.env[ENV_NAME] = "runner-key-1";
    expect(await outcome()).toBe("published");
    expect(calls.length).toBe(1);
    expect(calls[0]!.auth).toBe("ApiKey runner-key-1");
    expect(calls.map((c) => c.auth)).not.toContain("ApiKey main-process-key");
    expect(calls[0]!.url).toBe("http://dv.test/v2/impulses/resolve");
    expect(calls[0]!.body.impulse.pointer).toMatchObject({ type: "poolImpulse_write", id: "verdictCorpusStatus", shape: "verdictCorpusStatus", source: "verdictCorpusRun", status: "open" });
    expect(refreshes).toBe(1);
  });

  it("MUST-FAIL: the key is read at use time, on every publish (a rotated key is used at once)", async () => {
    process.env[ENV_NAME] = "runner-key-a";
    await outcome();
    process.env[ENV_NAME] = "runner-key-b";
    await outcome();
    expect(calls.map((c) => c.auth)).toEqual(["ApiKey runner-key-a", "ApiKey runner-key-b"]);
  });

  it("names the principal and its one scope", () => {
    expect(CORPUS_RUNNER_PRINCIPAL).toBe("goal-host-corpus-runner");
    expect([...CORPUS_RUNNER_SCOPES]).toEqual(["verdict-corpus:write"]);
  });
});

describe("(2) an absent runner key refuses before any request", () => {
  for (const [label, value] of [["absent", undefined], ["empty", ""], ["blank", "   "]] as const) {
    it(`MUST-FAIL: ${label} → "${CORPUS_RUNNER_KEY_MISSING}", no request, no fallback to the process-wide key`, async () => {
      if (value === undefined) delete process.env[ENV_NAME]; else process.env[ENV_NAME] = value;
      expect(await outcome()).toBe(`threw: verdictCorpusStatus not published: ${CORPUS_RUNNER_KEY_MISSING}`);
      expect(calls.length).toBe(0);
      expect(refreshes).toBe(0);
    });
  }
});

describe("(3) a refusal by development-vessel still throws", () => {
  it("403 → throws with the status; unconfirmed 200 → throws; nothing is read back", async () => {
    process.env[ENV_NAME] = "runner-key-1";
    answer = () => new Response(JSON.stringify({ success: false, error: "runner_principal_required: x" }), { status: 403 });
    expect(await outcome()).toBe("threw: verdictCorpusStatus not published: HTTP 403 runner_principal_required: x");
    answer = () => new Response(JSON.stringify({ success: true, body: { ok: false } }), { status: 200 });
    expect(await outcome()).toBe("threw: verdictCorpusStatus not published: development-vessel did not confirm the write");
    expect(refreshes).toBe(0);
  });
});

// ── (4) static edges ─────────────────────────────────────────────────────────────────────────────────────────
function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n)) out.push(p);
  }
  return out;
}
const files = srcFiles(SRC_DIR).map((p) => ({ rel: relative(REPO, p), text: readFileSync(p, "utf8") }));
const indexSrc = files.find((f) => f.rel === join("src", "index.ts"))!.text;
const pubSrc = files.find((f) => f.rel === join("src", "judge", "corpus-publish.ts"))!.text;

describe("(4) the walk has no edge to the runner key", () => {
  it("MUST-FAIL: the runner key's env name is read in exactly one src file, the publish module", () => {
    expect(files.filter((f) => f.text.includes(ENV_NAME)).map((f) => f.rel)).toEqual([join("src", "judge", "corpus-publish.ts")]);
  });

  it("MUST-FAIL: only index.ts's runner publish imports the module, and only the runner sink calls that publish", () => {
    expect(files.filter((f) => f.text.includes("corpus-publish")).map((f) => f.rel)).toEqual([join("src", "index.ts")]);
    const fnStart = indexSrc.indexOf("async function publishVerdictCorpusStatus(");
    const fnEnd = indexSrc.indexOf("\n}\n", fnStart);
    expect(fnStart).toBeGreaterThan(0);
    const fn = indexSrc.slice(fnStart, fnEnd);
    const imp = 'import("./judge/corpus-publish")';
    expect(indexSrc.split(imp).length - 1).toBe(1);
    expect(fn).toContain(imp);
    expect(/from "\.\/judge\/corpus-publish"/.test(indexSrc)).toBe(false);
    expect(indexSrc.split("publishVerdictCorpusStatusAsRunner").length - 1).toBe(fn.split("publishVerdictCorpusStatusAsRunner").length - 1);
    // the definition, and one call: the runner's writeStatus sink
    const callers = [...indexSrc.matchAll(/publishVerdictCorpusStatus\(/g)].map((m) => m.index!);
    expect(callers.length).toBe(2);
    const run = indexSrc.slice(indexSrc.indexOf("async function runVerdictCorpusNow("), indexSrc.indexOf("async function handleResolve("));
    expect(run).toContain("writeStatus: async (st) => { await publishVerdictCorpusStatus(st);");
    const walk = indexSrc.slice(indexSrc.indexOf("const rawResolve = async (shape: string"), indexSrc.indexOf("const refuseReapply = (shape: string, site: string)"));
    expect(walk.length).toBeGreaterThan(0);
    for (const needle of [ENV_NAME, "corpus-publish", "publishVerdictCorpusStatus", "runnerKey"]) expect(walk.includes(needle)).toBe(false);
  });

  it("MUST-FAIL: the publish module never exports, returns or logs the key, and imports nothing but the status record's constants", () => {
    expect([...pubSrc.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1])).toEqual(["./credit-hold"]);
    expect([...pubSrc.matchAll(/^export (?:const|async function|function|interface|type|class) (\w+)/gm)].map((m) => m[1]).sort()).toEqual(
      ["CORPUS_RUNNER_KEY_MISSING", "CORPUS_RUNNER_PRINCIPAL", "CORPUS_RUNNER_SCOPES", "CorpusPublishDeps", "publishVerdictCorpusStatusAsRunner"].sort());
    const uses = pubSrc.split("\n").filter((l) => /\brunnerKey\b/.test(l)).map((l) => l.trim());
    expect(uses).toEqual([
      `const runnerKey = process.env.${ENV_NAME} ?? "";`,
      "if (runnerKey.trim().length === 0) {",
      "headers: { \"Content-Type\": \"application/json\", Authorization: `ApiKey ${runnerKey.trim()}` },",
    ]);
    expect(pubSrc).not.toMatch(/\bAPI_KEY\b(?!\s*")/);
    expect(pubSrc).not.toContain("GOAL_HOST_VESSEL_API_KEY");
    expect(pubSrc).not.toContain("METABOB_API_KEY");
  });
});
