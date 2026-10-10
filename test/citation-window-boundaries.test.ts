// THE CITATION ORACLE'S LINE WINDOW IS EXACTLY ±2 (OP-1 a, qa review).
//
// A pass needs the cited file:LINE's own window — two lines either side, for a multi-line declaration — to hold the
// goal's symbol. qa found the width unpinned: ±30, ±3 and cited-line-only all passed the suite. These boundary cases
// pin it: the symbol at cited±2 passes, at cited±3 does not (and the symbol two lines off the cited line still passes,
// so "cited line only" fails them too).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realFetch = globalThis.fetch;
const prevRoot = process.env["WORKSPACE_ROOT"];
const root = mkdtempSync(join(tmpdir(), "op1-window-"));
const FILE = join(root, "src", "window.ts");
const SYMBOL = "computeWindowSymbol";
let verifyCodeInvestigationCitation: (goal: string, digest: string) => Promise<{ reached: boolean; reason?: string } | null>;
beforeAll(async () => {
  mkdirSync(join(root, "src"), { recursive: true });
  const lines = Array.from({ length: 80 }, (_, i) => `// filler ${i + 1}`);
  lines[49] = `export function ${SYMBOL}(): number { return 1; }`; // line 50 only
  writeFileSync(FILE, lines.join("\n"));
  process.env["WORKSPACE_ROOT"] = root;
  globalThis.fetch = (() => Promise.resolve(new Response("{}", { status: 404 }))) as unknown as typeof fetch;
  process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
  verifyCodeInvestigationCitation = (await import("../src/index")).verifyCodeInvestigationCitation as typeof verifyCodeInvestigationCitation;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (prevRoot === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = prevRoot;
  rmSync(root, { recursive: true, force: true });
});

const GOAL = `Find where ${SYMBOL} is defined in the codebase`;
const cite = (line: number) => verifyCodeInvestigationCitation(GOAL, `- llm_completion: ${SYMBOL} is defined at ${FILE}:${line}.`);

describe("the ±2 window, at its boundaries", () => {
  test.each([48, 52])("the symbol two lines from the cited line (%i) passes", async (line) => {
    expect((await cite(line))?.reached).toBe(true);
  });
  test.each([47, 53])("the symbol three lines from the cited line (%i) does not pass", async (line) => {
    const v = await cite(line);
    expect(v?.reached).toBe(false);
    expect(v?.reason ?? "").toMatch(/citation-unverified/);
  });
  test("CONTROL: the cited line itself passes", async () => {
    expect((await cite(50))?.reached).toBe(true);
  });
});
