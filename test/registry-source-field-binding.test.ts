import { describe, it, expect } from "bun:test";
import { registryFieldFor, registryCountCommandFor } from "../src/registry-field";

// WHY THIS IS A BINDING AND NOT MORE PROMPT TEXT (2026-08-17).
//
// Asked "how many shapes does the discovery registry advertise in total" — true answer 368 —
// the walk answered 12: the length of the advertised_shapes array inside a vessel health
// report it had already fetched. A prompt qualification was added; it answered 13, the
// registry's VESSEL count. Same rate, different wrong column:
//
//     prohibition     1 correct / 1 wrong   (stated 12)
//     worked example  1 correct / 1 wrong   (stated 13)
//
// The second failure is the informative one. By then the walk WAS querying registry/stats —
// the right source — and reading the wrong field out of the response. A binding that names
// only the source cannot prevent that, so this names the source AND the field.
//
// The field is chosen by registryFieldFor, which the VERIFIER also calls. That is the point
// of extracting it: an oracle and a producer that disagree about which quantity the goal
// asked for is exactly how a correct answer gets graded wrong — this oracle did that six
// times, each earlier fix guarding the symptom rather than the invariant.

describe("registryFieldFor — the counted entity decides the field", () => {
  it("takes the noun attached to the counting clause, not any noun in the goal", () => {
    // THE REGRESSION: "the vessel X" is a different clause from "how many shapes".
    expect(registryFieldFor("Produce a health report for the vessel goal-host-vessel. Then determine how many shapes the discovery registry advertises in total.")).toBe("totalShapes");
  });

  it("selects totalVessels when vessels are what is counted", () => {
    expect(registryFieldFor("determine how many vessels the discovery registry reports in total")).toBe("totalVessels");
  });

  it("selects healthyCount only when the count is qualified healthy", () => {
    expect(registryFieldFor("how many vessels does the registry report as healthy")).toBe("healthyCount");
  });

  it("ABSTAINS with no counting clause — abstention costs a judgement, guessing poisons a posterior", () => {
    expect(registryFieldFor("produce a health report for the vessel goal-host-vessel")).toBeNull();
  });

  it("ABSTAINS on an entity the registry does not report", () => {
    expect(registryFieldFor("how many activities does the discovery registry advertise")).toBeNull();
  });
});

describe("registryCountCommandFor — binds source AND field", () => {
  const EP = "http://127.0.0.1:8100";

  it("emits the query for the field the goal actually asked for", () => {
    const cmd = registryCountCommandFor("Produce a health report for the vessel goal-host-vessel. Then determine how many shapes the discovery registry advertises in total.", EP);
    expect(cmd).toBe("curl -s http://127.0.0.1:8100/registry/stats | jq .totalShapes");
  });

  it("THE 13 CASE: a vessel-count goal binds totalVessels, not totalShapes", () => {
    expect(registryCountCommandFor("how many vessels does the discovery registry report in total", EP))
      .toBe("curl -s http://127.0.0.1:8100/registry/stats | jq .totalVessels");
  });

  it("abstains for a non-registry goal, leaving synthesis untouched", () => {
    expect(registryCountCommandFor("count the .ts files under src and write the number to a note", EP)).toBeNull();
  });

  it("abstains when the registry is named but nothing is counted", () => {
    expect(registryCountCommandFor("describe what the discovery registry is for", EP)).toBeNull();
  });

  it("producer and verifier cannot disagree — the command's field IS registryFieldFor's", () => {
    for (const g of [
      "how many shapes the discovery registry advertises in total",
      "how many vessels the discovery registry reports in total",
      "how many vessels the registry reports as healthy",
    ]) {
      expect(registryCountCommandFor(g, EP)).toContain(`jq .${registryFieldFor(g)}`);
    }
  });
});
