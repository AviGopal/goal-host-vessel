/**
 * THE SINGLE-FILE TARGET LINE of an edit-intent compose spec (the early route and the routed non-create branch of
 * src/index.ts both build it here).
 *
 * Every single-file edit-intent goal used to be told "EDIT IT IN PLACE … do NOT create a new file". A test-writing goal
 * from the check supply names only its check file, repos/<vessel>/test/checks/<slug>.check.ts (development-vessel
 * gap-check-supply's checkSupplyCheckFile), which normally does not exist yet, so feature_compose has to create it.
 * The old line told the drafter the opposite. For that goal, and only that goal, the line says to CREATE the check
 * file, in the same words the create-intent branch already uses. Every other goal gets the old line byte for byte.
 *
 * "Test-writing goal" is read from the structured variables only (the same test the sibling check-supply sites use),
 * never from goal text, and only when the named file is a check file, so a check-supply goal that names a src file
 * is told what it was told before.
 */
import { checkSupplyRouteOf } from "./compose-gap-id";

const CHECK_FILE = /^repos\/[^/]+\/test\/checks\/[^/]+\.check\.ts$/;

/** Whether this compose is the check supply's test-writing goal for its check file. */
export function isCheckSupplyCheckFileTarget(file: string, variables: Record<string, unknown> | undefined): boolean {
  const checkSupply = checkSupplyRouteOf(variables) !== null || variables?.["check_supply"] === true;
  return checkSupply && CHECK_FILE.test(file);
}

/** The spec's target line for a single-file edit-intent goal. */
export function singleFileTargetLine(file: string, variables: Record<string, unknown> | undefined): string {
  if (isCheckSupplyCheckFileTarget(file, variables)) {
    return `Target file — the CHECK FILE this test-writing goal writes: CREATE it with a \`create_file\` op if it does not yet exist; edit it in place if it does. Ops on this EXACT path only; no other new files, vessels, or package.json changes: ${file}`;
  }
  return `Target file — EDIT IT IN PLACE: emit \`edit\` ops on this EXACT path only; do NOT create a new file, vessel, or package.json: ${file}`;
}
