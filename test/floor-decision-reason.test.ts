// The floor says WHY it decided. Its verdict line logged reached= only, and the dispatch then recorded the walk's
// earlier reason, so a grounded floor answer that failed read as the walk's "error-envelope" and the floor's own
// reason was observable nowhere. The decision line carries the rule's reason_code and the judge's reason (or that the
// verifier gave no verdict). Source-only: importing src/index.ts reads the live dispatch store and arms timers, so
// this file reads the text and never imports the module.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INDEX = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");

describe("floor decision reason", () => {
  test("[MUST-FAIL on base] a decision line names the rule's reason_code and the judge's reason", () => {
    const line = INDEX.split("\n").find((l) => l.includes("floor: decision goalHash="));
    expect(line).toBeDefined();
    expect(line!).toContain("rule=${_floorV.reason_code}");
    expect(line!).toContain("judge=${verdict === null ? \"null (verifier gave no verdict)\"");
    expect(line!).toContain("String(verdict.reason ?? \"\")");
  });

  test("it is printed after the decision is final, not before", () => {
    const decided = INDEX.indexOf("const floorReached = _floorV.reached;");
    const logged = INDEX.indexOf("floor: decision goalHash=");
    expect(decided).toBeGreaterThan(0);
    expect(logged).toBeGreaterThan(decided);
    // nothing between the decision and the line reassigns the verdict's reason
    expect(INDEX.slice(decided, logged)).not.toContain("verdict.reason =");
  });

  test("the existing verdict line is unchanged (collectors read it)", () => {
    expect(INDEX).toContain("floor: verdict goalHash=${goalHashOf(goal)} verdictNull=${verdict === null} reached=${verdict?.reached === true} groundedOk=${groundedOk} finalTextLen=${finalText.length}`");
  });
});
