// A goal-host startup that loses the race to a saturated dev-vessel (/shapes > 5 s) registered every dev-vessel shape
// through the DISCOVERY proxy, which had neither dev-envelope rule: a structuredError read as success, and
// json_path_extract handed on its whole {value,path,valueJson} object (it broke the trace-store reconcile's JSON body).
// The dev-vessel poll never took the shapes back. Source-only: importing src/index.ts reads the live dispatch store.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");
const fnBody = (name: string, len = 9000): string => { const i = SRC.indexOf(`function ${name}(`); expect(i).toBeGreaterThan(0); return SRC.slice(i, i + len); };

describe("proxy startup race and the shared dev envelope", () => {
  test("[MUST-FAIL on base] the discovery proxy applies the dev-envelope rules (structuredError throws; known shapes unwrap)", () => {
    const disc = fnBody("buildDiscoveryProxyResolver");
    expect(disc).toContain("devEnvelopeThrowIfError(`${shape} via ${endpoint}`, pObj);");
    expect(disc).toContain("impulseContent = devEnvelopeUnwrap(parsed);");
    const unwrap = fnBody("devEnvelopeUnwrap", 4000);
    expect(unwrap).toContain(`innerShapeName === "json_extracted_value"`);
    // the dev-vessel proxy uses the same unwrap
    expect(fnBody("buildProxyResolver")).toContain("const impulseContent: unknown = devEnvelopeUnwrap(parsed);");
    // the shared throw emits the carrier format the fixture parses (… resolver returned structuredError (<reason>): …)
    expect(fnBody("devEnvelopeThrowIfError", 900)).toContain("resolver returned structuredError (${reason}): ${detail.slice(0, 200)}");
  });

  test("[MUST-FAIL on base] a lost race heals: discovery-only shapes are reclaimed by the dev-vessel registration", () => {
    expect(SRC).toContain("const discoveryOnlyProxyShapes = new Set<string>();");
    const disc = fnBody("registerDiscoveryProxies", 4000);
    expect(disc).toContain("discoveryOnlyProxyShapes.add(shape);");
    const dev = fnBody("registerDevVesselProxies", 4000);
    expect(dev).toContain("if (registeredProxyShapes.has(shape) && !discoveryOnlyProxyShapes.has(shape)) continue;");
    expect(dev).toContain("if (discoveryOnlyProxyShapes.delete(shape)) reclaimed.push(shape); else added.push(shape);");
  });
});
