import { describe, expect, test } from "bun:test";
import { verifyVerbatimFileRead, verbatimReadTarget, unwrapAnswer, fileReadOf, createVerbatimShadow, shadowBudgetFrom, VERBATIM_SHADOW_DEFAULT_UNTIL, VERBATIM_SHADOW_DEFAULT_N, type FileRead, type ShadowDeps } from "./verbatim-read";

// THE MEASURED CASE (dispatch ee3cdfc3, 2026-10-01). The walk's first step resolved fileContent
// with the file's exact bytes; the LLM judge called it HOLLOW ("truncated"), and the dispatch
// spent 35 walk-log entries retrying, suppressing the working producer and web-searching the path.
// No test here touches the network: the fresh re-read is an injected function.

const PATH = "/workspace/validation/latency-probe.txt";
const BYTES = "latency-probe-c951b44f4a99-42\n";
const GOAL = `Read ${PATH} and tell me exactly what it says.`;

const fc = (path: string, content: string, extra: Record<string, unknown> = {}) =>
  `- fileContent: ${JSON.stringify({ shape: "fileContent", path, content, ...extra })}`;
const digest = (...lines: string[]) =>
  [`- goal: ${JSON.stringify({ goal: GOAL })}`, `- dispatch_id: ee3cdfc3-a003-4556-8363-d81037550549`, ...lines].join("\n");

const reread = (content: string | null, extra: Partial<FileRead> = {}) => {
  const calls: string[] = [];
  const fn = async (p: string): Promise<FileRead | null> => { calls.push(p); return content === null ? null : { path: p, content, ...extra }; };
  return Object.assign(fn, { calls });
};

describe("family detection is a positive list plus exactly one absolute path", () => {
  test.each([
    GOAL,
    `Print the contents of ${PATH}`,
    `What does ${PATH} contain? Give it to me verbatim.`,
    `Show me the full contents of ${PATH}.`,
    `cat the exact contents of ${PATH}`,
    `Read "${PATH}" and tell me exactly what the file says`,
  ])("in family: %s", (g) => {
    expect(verbatimReadTarget(g)).toBe(PATH);
  });

  test.each([
    `Read ${PATH} and summarize it.`,
    `Read ${PATH} and tell me what it says.`, // no exactness cue
    `How many lines are in ${PATH}? Tell me exactly what it says too.`,
    `Print the contents of ${PATH} and also count the words`,
    `Print the first 3 lines of ${PATH} verbatim`,
    `Write exactly what it says into /workspace/out.txt after reading ${PATH}`, // two paths
    `Tell me exactly what it says in repos/goal-host-vessel/src/index.ts`, // not absolute
    `Print the exact contents of the README`, // no path
    `Print the value of the "port" key in /workspace/config.json verbatim`,
    `Compare /workspace/a.txt verbatim`,
  ])("abstains: %s", (g) => {
    expect(verbatimReadTarget(g)).toBeNull();
  });

  test("CORPUS REGRESSION: an edit spec that quotes an anchor 'verbatim' is not a file read", () => {
    // From goal_verification_labels: the first matcher claimed this goal, reading the regex
    // literal "(/restarted" as an absolute path.
    const g = "investigate and decompose gap a-load-induced-verify-timeout-is-charged-to-the-drafter-as-a-fix-failure: " +
      "In repos/development-vessel/src/resolvers/feature-compose.ts, let classifyEnvironmentFailure see a verify-stage environment failure.\n\n" +
      "ANCHOR — this exact line already exists in the file. Match it verbatim, do not paraphrase:\n" +
      "    if (/restarted \\(cutover\\)|cutover race/i.test(t)) return \"env_cutover_race\";";
    expect(verbatimReadTarget(g)).toBeNull();
    expect(verbatimReadTarget("Print the contents of /restarted verbatim")).toBeNull(); // one segment is not a file path
  });

  test("a path's own extension cannot trip the exclusion list", () => {
    expect(verbatimReadTarget("Print the contents of /workspace/data/settings.json")).toBe("/workspace/data/settings.json");
  });
});

describe("verdicts", () => {
  test("family match + exact content (the measured dispatch) → reached, deterministic, against a FRESH read", async () => {
    const rr = reread(BYTES);
    const v = await verifyVerbatimFileRead(GOAL, digest(fc(PATH, BYTES)), rr);
    expect(v?.reached).toBe(true);
    expect(v?.deterministic).toBe(true);
    expect(v?.reason).toMatch(/^deterministic:verified-verbatim-read/);
    expect(v?.completion_shapes).toEqual(["fileContent"]);
    expect(rr.calls).toEqual([PATH]);
  });

  test("an answer wrapped in a code block is reached (fresh read unavailable, separate answer text)", async () => {
    const answer = "- llmTextCompletion: The file says:\n```text\nlatency-probe-c951b44f4a99-42\n```";
    const v = await verifyVerbatimFileRead(GOAL, digest(fc(PATH, BYTES), answer), reread(null));
    expect(v?.reached).toBe(true);
  });

  test("a quoted multi-line answer is reached against the fresh read", async () => {
    const multi = "line one\nline two\n";
    const answer = `- llmTextCompletion: ${JSON.stringify({ text: `"line one\nline two"` })}`;
    // The walk's own fileContent is a different (stale) read; only the answer carries the truth.
    const v = await verifyVerbatimFileRead(GOAL, digest(fc(PATH, "line one\n"), answer), reread(multi));
    expect(v?.reached).toBe(true);
  });

  test("truncated → not reached with 'truncated: N of M bytes'", async () => {
    const v = await verifyVerbatimFileRead(GOAL, digest(fc(PATH, BYTES), "- llmTextCompletion: latency-probe-c951"), reread(BYTES));
    expect(v?.reached).toBe(false);
    expect(v?.reason).toContain("truncated: 18 of 29 bytes");
  });

  test("truncation is measured against the walk's read when the file has since changed", async () => {
    // The answer cut the walk's own read short; what the file says NOW does not excuse that.
    const v = await verifyVerbatimFileRead(GOAL, digest(fc(PATH, "old-content-of-the-file\n"), "- llmTextCompletion: old-content"), reread("new-content-entirely\n"));
    expect(v?.reached).toBe(false);
    expect(v?.reason).toContain("truncated: 11 of 23 bytes of the walk's read");
  });

  test("R1: a CHANGED FILE ABSTAINS — answer == walk's (old) read, re-read == new content", async () => {
    const notes: string[] = [];
    const old = "probe-generation-1\n", now = "probe-generation-2\n";
    const withAnswer = await verifyVerbatimFileRead(GOAL, digest(fc(PATH, old), `- llmTextCompletion: ${JSON.stringify({ text: old })}`), reread(now), (w) => notes.push(w));
    expect(withAnswer).toBeNull();
    const readOnly = await verifyVerbatimFileRead(GOAL, digest(fc(PATH, old)), reread(now), (w) => notes.push(w));
    expect(readOnly).toBeNull();
    expect(notes.length).toBe(2);
    expect(notes[0]).toMatch(/^file changed since read/);
  });

  test("a walk read that is a strict prefix of the fresh read (file grew, no producer flag) abstains", async () => {
    expect(await verifyVerbatimFileRead(GOAL, digest(fc(PATH, "latency-probe-c951")), reread(BYTES))).toBeNull();
  });

  test("a fenced answer that stops short is truncated, not mismatch", async () => {
    const answer = "- llmTextCompletion: ```\nlatency-probe-c951\n```";
    const v = await verifyVerbatimFileRead(GOAL, digest(fc(PATH, BYTES), answer), reread(null));
    expect(v?.reached).toBe(false);
    expect(v?.reason).toContain("truncated: 18 of 29 bytes");
  });

  test("the producer declaring a partial read → truncated", async () => {
    const v = await verifyVerbatimFileRead(GOAL, digest(`- fileContent: ${JSON.stringify({ shape: "fileContent", body: { path: PATH, bytes: 2_000_000, content: "abc", truncated: true } })}`), reread(BYTES));
    expect(v?.reached).toBe(false);
    expect(v?.reason).toMatch(/truncated: 3 of 2000000 bytes/);
  });

  test("wrong file → not reached", async () => {
    const v = await verifyVerbatimFileRead(GOAL, digest(fc("/workspace/validation/other.txt", BYTES)), reread(BYTES));
    expect(v?.reached).toBe(false);
    expect(v?.reason).toMatch(/^deterministic:verbatim-read-wrong-file/);
  });

  test("MUST-FAIL: a planted wrong answer in-family → deterministic FAIL (matches neither read)", async () => {
    const planted = "- llmTextCompletion: The file says: latency-probe-PLANTED-99";
    const v = await verifyVerbatimFileRead(GOAL, digest(fc(PATH, BYTES), planted), reread(BYTES));
    expect(v?.reached).toBe(false);
    expect(v?.reason).toMatch(/^deterministic:verbatim-read-mismatch/);
    // Still a FAIL when the file also changed: the answer matches neither the walk's read nor the fresh one.
    const v2 = await verifyVerbatimFileRead(GOAL, digest(fc(PATH, "probe-generation-1\n"), planted), reread("probe-generation-2\n"));
    expect(v2?.reached).toBe(false);
    expect(v2?.reason).toMatch(/^deterministic:verbatim-read-mismatch/);
  });

  test("a planted walk read with no answer text is indistinguishable from a changed file → abstain", async () => {
    expect(await verifyVerbatimFileRead(GOAL, digest(fc(PATH, "latency-probe-PLANTED-99\n")), reread(BYTES))).toBeNull();
  });

  test("a SHORT file is not certified by an incidental token elsewhere in the pool", async () => {
    const search = `- webSearchResult: ${JSON.stringify({ results: [{ snippet: "the answer is 42" }] })}`;
    // A search snippet is fetched-from-elsewhere, never an answer: the walk's read "41" vs fresh "42"
    // is then a changed file (abstain), and is certainly not certified by the snippet's "42".
    const wrong = await verifyVerbatimFileRead(GOAL, digest(fc(PATH, "41\n"), search), reread("42\n"));
    expect(wrong).toBeNull();
    // An answer text that merely MENTIONS the short token does not carry a 2-byte file.
    const mention = await verifyVerbatimFileRead(GOAL, digest(fc(PATH, "41\n"), "- llmTextCompletion: the answer is 42 or thereabouts"), reread("42\n"));
    expect(mention?.reached).toBe(false);
    const right = await verifyVerbatimFileRead(GOAL, digest(fc(PATH, "42\n"), search), reread("42\n"));
    expect(right?.reached).toBe(true);
    const quoted = await verifyVerbatimFileRead(GOAL, digest(fc(PATH, "41\n"), `- llmTextCompletion: "42"`), reread("42\n"));
    expect(quoted?.reached).toBe(true);
  });

  test("non-family goal → abstain, and the re-read is never attempted", async () => {
    const rr = reread(BYTES);
    expect(await verifyVerbatimFileRead(`Read ${PATH} and summarize it.`, digest(fc(PATH, BYTES)), rr)).toBeNull();
    expect(rr.calls).toEqual([]);
  });

  test("no fileContent in the pool → abstain", async () => {
    expect(await verifyVerbatimFileRead(GOAL, digest("- webSearchResult: {\"results\":[]}"), reread(BYTES))).toBeNull();
    // A provenance stub is not a read either (the widened walk's fileContent).
    expect(await verifyVerbatimFileRead(GOAL, digest(`- fileContent: {"producedBy":"activity:x","executionId":"exec_1"}`), reread(BYTES))).toBeNull();
  });

  test("NO SELF-CONFIRMATION: fresh read unavailable and only the walk's own read delivered → abstain", async () => {
    expect(await verifyVerbatimFileRead(GOAL, digest(fc(PATH, BYTES)), reread(null))).toBeNull();
    expect(await verifyVerbatimFileRead(GOAL, digest(fc(PATH, BYTES)), null)).toBeNull();
  });

  test("a fileContent entry cut by the digest caps → abstain (never 'wrong file' or 'truncated')", async () => {
    const cut = fc(PATH, "x".repeat(3000)).slice(0, 1500);
    expect(await verifyVerbatimFileRead(GOAL, digest(cut), reread("x".repeat(3000)))).toBeNull();
  });

  test("an empty file abstains (containment of '' proves nothing)", async () => {
    expect(await verifyVerbatimFileRead(GOAL, digest(fc(PATH, "")), reread("\n"))).toBeNull();
  });

  test("a fresh read for a different path is not ground truth", async () => {
    const other = async (): Promise<FileRead | null> => ({ path: "/elsewhere/latency-probe.txt", content: BYTES });
    expect(await verifyVerbatimFileRead(GOAL, digest(fc(PATH, BYTES)), other)).toBeNull();
  });
});

describe("helpers", () => {
  test("unwrapAnswer strips one fence or one pair of quotes", () => {
    expect(unwrapAnswer("```json\n{\"a\":1}\n```")).toBe("{\"a\":1}");
    expect(unwrapAnswer("“hello”")).toBe("hello");
    expect(unwrapAnswer("  plain  ")).toBe("plain");
  });
  test("fileReadOf reads both fleet envelopes and rejects errors and stubs", () => {
    expect(fileReadOf({ shape: "fileContent", path: PATH, content: BYTES })?.content).toBe(BYTES);
    expect(fileReadOf({ shape: "fileContent", body: { path: PATH, bytes: 29, content: BYTES, truncated: false } })?.bytes).toBe(29);
    expect(fileReadOf({ error: "ENOENT", content: "" })).toBeNull();
    expect(fileReadOf({ producedBy: "x", executionId: "y" })).toBeNull();
  });
});

describe("shadow judge (measurement, never control)", () => {
  const ORACLE_PASS = { reached: true, reason: "deterministic:verified-verbatim-read — x", completion_shapes: ["fileContent"], deterministic: true };
  const T0 = Date.parse("2026-10-02T00:00:00Z");
  const FUTURE = Date.parse("2026-10-08T00:00:00Z");
  const deps = (over: Partial<ShadowDeps> & { n?: number; untilMs?: number } = {}) => {
    const rec = { judged: 0, recorded: [] as unknown[], lines: [] as string[] };
    const d: ShadowDeps = {
      judge: over.judge ?? (async () => { rec.judged++; return { reached: false, reason: "judge says truncated" }; }),
      budget: over.budget ?? (async () => ({ n: over.n ?? 2, untilMs: over.untilMs ?? FUTURE })),
      recordDisagreement: over.recordDisagreement ?? ((o, j) => { rec.recorded.push({ o, j }); }),
      log: (l) => rec.lines.push(l),
      now: over.now ?? (() => T0),
    };
    return { d, rec };
  };

  test("runs while under N, and not after (N counts distinct dispatches)", async () => {
    const sh = createVerbatimShadow();
    const { d, rec } = deps({ n: 2 });
    for (let i = 0; i < 4; i++) await sh.run(ORACLE_PASS, d, `dispatch-${i}`);
    expect(rec.judged).toBe(2);
  });

  test("DEDUPE: two shadow attempts for the same dispatch → one judge call, one slot", async () => {
    const sh = createVerbatimShadow();
    const { d, rec } = deps({ n: 5 });
    await sh.run(ORACLE_PASS, d, "dispatch-A");
    await sh.run(ORACLE_PASS, d, "dispatch-A");
    expect(rec.judged).toBe(1);
    expect(sh.claimed).toBe(1);
  });

  test("shadow_until: before it → runs; at or past it → no shadow", async () => {
    const before = deps({ untilMs: FUTURE, now: () => FUTURE - 1 });
    await createVerbatimShadow().run(ORACLE_PASS, before.d, "k");
    expect(before.rec.judged).toBe(1);
    const past = deps({ untilMs: FUTURE, now: () => FUTURE + 1 });
    await createVerbatimShadow().run(ORACLE_PASS, past.d, "k");
    expect(past.rec.judged).toBe(0);
  });

  test("the policy reader: defaults, overrides, and an unusable shadow_until falls back to the constant", () => {
    expect(shadowBudgetFrom(null)).toEqual({ n: VERBATIM_SHADOW_DEFAULT_N, untilMs: Date.parse(VERBATIM_SHADOW_DEFAULT_UNTIL) });
    expect(VERBATIM_SHADOW_DEFAULT_UNTIL).toBe("2026-10-08T00:00:00Z");
    expect(shadowBudgetFrom({ shadow_n: 3, shadow_until: "2026-11-01T00:00:00Z" })).toEqual({ n: 3, untilMs: Date.parse("2026-11-01T00:00:00Z") });
    expect(shadowBudgetFrom({ shadow_until: "not a date" }).untilMs).toBe(Date.parse(VERBATIM_SHADOW_DEFAULT_UNTIL));
  });

  test("a disagreement writes a label and logs one comparison line", async () => {
    const sh = createVerbatimShadow();
    const { d, rec } = deps();
    await sh.run(ORACLE_PASS, d, "k");
    expect(rec.recorded.length).toBe(1);
    expect(rec.lines).toEqual(["[verbatim-read-oracle] shadow oracle=reached judge=hollow agree=false reason=judge says truncated"]);
  });

  test("an agreement writes no label", async () => {
    const sh = createVerbatimShadow();
    const { d, rec } = deps({ judge: async () => ({ reached: true, reason: "fine" }) });
    await sh.run(ORACLE_PASS, d, "k");
    expect(rec.recorded.length).toBe(0);
    expect(rec.lines[0]).toContain("agree=true");
  });

  test("a failing judge, budget or recorder is logged and swallowed — never thrown", async () => {
    const a = deps({ judge: async () => { throw new Error("llm down"); } });
    await createVerbatimShadow().run(ORACLE_PASS, a.d, "k");
    expect(a.rec.lines[0]).toContain("judge=error");
    const b = deps({ budget: async () => { throw new Error("policy unreadable"); } });
    await createVerbatimShadow().run(ORACLE_PASS, b.d, "k");
    expect(b.rec.lines[0]).toContain("failed (ignored)");
    const c = deps({ recordDisagreement: () => { throw new Error("label store down"); } });
    await expect(createVerbatimShadow().run(ORACLE_PASS, c.d, "k")).resolves.toBeUndefined();
  });
});
