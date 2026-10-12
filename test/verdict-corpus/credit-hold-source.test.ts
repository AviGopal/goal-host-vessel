// PROTECTED: where the credit stop's holds come from (M11, the read side). The status is the
// verdictCorpusStatus record in development-vessel's pool, which only goal-host's own principal can write (dev-vessel
// pool-impulse.ts, the runner grant) and which dev-vessel's open read marks attested_verified under the runner's
// stamp. The credit stop adopts only such a row, keeps it as the last good copy, and reads it synchronously.
//   - a status file goal-host writes (or any module in its process writes) is a cache and never a hold source;
//   - a last good copy not refreshed for STALE_REFRESH_TICKS ticks is missing (ever-red classes only, one report);
//   - an unverified, retired or malformed pool row is no status;
//   - the runner publishes through the grant with goal-host's own credential and carries holds forward from the pool.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configureCreditHold, readEverGreenSync, currentHolds, heldFor, lastVerifiedStatus, readStatusSync, refreshStatusFromPool, statusFromPoolRead,
  DEPLOYED_CORPUS_DIR, HOLD_CACHE_TTL_MS, REFRESH_TICK_MS, STALE_REFRESH_TICKS, STATUS_ID, STATUS_SHAPE,
} from "../../src/judge/credit-hold";
import { shapedPolicyPath } from "../../src/shaped-policy-store";
import { everRedCases, loadCorpus } from "./runner";

const DIR = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(DIR, "..", "..", "src", "index.ts"), "utf8");
const NOW = Date.parse("2026-10-12T12:00:00Z");
const everRed = everRedCases(loadCorpus(DIR).cases, null);
const RED = everRed[0]!;
/** A class no corpus case has ever been red for (held only by a status that says so). */
const FRESH_CLASS = "walk:read-target";
const hold = (credit_class: string, direction: "reach" | "hollow") => ({ credit_class, direction, case_ids: ["0001-x"], since: "2026-10-12T00:00:00Z", review_by: "2026-10-15T00:00:00Z" });
const body = (holds: unknown[]) => ({ schema: 1, node: "t", run_at: new Date(NOW - 60_000).toISOString(), period_s: 21600, state: "ok", holds });
const poolRead = (rowOver: Record<string, unknown> = {}, b: unknown = body([hold(FRESH_CLASS, "reach")])) => ({ success: true, shape: "poolImpulse", body: { count: 1, impulses: [{ id: STATUS_ID, shape: STATUS_SHAPE, status: "open", source: "verdictCorpusRun", body: b, attested: { by: "runner", key_id: "k-runner", at: "x", sig: "s" }, attested_verified: true, ...rowOver }] } });

let t = NOW;
let next: () => Promise<unknown> = async () => poolRead();
const reports: string[] = [];
beforeEach(() => {
  t = NOW; reports.length = 0; next = async () => poolRead();
  configureCreditHold({ reader: readStatusSync, clock: () => t, corpusDir: DIR, everGreen: () => null, onUnavailable: (why) => reports.push(why), poolFetcher: () => next(), onRefreshed: () => {}, resetPoolCopy: true });
});
// Restore every seam this file set (bun shares module state across files in one run): no fetcher stays armed.
afterAll(() => configureCreditHold({ reader: readStatusSync, corpusDir: DEPLOYED_CORPUS_DIR, clock: () => Date.now(), everGreen: () => readEverGreenSync(), onUnavailable: () => {}, resetPoolCopy: true }));

describe("statusFromPoolRead (pure): only a runner-verified open row is a status", () => {
  test("a verified open row with a readable body is the status", () => {
    expect(statusFromPoolRead(poolRead()).status).toEqual(body([hold(FRESH_CLASS, "reach")]));
  });
  test("MUST-FAIL: unverified, operator-stamped, unstamped, retired, wrong id or malformed rows are no status", () => {
    for (const r of [poolRead({ attested_verified: false }), poolRead({ attested: { by: "operator" } }), poolRead({ attested: undefined }), poolRead({ status: "retired" }), poolRead({ id: "other" }), poolRead({}, { holds: "none", run_at: "x" }), { body: { impulses: [] } }, null]) {
      expect(statusFromPoolRead(r).status).toBeNull();
    }
  });
});

describe("M11 read side: the file is never a hold source", () => {
  test("MUST-FAIL: a forged local status file saying 'no holds' is ignored: with no pool record the ever-red class stays held", async () => {
    const p = shapedPolicyPath(STATUS_SHAPE);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ ...body([]), run_at: new Date(NOW).toISOString() }));
    next = async () => ({ body: { impulses: [] } });
    await refreshStatusFromPool();
    const v = currentHolds();
    expect(v.source).toBe("unreadable");
    const h = v.holds.find((x) => x.credit_class === RED.credit_class);
    expect(h).toBeDefined();
    expect(heldFor([RED.credit_class], h!.direction, "t")).not.toBeNull();
    expect(reports.length).toBe(1);
    expect(reports[0]).toContain("status record missing");
  });
  test("MUST-FAIL: a forged 'no holds' file beside a verified pool record changes nothing: the pool's holds apply", async () => {
    const p = shapedPolicyPath(STATUS_SHAPE);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ ...body([]), run_at: new Date(NOW).toISOString() }));
    await refreshStatusFromPool();
    expect(currentHolds().source).toBe("status");
    expect(heldFor([FRESH_CLASS], "reach", "t")).not.toBeNull();
  });
  test("an unverified pool row is not adopted (the last good copy stays)", async () => {
    await refreshStatusFromPool();
    next = async () => poolRead({ attested_verified: false }, body([]));
    expect((await refreshStatusFromPool()).ok).toBe(false);
    expect(readStatusSync()).toEqual(body([hold(FRESH_CLASS, "reach")]));
  });
});

describe("the last good copy ages by refresh ticks", () => {
  test("positive control: a copy younger than STALE_REFRESH_TICKS ticks reads its holds while the pool is unreachable", async () => {
    await refreshStatusFromPool();
    next = async () => { throw new Error("connect ECONNREFUSED"); };
    t = NOW + (STALE_REFRESH_TICKS - 1) * REFRESH_TICK_MS;
    await refreshStatusFromPool();
    const v = currentHolds();
    expect(v.source).toBe("status");
    expect(heldFor([FRESH_CLASS], "reach", "t")).not.toBeNull();
    expect(reports).toEqual([]);
  });
  test("MUST-FAIL: a copy past STALE_REFRESH_TICKS ticks is missing: only ever-red classes are held, reported once", async () => {
    await refreshStatusFromPool();
    next = async () => { throw new Error("connect ECONNREFUSED"); };
    t = NOW + (STALE_REFRESH_TICKS + 1) * REFRESH_TICK_MS;
    await refreshStatusFromPool();
    expect(readStatusSync()).toBeNull();
    const v = currentHolds();
    expect(v.source).toBe("unreadable");
    expect(new Set(v.holds.map((h) => h.credit_class))).toEqual(new Set(everRed.map((c) => c.credit_class)));
    expect(heldFor([FRESH_CLASS], "reach", "t")).toBeNull();
    t += HOLD_CACHE_TTL_MS + 1; currentHolds();
    expect(reports.length).toBe(1);
    expect(reports[0]).toContain("past 5 refresh ticks");
    // the runner still carries holds forward from the last verified copy, whatever its age
    expect(lastVerifiedStatus()).toEqual(body([hold(FRESH_CLASS, "reach")]));
  });
  test("a credit site never reads the pool itself: only the refresher does (the walk's call order is unchanged)", async () => {
    let calls = 0;
    next = async () => { calls++; return poolRead(); };
    currentHolds(); t += REFRESH_TICK_MS * 2; currentHolds(); heldFor([FRESH_CLASS], "reach", "t");
    expect(calls).toBe(0);
    await refreshStatusFromPool();
    expect(calls).toBe(1);
    t += HOLD_CACHE_TTL_MS + 1;
    expect(heldFor([FRESH_CLASS], "reach", "t")).not.toBeNull();
  });
});

describe("index.ts wiring: the runner publishes through the grant and never reads the file back", () => {
  test("MUST-FAIL: the status sink publishes a poolImpulse_write of the status id with the run's source under the runner's own key", () => {
    const fn = SRC.slice(SRC.indexOf("async function publishVerdictCorpusStatus("), SRC.indexOf("async function runVerdictCorpusNow("));
    expect(fn.length).toBeGreaterThan(0);
    // The write lives in the closed publish module (judge/corpus-publish.ts), under the runner's credential; the
    // process-wide key is never used for it (test/corpus-runner-identity.test.ts pins the credential by effect).
    expect(fn).toContain('await import("./judge/corpus-publish")');
    expect(fn).toContain("await publishVerdictCorpusStatusAsRunner(st, { devVesselEndpoint: DEV_VESSEL_ENDPOINT, refresh: () => creditHold.refreshStatusFromPool() });");
    expect(fn).not.toContain("API_KEY");
    const pub = readFileSync(join(DIR, "..", "..", "src", "judge", "corpus-publish.ts"), "utf8");
    expect(pub).toContain('type: "poolImpulse_write", id: STATUS_ID, shape: STATUS_SHAPE, source: STATUS_SOURCE');
    expect(pub).toContain("Authorization: `ApiKey ${runnerKey.trim()}`");
    expect(pub).toContain("throw new Error(");
    const run = SRC.slice(SRC.indexOf("async function runVerdictCorpusNow("), SRC.indexOf("async function handleResolve("));
    expect(run).toContain("writeStatus: async (st) => { await publishVerdictCorpusStatus(st);");
    expect(run).toContain("readPreviousStatus: async () => { await creditHold.refreshStatusFromPool(); return creditHold.lastVerifiedStatus(); }");
    expect(run).not.toContain("resolveShapedPolicy(");
    expect(run).not.toContain("writeStatusFile(");
  });
  test("MUST-FAIL: the hold reader is the pool copy, refreshed on its tick; no hold path reads the status file", () => {
    expect(SRC).toContain("poolFetcher: async () =>");
    expect(SRC).toContain("setInterval(() => { void creditHold.refreshStatusFromPool(); }, creditHold.REFRESH_TICK_MS)");
    expect(SRC).not.toMatch(/reader:\s*(creditHold\.)?readStatusCacheFileSync/);
    expect(SRC).not.toMatch(/resolveShapedPolicy\(\s*(creditHold\.)?STATUS_SHAPE/);
    const hold = readFileSync(join(DIR, "..", "..", "src", "judge", "credit-hold.ts"), "utf8");
    expect(hold).toMatch(/let reader: Reader = readStatusSync;/);
    const fnBody = hold.slice(hold.indexOf("export function readStatusSync("), hold.indexOf("export function readStatusCacheFileSync("));
    expect(fnBody).not.toContain("readFileSync");
  });
});
