import { describe, it, expect } from "bun:test";
import * as mod from "../../src/index";

describe("shellResult self-correction fixation (law 8) — machine-detectable", () => {
  it("repeats an IDENTICAL command across attempts and yields no new information", () => {
    const goal = "How many vessel services is this substrate running right now?";

    // Cold-command self-correction loop: 6 of 7 identical commands.
    const attempts = [
      "attempt 1 WAS: curl -s http://127.0.0.1:27182/vessel/services -> NOW: curl -s http://127.0.0.1:27182/vessel/services",
      "attempt 2 WAS: curl -s http://127.0.0.1:27182/vessel/services -> NOW: curl -s http://127.0.0.1:27182/vessel/services",
      "attempt 3 WAS: curl -s http://127.0.0.1:27182/vessel/services -> NOW: curl -s http://127.0.0.1:27182/vessel/services",
      "attempt 4 WAS: curl -s http://127.0.0.1:27182/vessel/services -> NOW: curl -s http://127.0.0.1:27182/vessel/services",
      "attempt 5 WAS: curl -s http://127.0.0.1:27182/vessel/services -> NOW: curl -s http://127.0.0.1:27182/vessel/services",
      "attempt 6 WAS: curl -s http://127.0.0.1:27182/vessel/services -> NOW: curl -s http://127.0.0.1:27182/vessel/services",
      "attempt 7 WAS: curl -s http://127.0.0.1:27182/vessel/services -> NOW: curl -s http://127.0.0.1:27182/vessel/services",
    ];

    // Feedback-retry reinvents the same host:port with a different path, still empty.
    const feedbackRetry = [
      "FEEDBACK-RETRY",
      "attempt 8 WAS: curl -s http://127.0.0.1:27182/vessels -> NOW: curl -s http://127.0.0.1:27182/vessels",
      "attempt 9 WAS: curl -s http://127.0.0.1:27182/vessels -> NOW: curl -s http://127.0.0.1:27182/vessels",
      "attempt 10 WAS: curl -s http://127.0.0.1:27182/vessels -> NOW: curl -s http://127.0.0.1:27182/vessels",
      "attempt 11 WAS: curl -s http://127.0.0.1:27182/vessels -> NOW: curl -s http://127.0.0.1:27182/vessels",
      "attempt 12 WAS: curl -s http://127.0.0.1:27182/vessels -> NOW: curl -s http://127.0.0.1:27182/vessels",
      "attempt 13 WAS: curl -s http://127.0.0.1:27182/vessels -> NOW: curl -s http://127.0.0.1:27182/vessels",
      "attempt 14 WAS: curl -s http://127.0.0.1:27182/vessels -> NOW: curl -s http://127.0.0.1:27182/vessels",
    ];

    // The transcript carries only empty stdout results; parser sees JSON lines and attempts/feedback notes.
    // Anchors from src/index.ts' verifier (shellResult stdout parsing) — the dig contains parsable JSON with stdout.
    // - "const digLines = dig.split('\\n').map(line => line.replace(/^-\\s+\\S+:\\s+/, '').trim());"
    // - "if (line.startsWith('{')) {"
    // - "const parsed = JSON.parse(line);"
    // - "if (typeof parsed === 'object' && parsed !== null && 'stdout' in parsed && typeof parsed.stdout === 'string')"
    // - "} catch (e) { /* not JSON or not a shellResult */ }"
    const emptyStdouts = Array.from({ length: 14 }, () => '- shellResult: {\"stdout\": \"\"}');

    const dig = [
      ...attempts,
      ...emptyStdouts.slice(0, 7),
      ...feedbackRetry,
      ...emptyStdouts.slice(7),
    ].join("\n");

    // Expectation that would hold with correct machine-detectable fixation handling:
    const verdict = mod.verifyDeterministicCompute(goal, dig);

    // Failing assertion today: defect does not produce a deterministic fixation miss.
    expect(verdict).not.toBeNull();
    expect(verdict!.reached).toBe(false);
    expect(String(verdict!.reason).toLowerCase()).toContain("fixation");
  });
});