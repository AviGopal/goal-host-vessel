/**
 * Row: check-goal-wrapper-says-edit-in-place-do-not-create-a-new-file-contradicting-the-test-writing-create-file-plan.
 *
 * A check-supply test-writing goal names only its check file (repos/<vessel>/test/checks/<slug>.check.ts), which
 * normally does not exist yet. Both single-file spec sites (the early edit-intent route and the routed non-create
 * branch) told the drafter "EDIT IT IN PLACE … do NOT create a new file". The fix builds that line in one exported
 * helper, which tells a check-supply goal to CREATE its check file and gives every other goal the old line byte for
 * byte (25 verdict-diff goldens carry it, one of them a check-supply goal that names a src file).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const INDEX = readFileSync(join(ROOT, "src/index.ts"), "utf8");
const HELPER_PATH = join(ROOT, "src/edit-intent-target.ts");
const HELPER_SRC = existsSync(HELPER_PATH) ? readFileSync(HELPER_PATH, "utf8") : "";

const CHECK_FILE = "repos/development-vessel/test/checks/a-check-supply-dispatch-can-record-no-dispatch-id-so-its-out.check.ts";
const SRC_FILE = "repos/goal-host-vessel/src/quiesce.ts";
const SUPPLY = { check_supply: true, gap_id: "some-gap", dispatch_id: "d-1" };
const OLD = (f: string) => `Target file — EDIT IT IN PLACE: emit \`edit\` ops on this EXACT path only; do NOT create a new file, vessel, or package.json: ${f}`;

async function helper(): Promise<typeof import("../src/edit-intent-target")> {
  return await import("../src/edit-intent-target");
}

describe("a check-supply goal is told to create its check file", () => {
  test("MUST-FAIL: neither single-file spec site in index.ts hard-codes the edit-in-place line any more", () => {
    expect(INDEX.includes("EDIT IT IN PLACE")).toBe(false);
  });

  test("MUST-FAIL: both single-file spec sites build the line from the goal's variables", () => {
    expect(INDEX).toContain(": singleFileTargetLine(earlyEditFile, opts.variables)");
    expect(INDEX).toContain(": singleFileTargetLine(editFile, opts.variables)");
  });

  test("MUST-FAIL: the check supply's goal for its check file is told to create_file it, never not to create a file", async () => {
    const { singleFileTargetLine } = await helper();
    const line = singleFileTargetLine(CHECK_FILE, SUPPLY);
    expect(line).toContain("create_file");
    expect(line).not.toContain("do NOT create a new file");
    expect(line.endsWith(CHECK_FILE)).toBe(true);
    // the bare flag counts as well, the same test the sibling check-supply sites use
    expect(singleFileTargetLine(CHECK_FILE, { check_supply: true })).toContain("create_file");
  });
});

describe("every other goal is told what it was told before", () => {
  test("CONTROL: the old line, byte for byte, still exists in the tree", () => {
    expect(INDEX + HELPER_SRC).toContain("`Target file — EDIT IT IN PLACE: emit \\`edit\\` ops on this EXACT path only; do NOT create a new file, vessel, or package.json: ${");
  });

  test("CONTROL: the multi-file wording is unchanged at both sites", () => {
    const multi = "`Target files — apply ops ONLY on these exact paths, creating any path that does not yet exist and editing the rest in place; EVERY named file needs its full required change (no wired stubs); no other new files, vessels, or package.json changes: ${";
    expect(INDEX.split(multi).length - 1).toBe(2);
  });

  test("CONTROL: an ordinary goal, a check-supply goal naming a src file, and a check file without the supply keep the old line", async () => {
    const { singleFileTargetLine } = await helper();
    expect(singleFileTargetLine(SRC_FILE, undefined)).toBe(OLD(SRC_FILE));
    expect(singleFileTargetLine(SRC_FILE, {})).toBe(OLD(SRC_FILE));
    expect(singleFileTargetLine(SRC_FILE, SUPPLY)).toBe(OLD(SRC_FILE));
    expect(singleFileTargetLine(CHECK_FILE, undefined)).toBe(OLD(CHECK_FILE));
    expect(singleFileTargetLine(CHECK_FILE, { check_supply: "true" })).toBe(OLD(CHECK_FILE));
    // a test that is not a check file is not the supply's check file
    expect(singleFileTargetLine("repos/goal-host-vessel/test/quiesce.test.ts", SUPPLY)).toBe(OLD("repos/goal-host-vessel/test/quiesce.test.ts"));
  });
});
