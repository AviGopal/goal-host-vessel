import { describe, expect, it } from "bun:test";

import {
  extractEmittedNumbers,
  gradeRecompute,
  isReadOnlyShellCommand,
  extractEmittedTokens,
  gradeTokenRecompute,
  parseAuthoredCommand,
  parseMeasuredToken,
  parseMeasuredNumber,
  reconcileDerivations,
} from "./independent-recompute";

/**
 * This gate decides what a model-authored command is allowed to do INSIDE the container, and
 * its output is then treated as ground truth. Both halves are load-bearing: a permitted
 * mutation is a real write, and a permitted self-emitted literal is the answer confirming
 * itself — the exact defect that let a reach oracle and its goal generator share a
 * `-maxdepth 1` and certify each other.
 */
describe("isReadOnlyShellCommand — what a recompute is allowed to run", () => {
  it("accepts the measuring commands these goal classes actually need", () => {
    expect(isReadOnlyShellCommand("find /workspace/git/vessels/activity-api/src -name '*.ts' | wc -l").ok).toBe(true);
    expect(isReadOnlyShellCommand("git -C /workspace/git/vessels/concept-db log --since=30.days --oneline | wc -l").ok).toBe(true);
    expect(isReadOnlyShellCommand("curl -s http://localhost:18100/v2/registry/shapes | jq '.shapes | length'").ok).toBe(true);
    expect(isReadOnlyShellCommand("grep -rl async /workspace/git/vessels/x/src | wc -l").ok).toBe(true);
  });

  it("refuses a command that EMITS the answer instead of measuring it", () => {
    // A self-emitted constant is the model asserting, not evidence. The LLM judge is already
    // told to grade this hollow; here it would become the ground truth everything else is
    // compared against, so it must never get that far.
    const r = isReadOnlyShellCommand("echo 42");
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/EMITS a literal/);
    expect(isReadOnlyShellCommand("printf '%d' 7").ok).toBe(false);
  });

  it("refuses mutations, including ones hidden inside a substitution", () => {
    expect(isReadOnlyShellCommand("rm -rf /workspace/git").ok).toBe(false);
    expect(isReadOnlyShellCommand("find . -name '*.ts' | wc -l; rm /tmp/x").ok).toBe(false);
    // The scan runs over the whole string precisely so $(...) and backticks cannot smuggle one.
    expect(isReadOnlyShellCommand("echo $(rm -f /tmp/x)").ok).toBe(false);
    expect(isReadOnlyShellCommand("wc -l `mv a b`").ok).toBe(false);
  });

  it("refuses in-place editors and history-mutating git verbs the bare-name list misses", () => {
    expect(isReadOnlyShellCommand("sed -i 's/a/b/' file | wc -l").ok).toBe(false);
    expect(isReadOnlyShellCommand("git -C /x commit -m y").ok).toBe(false);
    expect(isReadOnlyShellCommand("git -C /x checkout dev && git log --oneline | wc -l").ok).toBe(false);
    expect(isReadOnlyShellCommand("bun install && find . | wc -l").ok).toBe(false);
  });

  it("refuses redirection but keeps stderr merging, which every real one-liner uses", () => {
    expect(isReadOnlyShellCommand("find . | wc -l > /tmp/out").ok).toBe(false);
    expect(isReadOnlyShellCommand("find . | tee /tmp/out | wc -l").ok).toBe(false);
    expect(isReadOnlyShellCommand("git -C /x log --oneline 2>/dev/null | wc -l").ok).toBe(true);
    expect(isReadOnlyShellCommand("find /x -name '*.ts' 2>&1 | wc -l").ok).toBe(true);
  });

  it("refuses what it cannot audit", () => {
    expect(isReadOnlyShellCommand("").ok).toBe(false);
    expect(isReadOnlyShellCommand("find . |\nwc -l").ok).toBe(false);
    expect(isReadOnlyShellCommand("x".repeat(900)).ok).toBe(false);
  });
});

describe("parseMeasuredNumber — strict, because this value becomes the truth", () => {
  it("takes a clean single number, which is what the command was asked for", () => {
    expect(parseMeasuredNumber("42\n")).toBe(42);
    expect(parseMeasuredNumber("  7  ")).toBe(7);
    // A pipeline that logs to stderr and counts on stdout still ends on the number.
    expect(parseMeasuredNumber("warning: something\n313\n")).toBe(313);
  });

  it("returns null rather than guessing at a messy result", () => {
    // A loose parse here would rebuild the bag-of-integers defect on the GROUND-TRUTH side,
    // where a wrong value does the most damage.
    expect(parseMeasuredNumber("There are 42 files")).toBeNull();
    expect(parseMeasuredNumber("")).toBeNull();
    expect(parseMeasuredNumber("find: no such file")).toBeNull();
    expect(parseMeasuredNumber("42 76")).toBeNull();
  });
});

describe("extractEmittedNumbers — the anti-pollution discipline, inherited not re-derived", () => {
  it("reads the numbers a counting operation reported, on both digest shapes", () => {
    expect(extractEmittedNumbers("- shellResult: 10")).toContain(10);
    expect(extractEmittedNumbers("There are 313 .ts files under that tree.")).toContain(313);
    expect(extractEmittedNumbers("The total number of commits is 88.")).toContain(88);
  });

  it("ignores long JSON blobs, whose incidental integers match anything", () => {
    const blob = `{"activity_metrics":{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8,"i":9,"j":10,"k":11,"l":12,"m":13,"template_id":"tpl-99","success_rate":0.42,"executions":1234}}`;
    expect(extractEmittedNumbers(blob)).toEqual([]);
  });

  it("ignores lines that report a FAILURE, which carry no measurement", () => {
    expect(extractEmittedNumbers(`- shellResult: {"error":"command is required"} 9`)).toEqual([]);
  });
});

describe("gradeRecompute — and why disagreement must be learnable", () => {
  it("agrees when the walk emitted the independently measured value", () => {
    expect(gradeRecompute(313, [313])).toBe("agree");
    expect(gradeRecompute(10, [18, 10])).toBe("agree");
  });

  it("calls a stated-but-wrong number a real miss, not an abstention", () => {
    // This is the verdict the no-oracle refusal could never produce. The refusal withholds β
    // (the missing verifier was ours), so the posterior never moved and reach on a novel class
    // was pinned at the refusal rate. A disagreement is the walk's own error, so it CARRIES
    // β — which is what makes the curve able to rise instead of sit flat.
    expect(gradeRecompute(313, [9088])).toBe("disagree");
  });

  it("abstains when the walk emitted nothing measurable, rather than inventing a miss", () => {
    expect(gradeRecompute(313, [])).toBe("no-measurement");
  });
});

/**
 * OBSERVED LIVE on the first probe, on the very domain this mechanism exists to cover. The
 * authored command was `git -C … log --since=30.days.ago -- repos/concept-db | wc -l`, which
 * counts log LINES (~5 per commit). It measured 147, the walk had said 16, and the gate
 * β-penalised the walk on the strength of its own wrong number.
 */
describe("reconcileDerivations — one model-authored command is not ground truth", () => {
  it("accepts a value only when two independent derivations land on it", () => {
    expect(reconcileDerivations(29, 29)).toEqual({ truth: 29 });
  });

  it("abstains when the derivations disagree, naming both so the miss is diagnosable", () => {
    // The live case: a line-count and a commit-count cannot both be right, and the gate has no
    // basis to pick. Abstaining costs a verdict; asserting one costs the learner.
    const r = reconcileDerivations(147, 29);
    expect(r.truth).toBeNull();
    expect((r as { reason: string }).reason).toMatch(/147 vs 29/);
  });

  it("abstains when only one derivation produced a measurement", () => {
    expect(reconcileDerivations(29, null).truth).toBeNull();
    expect(reconcileDerivations(null, 29).truth).toBeNull();
    expect(reconcileDerivations(null, null).truth).toBeNull();
  });
});

/**
 * OBSERVED LIVE: "[recompute] first authoring threw: JSON Parse error: Invalid escape
 * character" — while the second derivation returned the correct answer. Triangulation needs
 * both, so one parse error turns a working verdict into an abstention that looks exactly
 * like healthy caution.
 */
describe("parseAuthoredCommand — a measuring command is full of backslashes", () => {
  it("reads well-formed JSON", () => {
    expect(parseAuthoredCommand('{"command":"find /x -type f | wc -l"}')).toBe("find /x -type f | wc -l");
    expect(parseAuthoredCommand('here you go:\n{"command":"git -C /x rev-list --count HEAD"}\nthanks'))
      .toBe("git -C /x rev-list --count HEAD");
  });

  it("repairs the single-backslash escapes a shell one-liner is made of", () => {
    // find's escaped parens — the exact shape that killed derivation 1.
    expect(parseAuthoredCommand('{"command":"find /x \\( -name node_modules \\) -prune -o -type f -print | wc -l"}'))
      .toContain("-prune");
    expect(parseAuthoredCommand(String.raw`{"command":"awk -F '\.' '{print $(NF)}' | sort -u | wc -l"}`))
      .toContain("awk -F");
  });

  it("keeps legal JSON escapes intact rather than doubling them", () => {
    const out = parseAuthoredCommand('{"command":"grep -c \\"async\\" /x/a.ts"}');
    expect(out).toBe('grep -c "async" /x/a.ts');
  });

  it("returns null when there is no command to find", () => {
    expect(parseAuthoredCommand("I cannot answer that")).toBeNull();
    expect(parseAuthoredCommand('{"notacommand":"x"}')).toBeNull();
    expect(parseAuthoredCommand('{"command":"   "}')).toBeNull();
  });
});

/**
 * largest_file asks "…has the most lines? Give its FILENAME" and sits at 0/12 every round —
 * not because the plane is down, but because recompute could only grade numbers.
 */
describe("token answers — the capability boundary behind largest_file 0/12", () => {
  it("reads a bare filename, which is what those commands emit", () => {
    expect(parseMeasuredToken("faiss-index.ts\n")).toBe("faiss-index.ts");
    expect(parseMeasuredToken("/workspace/git/vessels/x/src/index.ts")).toBe("index.ts");
  });

  it("refuses wc's summary label — accepting it is how the last regression happened", () => {
    // "total" is the label on wc's summary line. A parser that returns it as the answer is
    // confidently wrong, and a wrong truth here CARRIES beta.
    expect(parseMeasuredToken("total")).toBeNull();
    expect(parseMeasuredToken("  42 total")).toBeNull();
    expect(parseMeasuredToken("42")).toBeNull();          // numeric path owns this
    expect(parseMeasuredToken("two words.ts")).toBeNull();
  });

  it("grades against answer-context lines, not the whole digest", () => {
    // A digest containing a directory listing would otherwise match ANY filename — the
    // bag-of-integers trap in string form.
    expect(gradeTokenRecompute("index.ts", extractEmittedTokens("The largest module is index.ts with 2679 lines."))).toBe("agree");
    expect(gradeTokenRecompute("index.ts", extractEmittedTokens("The largest module is router.ts."))).toBe("disagree");
    expect(gradeTokenRecompute("index.ts", extractEmittedTokens("no answer here"))).toBe("no-measurement");
  });

  it("is case-insensitive on the filename but not sloppy about what a filename is", () => {
    expect(gradeTokenRecompute("Index.TS", extractEmittedTokens("answer: index.ts"))).toBe("agree");
    expect(extractEmittedTokens("the ratio was 3.14 overall")).toEqual([]);
  });
});
