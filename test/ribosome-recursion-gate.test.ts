import { describe, it, expect } from "bun:test";

/**
 * THE RIBOSOME MUST NOT EXTRACT LEARNED TEMPLATES FROM LEARNED TEMPLATES.
 *
 * Defect 4 of the 2026-08-13 self-development wiring audit, verified still live 2026-08-17.
 *
 * The extraction gate lives in ribosome-extract's assess_quality prompt: "if templateAuthor is
 * one of [ribosome, ribosome-pattern, ribosome-sequence], output extractionEligible=false".
 * goal-host passed `templateAuthor: ""` into every lifecycle payload, so the gate never
 * matched and learned templates were themselves extracted — learned-of-learned nesting up to
 * seven deep. One such family recorded 202 executions and 0 successes while still being
 * selected.
 *
 * The author is derived from the id rather than fetched. That is sound because the ribosome's
 * own synthesis rule mints `learned-<parent-slug>` and explicitly forbids a timestamp, counter
 * or hash suffix ("DETERMINISM IS REQUIRED"), so the `learned-` prefix is exactly the
 * ribosome-authored set. A store round-trip on this path would cost a fetch per reach to learn
 * something the id already states.
 *
 * This is a source-level assertion because the surrounding function builds a lifecycle payload
 * and dispatches it; importing index.ts boots the vessel's HTTP server.
 */

const SRC = new URL("../src/index.ts", import.meta.url);

describe("ribosome recursion gate — the lifecycle payload carries a real author", () => {
  it("THE REGRESSION: templateAuthor is no longer a bare empty string", async () => {
    const src = await Bun.file(SRC).text();
    const idx = src.indexOf("templateAuthor:");
    expect(idx).toBeGreaterThan(-1);
    const line = src.slice(idx, src.indexOf("\n", idx));
    // Before the fix this was exactly `templateAuthor: "",`.
    expect(line.trim()).not.toBe('templateAuthor: "",');
    expect(line).toContain("learned-");
    expect(line).toContain("ribosome-pattern");
  });

  it("the derivation keys on the id prefix the ribosome guarantees", async () => {
    const src = await Bun.file(SRC).text();
    expect(src).toMatch(/templateAuthor:\s*\(trace\.templateId\s*\?\?\s*""\)\.startsWith\("learned-"\)/);
  });

  it("a non-learned template still reports no author — the gate must not over-trigger", async () => {
    // Deriving `ribosome-pattern` for everything would suppress ALL extraction, converting a
    // recursion bug into a total mint outage. The ternary must keep the empty default.
    const src = await Bun.file(SRC).text();
    const idx = src.indexOf("templateAuthor: (trace.templateId");
    const line = src.slice(idx, src.indexOf("\n", idx));
    expect(line).toMatch(/:\s*""/);
  });

  it("the gate it arms still lists the ribosome family it matches against", async () => {
    // If the prompt's skip-list is ever renamed, deriving "ribosome-pattern" here silently
    // stops matching — the two sides must be checked together, which is the write-key/read-key
    // discipline this session has paid for repeatedly.
    const tmpl = await Bun.file(
      new URL("../../ias-executor-ts/src/templates/lifecycle/ribosome-extract.json", import.meta.url),
    ).text();
    expect(tmpl).toContain("ribosome-pattern");
    expect(tmpl).toContain("recursion-safety");
  });
});
