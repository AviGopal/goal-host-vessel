// Wiring for unregistered-step.test.ts: the walk judges every pick's step resolvers against the discovery registry
// before it dispatches the pick, and a bridge is minted only for a shape a resolver serves. Source-level, so on the
// old form each assertion fails for that reason (the pick ran and failed inside the executor instead).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
const slice = (from: string, to: string): string => {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a);
  return a < 0 || b < 0 ? "" : src.slice(a, b);
};
const execute = slice("// (d) EXECUTE the pick SEEDED WITH THE POOL", "trace = await host.runTemplate(template");
const bridge = slice("// (c.2) MINT-AS-YOU-GO", "await authorProducer(");
const live = slice("const liveShapes = async (): Promise<Set<string>> => {", "const minted = new Set<string>();");

describe("[MUST-FAIL] the execute step refuses a pick whose step resolver is unregistered, before runTemplate", () => {
  test("the fetched template is judged by firstUnregisteredStep against the registry predicate", () => {
    expect(execute).toContain("await stepServed()");
    expect(execute).toContain("firstUnregisteredStep(template, served,");
  });
  test("a refused pick is excluded, its shaped reason recorded in pickFailures and the step's excluded list, and not dispatched", () => {
    expect(execute).toContain("unregisteredStepReason(unserved)");
    expect(execute).toContain("pickFailures.set(pick.id, reason)");
    expect(execute).toContain("ineligibleReasons.set(normActivityId(pick.id), reason)");
    expect(execute).toMatch(/INELIGIBLE[\s\S]*continue;/);
    expect(src).toContain("reason: ineligibleReasons.get(id) ?? ");
  });
});

describe("[MUST-FAIL] a bridge to an unregistered shape is ineligible at the bridge pick", () => {
  test("the bridge target must be served by a resolver, not only appear as some activity's output", () => {
    expect(bridge).toContain("const served = await stepServed();");
    expect(bridge).toMatch(/missingTargets\.find\(\(s\) => live\.has\(s\) && \(served \? served\(s\) : true\)/);
  });
});

describe("the registry predicate reuses the walk's own discovery read and keeps activity outputs in liveShapes", () => {
  test("the registry-only set is taken before activity outputs are unioned in, and is null when discovery was unread", () => {
    const reg = live.indexOf("registryResolverShapes = discoveryRead ? new Set(liveResolverShapes) : null;");
    const act = live.indexOf("for (const s of activityProducedShapes) liveResolverShapes.add(s);");
    expect(reg).toBeGreaterThan(-1);
    expect(act).toBeGreaterThan(reg);
    expect(live).toContain("DISCOVERY_SHAPES_ENDPOINT");
  });
});
