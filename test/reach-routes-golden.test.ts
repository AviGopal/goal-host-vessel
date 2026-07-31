// GOLDEN CHARACTERIZATION TEST for the deterministic reach-route family (route-as-data refactor).
//
// PURPOSE: lock the CURRENT observable behavior of the legacy reach routes BEFORE and AFTER the
// route-as-data migration, so a migration that changes a command string, a verdict string, an
// ownership decision, or a selector's arithmetic FAILS here instead of silently greening a wrong
// value or fail-closing a correct one.
//
// FS NOTE: the legacy verify*Reach oracles read /workspace/git/super-repo (the in-container git
// clone), which does not exist in a bare checkout. So this test locks the FS-FREE projections that
// fully determine their behavior: (1) the build*Command STRINGS, (2) the ownership/routing order
// (which parse owns each goal — the known collisions), (3) emitVerdict's three-verdict shape +
// exact reason strings (the tail every verify*Reach shares), and (4) the SELECTORS arithmetic
// (the head every verify*Reach shares). Live end-to-end confirmation (e.g. avg-threshold == 79)
// is an operator dispatch after landing.
//
// IMPORT NOTE: src/index.ts guards its HTTP boot behind import.meta.main, and createLLMPort needs
// an LLM endpoint present (a lazy HttpLLMPort — no connection is opened). We set the env, then
// dynamic-import so evaluation happens after the env is set. No port is bound, nothing registers
// into discovery.
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

process.env.LLM_VESSEL_ENDPOINT ??= "http://127.0.0.1:65535";
const idx: any = await import("../src/index.ts");
const {
  buildAggregateCommand, buildRankAggregateCommand, buildAvgThresholdCommand, buildTwoSourceCompareCommand,
  parseAggregateGoal, parseRankAggregate, parseAvgThreshold, parseTwoSourceCompare, parseBelowMean,
  SELECTORS, emitVerdict, parsePathsAndExt, ROW_AVG_THRESHOLD, ROW_BELOW_MEAN, CLASS_ROWS,
  resolveClassRow, buildFromClassRow, enumerate, selectorOf, thresholdSelector, parseThreshold,
} = idx;

// The dispatch chain exactly as wired in index.ts (_aggCmd, ~line 3909): avg-threshold, then
// two-source, then rank, then aggregate. The first non-null wins — this ordering IS the routing.
const chain = (g: string): string | null =>
  buildAvgThresholdCommand(g) ?? buildTwoSourceCompareCommand(g) ?? buildRankAggregateCommand(g) ?? buildAggregateCommand(g);
const owner = (g: string): string =>
  buildAvgThresholdCommand(g) ? "avgThreshold"
  : buildTwoSourceCompareCommand(g) ? "twoSource"
  : buildRankAggregateCommand(g) ? "rank"
  : buildAggregateCommand(g) ? "aggregate" : "none";

// ── the fixed corpus: everyday goals + the KNOWN OWNERSHIP COLLISIONS the routing must resolve.
interface GoldenCase { goal: string; owner: string; cmd: string; parse: { avgThr: boolean; rank: boolean; agg: boolean; two: boolean } }
const CORPUS: Record<string, GoldenCase> = {
  // COLLISION: "total lines" + "3 largest" => RANK (top-3 sum 7767), NOT total_lines (8708). Locks
  // that parseRankAggregate is consulted before parseAggregateGoal (isCompositionalGoal bails agg).
  RANK_SUM: {
    goal: "total lines in the 3 largest .ts files under repos/goal-host-vessel/src",
    owner: "rank",
    cmd: "find /workspace/git/super-repo/repos/goal-host-vessel/src -type f -name '*.ts' -exec wc -l {} + | grep -v ' total$' | sort -rn | head -3 | awk '{s+=$1}END{print s+0}'",
    parse: { avgThr: false, rank: true, agg: false, two: false },
  },
  // COLLISION: "how many .ts files ... more lines than the average" => AVG-THRESHOLD (79), NOT a
  // plain file-count. Locks that parseAvgThreshold wins the "how many files" phrasing.
  AVG_THRESH: {
    goal: "how many .ts files under repos/development-vessel/src/resolvers have more lines than the average",
    owner: "avgThreshold",
    cmd: "find /workspace/git/super-repo/repos/development-vessel/src/resolvers -type f -name '*.ts' -exec wc -l {} + | grep -v ' total$' | awk '{s+=$1;c[NR]=$1;n++}END{if(n==0){print 0;exit}avg=s/n;k=0;for(i=1;i<=n;i++)if(c[i]>avg)k++;print k}'",
    parse: { avgThr: true, rank: false, agg: false, two: false },
  },
  // COLLISION: "average lines across the top 5 .ts files" => RANK-AVG (1870). Locks rank owns the
  // "top N" + average combination (isCompositionalGoal bails agg).
  RANK_AVG: {
    goal: "average lines across the top 5 .ts files under repos/development-vessel/src/resolvers",
    owner: "rank",
    cmd: "find /workspace/git/super-repo/repos/development-vessel/src/resolvers -type f -name '*.ts' -exec wc -l {} + | grep -v ' total$' | sort -rn | head -5 | awk '{s+=$1;c++}END{if(c>0)printf \"%d\\n\",(s+int(c/2))/c; else print 0}'",
    parse: { avgThr: false, rank: true, agg: false, two: false },
  },
  // plain total_lines => aggregate
  TOTAL: {
    goal: "total lines in .ts files under repos/goal-host-vessel/src",
    owner: "aggregate",
    cmd: "find /workspace/git/super-repo/repos/goal-host-vessel/src -type f -name '*.ts' -exec cat {} + | wc -l",
    parse: { avgThr: false, rank: false, agg: true, two: false },
  },
  // plain avg_lines => aggregate
  AVG: {
    goal: "average lines per .ts file under repos/goal-host-vessel/src",
    owner: "aggregate",
    cmd: "T=$(find /workspace/git/super-repo/repos/goal-host-vessel/src -type f -name '*.ts' -exec cat {} + | wc -l); N=$(find /workspace/git/super-repo/repos/goal-host-vessel/src -type f -name '*.ts' | wc -l); if [ \"$N\" -gt 0 ]; then echo $(( (T + N/2) / N )); else echo \"no matching files\"; fi",
    parse: { avgThr: false, rank: false, agg: true, two: false },
  },
  // plain file-count => aggregate's file-count fallback (parseAggregateGoal is null here; the
  // maxdepth-1 count branch fires). Locks the non-recursive `-maxdepth 1` file-count semantics.
  COUNT_FILES: {
    goal: "how many .ts files under repos/goal-host-vessel/src",
    owner: "aggregate",
    cmd: "find /workspace/git/super-repo/repos/goal-host-vessel/src -maxdepth 1 -type f -name '*.ts' | wc -l",
    parse: { avgThr: false, rank: false, agg: false, two: false },
  },
  // two-source compare (which + diff) => twoSource. Locks the existence-guarded A/B compare emit.
  TWO_SRC: {
    goal: "does repos/goal-host-vessel/src or repos/development-vessel/src have more lines",
    owner: "twoSource",
    cmd: "[ -d /workspace/git/super-repo/repos/goal-host-vessel/src ] && [ -d /workspace/git/super-repo/repos/development-vessel/src ] || { echo \"missing source\"; exit 1; }; A=$(find /workspace/git/super-repo/repos/goal-host-vessel/src -type f -exec cat {} + | wc -l); B=$(find /workspace/git/super-repo/repos/development-vessel/src -type f -exec cat {} + | wc -l); D=$(( A>B ? A-B : B-A )); if [ \"$A\" -eq \"$B\" ]; then echo \"tie: 0\"; elif [ \"$A\" -gt \"$B\" ]; then echo \"repos/goal-host-vessel/src: $D\"; else echo \"repos/development-vessel/src: $D\"; fi",
    parse: { avgThr: false, rank: false, agg: false, two: true },
  },
  // grep-files => aggregate grep_files branch
  GREP: {
    goal: "how many .ts files in repos/goal-host-vessel/src contain the text TODO",
    owner: "aggregate",
    cmd: "find /workspace/git/super-repo/repos/goal-host-vessel/src -type f -name '*.ts' -exec grep -lF 'TODO' {} + | wc -l",
    parse: { avgThr: false, rank: false, agg: true, two: false },
  },
};

describe("reach-routes golden: command strings + ownership order", () => {
  for (const [name, c] of Object.entries(CORPUS)) {
    it(`${name}: owner + exact command string`, () => {
      expect(owner(c.goal)).toBe(c.owner);
      expect(chain(c.goal)).toBe(c.cmd);
    });
    it(`${name}: parse ownership (collision lock)`, () => {
      expect(!!parseAvgThreshold(c.goal)).toBe(c.parse.avgThr);
      expect(!!parseRankAggregate(c.goal)).toBe(c.parse.rank);
      expect(!!parseAggregateGoal(c.goal)).toBe(c.parse.agg);
      expect(!!parseTwoSourceCompare(c.goal)).toBe(c.parse.two);
    });
  }
});

// ── STEP-3 lock: the migrated buildAvgThresholdCommand must equal BOTH the legacy golden string
// AND the SELECTORS.countAboveMean.shell projection (proving command and oracle share one cell).
describe("avg-threshold command == SELECTORS projection == legacy golden", () => {
  it("byte-identical", () => {
    const g = CORPUS.AVG_THRESH.goal;
    const root = "/workspace/git/super-repo/repos/development-vessel/src/resolvers";
    const viaSelector = SELECTORS.countAboveMean.shell({ root, nameSel: " -name '*.ts'" });
    expect(buildAvgThresholdCommand(g)).toBe(CORPUS.AVG_THRESH.cmd);
    expect(viaSelector).toBe(CORPUS.AVG_THRESH.cmd);
    expect(buildAvgThresholdCommand(g)).toBe(viaSelector);
  });
});

// ── emitVerdict golden: the three-verdict shape + EXACT reason strings the migrated
// verifyAvgThresholdReach emits. Copied verbatim from the legacy verifyAvgThresholdReach tail.
describe("emitVerdict golden (avg-threshold verdict strings)", () => {
  const ctx = { rel: "repos/development-vessel/src/resolvers", ext: "ts", truth: 79, mean: 123.456, n: 269 };
  const what = "79 .ts file(s) under repos/development-vessel/src/resolvers with more lines than the mean (123.46 over 269 file(s), git clone authoritative)";
  it("reached: emitted contains the truth", () => {
    const v = emitVerdict(ROW_AVG_THRESHOLD, ctx, "- shellResult: 79");
    expect(v).not.toBeNull();
    expect(v.reached).toBe(true);
    expect(v.deterministic).toBe(true);
    expect(v.reason).toBe(`deterministic:verified-avg-threshold — independently computed ${what}; a threaded mean-then-count command output reports the same value`);
  });
  it("mismatch: emitted has a number but not the truth", () => {
    const v = emitVerdict(ROW_AVG_THRESHOLD, ctx, "- shellResult: 80");
    expect(v).not.toBeNull();
    expect(v.reached).toBe(false);
    expect(v.reason).toBe(`deterministic:avg-threshold-mismatch — authoritative value is ${what}, but the produced command output reports 80; a wrong value is not a reach`);
  });
  it("null: no counting-command number in the digest", () => {
    expect(emitVerdict(ROW_AVG_THRESHOLD, ctx, "there is nothing numeric relevant here")).toBeNull();
  });
  it("label renders the exact what-clause", () => {
    expect(ROW_AVG_THRESHOLD.label(ctx)).toBe(what);
  });
  it("owns() delegates to parseAvgThreshold (ownership parity)", () => {
    expect(ROW_AVG_THRESHOLD.owns(CORPUS.AVG_THRESH.goal)).toEqual({ rel: "repos/development-vessel/src/resolvers", ext: "ts" });
    expect(ROW_AVG_THRESHOLD.owns(CORPUS.TOTAL.goal)).toBeNull();
  });
});

// ── SELECTOR SELF-TEST: for every SelectorId, run the JS reducer on a synthetic enumerate fixture
// and assert it equals an INDEPENDENT reference that mirrors the shell's arithmetic (the shell
// fragment itself needs the container FS, so we lock the arithmetic the two projections share —
// this is the "command and oracle cannot disagree" guarantee at the reducer level). Also asserts
// the shell fragment STRING is the expected projection (FS-free string equality) where applicable.
describe("selector self-test: js reducer arithmetic (shell-vs-js parity)", () => {
  // reference mirrors of the shell arithmetic
  const refAvgInt = (cs: number[]): number => { const N = cs.length; if (N === 0) return 0; const T = cs.reduce((a, b) => a + b, 0); return Math.floor((T + Math.floor(N / 2)) / N); };
  const refTopKAvgInt = (cs: number[], n: number): number => { const s = [...cs].sort((a, b) => b - a); const K = Math.min(n, s.length); if (K === 0) return 0; const S = s.slice(0, K).reduce((a, b) => a + b, 0); return Math.floor((S + Math.floor(K / 2)) / K); };

  const cases: Record<string, { en: any; params: any; expected: number }> = {
    sum: { en: { files: ["a", "b", "c"], counts: [10, 20, 30] }, params: {}, expected: 60 },
    avgInt: { en: { files: ["a", "b", "c"], counts: [10, 20, 30] }, params: {}, expected: refAvgInt([10, 20, 30]) /* =20 */ },
    grepCount: { en: { files: ["a", "b", "c"], counts: [1, 1, 1], texts: ["has TODO here", "none", "TODO again"] }, params: { needle: "TODO" }, expected: 2 },
    countAboveMean: { en: { files: ["a", "b", "c"], counts: [10, 20, 30] }, params: {}, expected: 1 /* mean 20, strictly > => [30] */ },
    countBelowMean: { en: { files: ["a", "b", "c"], counts: [10, 20, 30] }, params: {}, expected: 1 /* mean 20, strictly < => [10] */ },
    topKSum: { en: { files: ["a", "b", "c", "d"], counts: [5, 50, 30, 20] }, params: { n: 2 }, expected: 80 /* 50+30 */ },
    topKAvgInt: { en: { files: ["a", "b", "c", "d"], counts: [5, 50, 30, 20] }, params: { n: 3 }, expected: refTopKAvgInt([5, 50, 30, 20], 3) /* =33 */ },
    compareWinnerDiff: { en: { files: ["a", "b"], counts: [10, 20] }, params: { b: { files: ["x"], counts: [100] }, scope: "lines", dir: "more" }, expected: 70 /* |30-100| */ },
    compareWinnerValue: { en: { files: ["a", "b"], counts: [10, 20] }, params: { b: { files: ["x"], counts: [100] }, scope: "lines", dir: "more" }, expected: 100 /* max(30,100) */ },
  };

  it("every self-test case names a real SelectorId (subset lock; enumerate-all gate covers the rest)", () => {
    expect(Object.keys(SELECTORS)).toEqual(expect.arrayContaining(Object.keys(cases)));
  });

  for (const [id, c] of Object.entries(cases)) {
    it(`${id}: js reducer == reference`, () => {
      expect(SELECTORS[id].js(c.en, c.params)).toBe(c.expected);
    });
  }

  it("compareWinnerValue honors dir=fewer (min side)", () => {
    expect(SELECTORS.compareWinnerValue.js({ files: [], counts: [10, 20] }, { b: { files: [], counts: [100] }, scope: "lines", dir: "fewer" })).toBe(30);
  });
  it("compare selectors honor scope=files (files.length aggregate)", () => {
    const enA = { files: ["a", "b", "c"], counts: [999, 1, 1] };
    const enB = { files: ["x"], counts: [999] };
    expect(SELECTORS.compareWinnerDiff.js(enA, { b: enB, scope: "files", dir: "more" })).toBe(2);
    expect(SELECTORS.compareWinnerValue.js(enA, { b: enB, scope: "files", dir: "more" })).toBe(3);
  });

  // shell-fragment string projections (FS-free): lock that the shell side of each cell is the
  // exact command the legacy builders emit.
  it("shell fragments are the exact legacy projections", () => {
    const root = "/workspace/git/super-repo/repos/x/src";
    const nameSel = " -name '*.ts'";
    expect(SELECTORS.sum.shell({ root, nameSel })).toBe(`find ${root} -type f${nameSel} -exec cat {} + | wc -l`);
    expect(SELECTORS.avgInt.shell({ root, nameSel })).toBe(`T=$(find ${root} -type f${nameSel} -exec cat {} + | wc -l); N=$(find ${root} -type f${nameSel} | wc -l); if [ "$N" -gt 0 ]; then echo $(( (T + N/2) / N )); else echo "no matching files"; fi`);
    expect(SELECTORS.grepCount.shell({ root, nameSel, needle: "TODO" })).toBe(`find ${root} -type f${nameSel} -exec grep -lF 'TODO' {} + | wc -l`);
    expect(SELECTORS.countAboveMean.shell({ root, nameSel })).toBe(`find ${root} -type f${nameSel} -exec wc -l {} + | grep -v ' total$' | awk '{s+=$1;c[NR]=$1;n++}END{if(n==0){print 0;exit}avg=s/n;k=0;for(i=1;i<=n;i++)if(c[i]>avg)k++;print k}'`);
    expect(SELECTORS.topKSum.shell({ root, nameSel, n: 3 })).toBe(`find ${root} -type f${nameSel} -exec wc -l {} + | grep -v ' total$' | sort -rn | head -3 | awk '{s+=$1}END{print s+0}'`);
    expect(SELECTORS.topKAvgInt.shell({ root, nameSel, n: 5 })).toBe(`find ${root} -type f${nameSel} -exec wc -l {} + | grep -v ' total$' | sort -rn | head -5 | awk '{s+=$1;c++}END{if(c>0)printf "%d\\n",(s+int(c/2))/c; else print 0}'`);
  });
});

// ── scaffold registry sanity: the avg-threshold row is registered and shaped as declared.
describe("scaffold registry", () => {
  it("CLASS_ROWS contains the avg-threshold row with the countAboveMean selector", () => {
    expect(CLASS_ROWS.map((r: any) => r.id)).toContain("avg-threshold");
    const row = CLASS_ROWS.find((r: any) => r.id === "avg-threshold");
    expect(row.selector).toBe("countAboveMean");
    expect(row.scope).toBe("lines");
    expect(row.pathArity).toBe(1);
    expect(row.scrapeWidth).toBe(9);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// STEP 1–3: the DISPATCHER (route-as-data). These lock that (a) avg-threshold served via the
// dispatcher is byte-identical to the legacy builder, (b) the NEW below-mean class routes purely
// off a data row, (c) the dispatcher does NOT steal the known-collision goals (rank/total/two-
// source), and (d) the countBelowMean selector arithmetic matches an independent reference.
// ════════════════════════════════════════════════════════════════════════════════════════════

// The PRODUCTION command chain now leads with buildFromClassRow (index.ts _aggCmd). Mirror it:
const dispatchChain = (g: string): string | null =>
  buildFromClassRow(g) ?? buildTwoSourceCompareCommand(g) ?? buildRankAggregateCommand(g) ?? buildAggregateCommand(g);

const BELOW_MEAN_GOAL = "How many TypeScript files under repos/development-vessel/src/resolvers have FEWER lines than the average?";
const BELOW_MEAN_CMD = "find /workspace/git/super-repo/repos/development-vessel/src/resolvers -type f -name '*.ts' -exec wc -l {} + | grep -v ' total$' | awk '{s+=$1;c[NR]=$1;n++}END{if(n==0){print 0;exit}avg=s/n;k=0;for(i=1;i<=n;i++)if(c[i]<avg)k++;print k}'";

describe("dispatcher (a): avg-threshold served via buildFromClassRow == legacy builder (byte-identical)", () => {
  it("buildFromClassRow == buildAvgThresholdCommand == golden string", () => {
    const g = CORPUS.AVG_THRESH.goal;
    expect(buildFromClassRow(g)).toBe(CORPUS.AVG_THRESH.cmd);
    expect(buildFromClassRow(g)).toBe(buildAvgThresholdCommand(g));
  });
  it("resolveClassRow routes avg-threshold to ROW_AVG_THRESHOLD", () => {
    const hit = resolveClassRow(CORPUS.AVG_THRESH.goal);
    expect(hit).not.toBeNull();
    expect(hit.row.id).toBe("avg-threshold");
    expect(hit.params).toEqual({ rel: "repos/development-vessel/src/resolvers", ext: "ts" });
  });
  it("the production chain leads with the dispatcher and still yields the avg-threshold string", () => {
    expect(dispatchChain(CORPUS.AVG_THRESH.goal)).toBe(CORPUS.AVG_THRESH.cmd);
  });
});

describe("dispatcher (b): the NEW below-mean class routes purely off a data row", () => {
  it("resolveClassRow routes below-mean to ROW_BELOW_MEAN", () => {
    const hit = resolveClassRow(BELOW_MEAN_GOAL);
    expect(hit).not.toBeNull();
    expect(hit.row.id).toBe("below-mean");
    expect(hit.row.selector).toBe("countBelowMean");
    expect(hit.params).toEqual({ rel: "repos/development-vessel/src/resolvers", ext: "ts" });
  });
  it("buildFromClassRow emits the expected awk (`<avg`) command string", () => {
    expect(buildFromClassRow(BELOW_MEAN_GOAL)).toBe(BELOW_MEAN_CMD);
    expect(dispatchChain(BELOW_MEAN_GOAL)).toBe(BELOW_MEAN_CMD);
  });
  it("parseBelowMean owns the goal; parseAvgThreshold does NOT (disjoint comparators)", () => {
    expect(!!parseBelowMean(BELOW_MEAN_GOAL)).toBe(true);
    expect(!!parseAvgThreshold(BELOW_MEAN_GOAL)).toBe(false);
  });
  it("below-mean row is a single-point append with the mirrored below-direction label", () => {
    expect(CLASS_ROWS.length).toBeGreaterThanOrEqual(2);
    expect(CLASS_ROWS.map((r: any) => r.id)).toEqual(expect.arrayContaining(["avg-threshold", "below-mean"]));
    const what = ROW_BELOW_MEAN.label({ rel: "repos/development-vessel/src/resolvers", ext: "ts", truth: 174, mean: 100.5, n: 253 });
    expect(what).toBe("174 .ts file(s) under repos/development-vessel/src/resolvers with fewer lines than the mean (100.50 over 253 file(s), git clone authoritative)");
  });
});

describe("dispatcher (c): ownership — collision goals still route to their LEGACY routes, NOT the dispatcher", () => {
  // rank / plain total / two-source must NOT be owned by any CLASS_ROW (dispatcher returns null),
  // so the legacy route downstream in the `??` chain owns them exactly as before.
  const collisions: Record<string, string> = {
    RANK_SUM: CORPUS.RANK_SUM.goal,      // "total lines in the 3 largest …" -> rank
    RANK_AVG: CORPUS.RANK_AVG.goal,      // "average lines across the top 5 …" -> rank
    TOTAL: CORPUS.TOTAL.goal,            // plain total_lines -> aggregate
    AVG: CORPUS.AVG.goal,                // plain avg_lines -> aggregate
    TWO_SRC: CORPUS.TWO_SRC.goal,        // two-source compare -> twoSource
    GREP: CORPUS.GREP.goal,              // grep_files -> aggregate
    COUNT_FILES: CORPUS.COUNT_FILES.goal,// plain file-count -> aggregate fallback
  };
  for (const [name, goal] of Object.entries(collisions)) {
    it(`${name}: dispatcher does NOT own it (resolveClassRow + buildFromClassRow both null)`, () => {
      expect(resolveClassRow(goal)).toBeNull();
      expect(buildFromClassRow(goal)).toBeNull();
    });
    it(`${name}: the dispatcher-led chain yields the SAME command as the legacy chain`, () => {
      const legacy = buildAvgThresholdCommand(goal) ?? buildTwoSourceCompareCommand(goal) ?? buildRankAggregateCommand(goal) ?? buildAggregateCommand(goal);
      expect(dispatchChain(goal)).toBe(legacy);
    });
  }
});

describe("dispatcher (d): countBelowMean selector self-test (js == independent reference)", () => {
  // independent reference mirroring the awk `c[i]<avg` arithmetic
  const refBelow = (cs: number[]): number => { const n = cs.length; if (!n) return 0; const mean = cs.reduce((a, b) => a + b, 0) / n; return cs.filter((c) => c < mean).length; };
  it("countBelowMean is in the SELECTORS table", () => {
    expect(Object.keys(SELECTORS)).toContain("countBelowMean");
  });
  it("strict below: mean is neither above nor below (a count EQUAL to the mean is excluded)", () => {
    // counts [10,20,30] -> mean 20; below = [10] => 1; equal (20) excluded; above (30) excluded.
    expect(SELECTORS.countBelowMean.js({ files: ["a", "b", "c"], counts: [10, 20, 30] }, {})).toBe(1);
    expect(SELECTORS.countBelowMean.js({ files: ["a", "b", "c"], counts: [10, 20, 30] }, {})).toBe(refBelow([10, 20, 30]));
  });
  it("complement identity on a fixture with an exact-mean element: above + below + equal == n", () => {
    const counts = [10, 20, 30, 40, 25]; // mean 25 -> below [10,20] =2, above [30,40] =2, equal [25] =1
    const below = SELECTORS.countBelowMean.js({ files: counts.map(String), counts }, {});
    const above = SELECTORS.countAboveMean.js({ files: counts.map(String), counts }, {});
    const equal = counts.filter((c) => c === counts.reduce((a, b) => a + b, 0) / counts.length).length;
    expect(below).toBe(2);
    expect(above).toBe(2);
    expect(equal).toBe(1);
    expect(below + above + equal).toBe(counts.length);
    expect(below).toBe(refBelow(counts));
  });
  it("empty fixture -> 0 (no mean of nothing)", () => {
    expect(SELECTORS.countBelowMean.js({ files: [], counts: [] }, {})).toBe(0);
  });
  it("shell fragment is the exact `<avg` projection (FS-free)", () => {
    const root = "/workspace/git/super-repo/repos/x/src";
    const nameSel = " -name '*.ts'";
    expect(SELECTORS.countBelowMean.shell({ root, nameSel })).toBe(`find ${root} -type f${nameSel} -exec wc -l {} + | grep -v ' total$' | awk '{s+=$1;c[NR]=$1;n++}END{if(n==0){print 0;exit}avg=s/n;k=0;for(i=1;i<=n;i++)if(c[i]<avg)k++;print k}'`);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// ENUMERATE-ALL DRIFT GATE: for EVERY cell — every named SELECTORS entry AND every INLINE cell
// reachable through CLASS_ROWS (a drafter-authored `selector: {shell,js}` literal) — EXECUTE the
// shell fragment over a real fixture dir AND run the JS oracle over the SAME fixture via the
// production `enumerate`, then assert the two projections AGREE. This makes "command and oracle
// cannot disagree" EXECUTABLE: a newly appended cell is covered automatically (no hand-written
// per-cell assertion), and a cell whose shell and js DISAGREE on real data FAILS here. Covering
// the INLINE cells is the load-bearing safety property behind single-point class authoring: when
// the drafter appends a ClassRow with an inline selector, THIS loop reaches it through CLASS_ROWS
// and drift-checks it exactly like a table cell — so an autonomously-authored drifted selector is
// refused at the mitosis gate (which runs this test against the staged src), never served green.
// One universal fixture (rootA + a second rootB for the two-source cells) and one universal
// ctx/params bundle drive every selector, present and future — each cell reads only the fields it
// needs. The rootA fixture carries a file of EXACTLY N (=3) lines so an absolute-threshold cell
// (>N vs >=N) exercises the boundary: this is what turns a shell-vs-oracle boundary drift into a
// hard test failure at the landing gate.
// ════════════════════════════════════════════════════════════════════════════════════════════
describe("enumerate-all drift gate: executed shell(fixture) === js(fixture) for every cell (named + inline)", () => {
  const mk = (counts: number[], texts?: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "sel-fix-"));
    counts.forEach((c, i) => writeFileSync(join(dir, `f${i}.ts`), (texts?.[i] ?? "") + "\n".repeat(c)));
    return dir;
  };
  const lastInt = (s: string): number | null => { const m = s.trim().match(/-?\d+/g); return m ? Number(m[m.length - 1]) : null; };

  const A_COUNTS = [3, 10, 20, 30, 40];                 // one file == N (=3): exercises the >/>= boundary
  const A_TEXTS = ["has TODO here", "none", "TODO again", "nope", "still none"];
  const B_COUNTS = [100, 5];
  const nameSel = " -name '*.ts'";
  const N = 3, NEEDLE = "TODO";
  const rootA = mk(A_COUNTS, A_TEXTS);
  const rootB = mk(B_COUNTS);

  // Every cell that can serve a request: the named table entries PLUS the inline cells a ClassRow
  // may carry. selectorOf() is the same materializer the dispatcher uses, so this iterates exactly
  // the cells production can reach. Inline cells are labelled by their owning row id for a readable
  // failure; the enumerate-ALL guarantee means a future inline selector needs no test edit.
  const namedCells = Object.keys(SELECTORS).map((id: string) => ({ label: id, cell: SELECTORS[id] }));
  const inlineCells = (CLASS_ROWS as any[])
    .filter((r) => typeof r.selector !== "string")
    .map((r) => ({ label: `inline:${r.id}`, cell: selectorOf(r) }));
  const allCells = [...namedCells, ...inlineCells];

  for (const { label, cell } of allCells) {
    it(`${label}: executed shell output == js oracle over the SAME fixture`, async () => {
      const shellCtx: any = { root: rootA, rootB, nameSel, n: N, needle: NEEDLE, relA: "A", relB: "B", dir: "more", scope: "lines" };
      const shellStr = cell.shell(shellCtx);
      const proc = Bun.spawn(["bash", "-c", shellStr], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const shellVal = lastInt(out);
      expect(shellVal).not.toBeNull();

      const enA = await enumerate(rootA, "ts", true);
      const enB = await enumerate(rootB, "ts", true);
      expect(enA).not.toBeNull();
      expect(enB).not.toBeNull();
      const params: any = { n: N, needle: NEEDLE, b: enB, dir: "more", scope: "lines" };
      const jsVal = cell.js(enA, params);

      // THE INVARIANT: the two projections of one cell agree on real data.
      expect(shellVal).toBe(jsVal);
    });
  }

  it("every inline ClassRow selector is reached by this gate (no inline cell escapes drift-checking)", () => {
    // Guards the guard: if a row carries an inline selector, allCells MUST include it. This is the
    // property the single-point-authoring safety rests on — an inline cell that this loop skipped
    // could drift and land green.
    const inlineRowIds = (CLASS_ROWS as any[]).filter((r) => typeof r.selector !== "string").map((r) => `inline:${r.id}`);
    for (const id of inlineRowIds) expect(allCells.map((c) => c.label)).toContain(id);
  });
});

// ── INLINE-SELECTOR PATH PROOF: exercise the inline form end-to-end at the cell level NOW, before
// any drafter-authored inline ClassRow exists in CLASS_ROWS. Proves (1) selectorOf materializes a
// string id to the table cell and an object to itself, and (2) an inline cell is drift-checkable by
// the exact shell(fixture)==js(fixture) mechanism the gate uses — a CLEAN inline cell agrees, a
// DRIFTED one disagrees. This is the capability the single-point-authoring climax depends on.
describe("inline selector path (single-point class authoring)", () => {
  const mk = (counts: number[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "inl-fix-"));
    counts.forEach((c, i) => writeFileSync(join(dir, `f${i}.ts`), "\n".repeat(c)));
    return dir;
  };
  const lastInt = (s: string): number | null => { const m = s.trim().match(/-?\d+/g); return m ? Number(m[m.length - 1]) : null; };
  const runShellVsJs = async (cell: any, root: string, n: number): Promise<{ shellVal: number | null; jsVal: number }> => {
    const shellStr = cell.shell({ root, nameSel: " -name '*.ts'", n, scope: "lines" });
    const proc = Bun.spawn(["bash", "-c", shellStr], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const en = await enumerate(root, "ts", false);
    return { shellVal: lastInt(out), jsVal: cell.js(en, { n, scope: "lines" }) };
  };

  // A genuinely-new compositional class the table does not have: "count files with MORE than N
  // lines" (absolute threshold on params.n), colocated shell+js — a plausible drafter authoring.
  const inlineOverN = {
    shell: (ctx: any) => `find ${ctx.root} -type f${ctx.nameSel} -exec wc -l {} + | grep -v ' total$' | awk -v n=${ctx.n} '{if($1>n)k++}END{print k+0}'`,
    js: (en: any, p: any) => en.counts.filter((c: number) => c > p.n).length,
  };

  it("selectorOf: string id -> the frozen table cell; object -> itself", () => {
    expect(selectorOf({ selector: "countAboveMean" } as any)).toBe(SELECTORS.countAboveMean);
    expect(selectorOf({ selector: inlineOverN } as any)).toBe(inlineOverN);
  });

  it("a CLEAN inline cell: executed shell(fixture) == js(fixture) (drift-checkable, agrees)", async () => {
    const root = mk([1, 3, 5, 5, 9]);                    // N=3 -> files with >3 lines: [5,5,9] => 3
    const { shellVal, jsVal } = await runShellVsJs(inlineOverN, root, 3);
    expect(shellVal).not.toBeNull();
    expect(jsVal).toBe(3);
    expect(shellVal).toBe(jsVal);                        // the two projections of the inline cell agree
  });

  it("a DRIFTED inline cell (shell `>` vs js `>=`) is CAUGHT: shell(fixture) != js(fixture)", async () => {
    // Same shell as inlineOverN but the js reducer uses >= — the boundary file (==N) makes them
    // disagree. This is exactly the failure the mitosis drift gate must reject for an autonomously
    // authored cell; here we prove the mechanism detects it.
    const driftedOverN = { shell: inlineOverN.shell, js: (en: any, p: any) => en.counts.filter((c: number) => c >= p.n).length };
    const root = mk([1, 3, 5, 5, 9]);                    // N=3 -> shell(>3)=3, js(>=3)=4 (the ==3 file)
    const { shellVal, jsVal } = await runShellVsJs(driftedOverN, root, 3);
    expect(shellVal).toBe(3);
    expect(jsVal).toBe(4);
    expect(shellVal).not.toBe(jsVal);                    // DRIFT DETECTED — the gate would refuse this
  });
});

// ── MINIMAL-ROW DEFAULTS: a drafter-authored inline ClassRow that OMITS every ancillary field
// (only { id, owns, selector }) must still verify correctly — emitVerdict fills scrapeWidth,
// scrapeKeywords, verifiedVerb, and label from defaults. This is what shrinks the authoring
// surface: the smaller the required literal, the more reliably the drafter lands it single-point.
describe("minimal inline ClassRow (only id/owns/selector) verifies via defaults", () => {
  const minimalRow: any = {
    id: "above-count",
    owns: (g: string) => (/more than \d+ lines/i.test(g) ? { rel: "repos/x/src", ext: "ts", n: 100 } : null),
    selector: { shell: (ctx: any) => `echo ${ctx.n}`, js: (en: any, p: any) => en.counts.filter((c: number) => c > p.n).length },
    // NO scope, pathArity, extPolicy, scrapeWidth, scrapeKeywords, verifiedVerb, label
  };
  const ctx = { rel: "repos/x/src", ext: "ts", truth: 7, n: 100 };

  it("emitVerdict reached=true with the DEFAULT label + DEFAULT verified verb", () => {
    const v = emitVerdict(minimalRow, ctx, "- shellResult: 7");
    expect(v).not.toBeNull();
    expect(v.reached).toBe(true);
    // default label: "<truth> .<ext> file(s) under <rel> (threshold <n>) (git clone authoritative)"
    expect(v.reason).toContain("7 .ts file(s) under repos/x/src (threshold 100) (git clone authoritative)");
    expect(v.reason).toContain("a threaded deterministic command output reports the same value");
    expect(v.reason).toContain("deterministic:verified-above-count");
  });
  it("emitVerdict mismatch uses default scrapeWidth (9) to scrape the wrong value", () => {
    const v = emitVerdict(minimalRow, ctx, "- shellResult: 8");
    expect(v).not.toBeNull();
    expect(v.reached).toBe(false);
    expect(v.reason).toContain("above-count-mismatch");
    expect(v.reason).toContain("reports 8");
  });
  it("selectorOf materializes the minimal row's INLINE cell (served identically)", () => {
    expect(selectorOf(minimalRow)).toBe(minimalRow.selector);
  });
});

// ── SELECTOR PRIMITIVE FACTORIES: the drafter composes a new class from vetted, drift-safe
// building blocks (thresholdSelector / parseThreshold) instead of authoring raw awk + a regex
// string. These lock (1) each comparator's factory selector is shell==js on real data incl. the
// ==N boundary (drift-safe by construction), (2) parseThreshold parses path+N and is disjoint
// from avg/below-mean, (3) a whole ClassRow COMPOSED from primitives + defaults routes end-to-end.
describe("selector primitive factories (compose-a-class from vetted blocks)", () => {
  const mk = (counts: number[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "prim-fix-"));
    counts.forEach((c, i) => writeFileSync(join(dir, `f${i}.ts`), "\n".repeat(c)));
    return dir;
  };
  const lastInt = (s: string): number | null => { const m = s.trim().match(/-?\d+/g); return m ? Number(m[m.length - 1]) : null; };
  const COUNTS = [3, 10, 20, 30, 40];                   // one file == N (=3): exercises the boundary

  for (const cmp of [">", ">=", "<", "<="] as const) {
    it(`thresholdSelector("${cmp}"): executed shell == js oracle over the SAME fixture (boundary at N=3)`, async () => {
      const cell = thresholdSelector(cmp);
      const root = mk(COUNTS);
      const shellStr = cell.shell({ root, nameSel: " -name '*.ts'", n: 3 } as any);
      const proc = Bun.spawn(["bash", "-c", shellStr], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const shellVal = lastInt(out);
      const en = await enumerate(root, "ts", false);
      const jsVal = cell.js(en, { n: 3 } as any);
      expect(shellVal).not.toBeNull();
      expect(shellVal).toBe(jsVal);                     // one cmp arg drives both → cannot drift
    });
  }

  it("the four comparators partition the fixture correctly at N=3", () => {
    const en = { files: COUNTS.map(String), counts: COUNTS };
    expect(thresholdSelector(">").js(en as any, { n: 3 } as any)).toBe(4);   // 10,20,30,40
    expect(thresholdSelector(">=").js(en as any, { n: 3 } as any)).toBe(5);  // +the ==3 file
    expect(thresholdSelector("<").js(en as any, { n: 3 } as any)).toBe(0);   // none below 3
    expect(thresholdSelector("<=").js(en as any, { n: 3 } as any)).toBe(1);  // the ==3 file
  });

  it('parseThreshold("more than") parses path + N; disjoint from avg/below-mean', () => {
    const owns = parseThreshold("more than");
    const g = "how many .ts files under repos/development-vessel/src have more than 100 lines";
    expect(owns(g)).toEqual({ rel: "repos/development-vessel/src", ext: "ts", n: 100 });
    expect(owns("total lines in .ts files under repos/x/src")).toBeNull();     // no threshold clause
    expect(owns("more than 100 lines")).toBeNull();                            // no repos/<dir> path
    // must not steal the mean-relative goals owned by avg-threshold / below-mean
    expect(owns("how many files under repos/x/src have more lines than the average")).toBeNull();
  });

  it("a ClassRow COMPOSED from primitives + defaults builds the expected command (single-point authoring)", () => {
    const row: any = { id: "above-count", owns: parseThreshold("more than"), selector: thresholdSelector(">") };
    // selectorOf resolves the inline factory cell; its shell is the vetted awk (no hand-authored string)
    const ctx = { root: "/workspace/git/super-repo/repos/x/src", nameSel: " -name '*.ts'", n: 100 };
    expect(selectorOf(row).shell(ctx as any)).toBe(
      "find /workspace/git/super-repo/repos/x/src -type f -name '*.ts' -exec wc -l {} + | grep -v ' total$' | awk -v n=100 '{if($1>n)k++}END{print k+0}'",
    );
    expect(row.owns("how many .ts files under repos/x/src have more than 100 lines")).toEqual({ rel: "repos/x/src", ext: "ts", n: 100 });
  });
});
