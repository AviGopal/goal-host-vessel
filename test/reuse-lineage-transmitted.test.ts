import { describe, it, expect } from "bun:test";

/**
 * REUSE LINEAGE IS NOW TRANSMITTED — AND A REJECTION MUST NOT DESTROY THE RECORD.
 *
 * recordGoalPath computed which pathway a walk borrowed and then threw it away to a log
 * line, "REUSE LINEAGE (not yet storable)", because the only lineage fields on the route
 * (parent_goal_hash / parent_path_signature) carry the CC1 scope-narrowing assertion.
 * Borrowed-pathway reuse is the opposite relation, so CC1 rejected the write: measured once
 * on a REACHED 2-step reuse, sending parent_* did not add lineage, it DESTROYED the record
 * with a 400 — for exactly the reused walks that matter most to compounding.
 *
 * activity-api 4e0d27a added sibling fields with no scope assertion (migration 204). This
 * transmits them.
 *
 * THE SAFETY NET IS THE LOAD-BEARING PART OF THIS TEST. Receiver-before-sender ordering is
 * the plan, but pull-sync lag is 10-20 minutes and reports success while skipping, so a
 * window where the sender is newer than the receiver is a real possibility. A rejected write
 * loses the WHOLE record, not just the lineage — the same class as the 8x optimism bias this
 * function's own comment records. Retrying once WITHOUT the fields converts "record
 * destroyed" back into "lineage lost for one walk", which is exactly today's behaviour.
 */

const SRC = new URL("../src/index.ts", import.meta.url);
const src = async (): Promise<string> => await Bun.file(SRC).text();

function recordGoalPathBody(s: string): string {
  const i = s.indexOf("async function recordGoalPath");
  expect(i).toBeGreaterThan(-1);
  return s.slice(i, i + 6500);
}

describe("reuse lineage is transmitted", () => {
  it("sends the sibling fields, not parent_* (which CC1 would reject)", async () => {
    const b = recordGoalPathBody(await src());
    expect(b).toContain("reused_from_goal_hash");
    expect(b).toContain("reused_from_path_signature");
    // THE REGRESSION GUARD: routing this relation through parent_* is what destroyed the
    // record. If someone "simplifies" by reusing those fields, this fails.
    expect(b).not.toContain("parent_goal_hash:");
    expect(b).not.toContain("parent_path_signature:");
  });

  it("only sends lineage when a pathway was genuinely borrowed", async () => {
    // Law 12. Recording the pathway the walk was OFFERED rather than the one it TOOK would
    // manufacture exactly the correlation that makes reuse look effective.
    const b = recordGoalPathBody(await src());
    expect(b).toMatch(/const reuseFields = \(parent\?\.goalHash \|\| parent\?\.pathSignature\)/);
  });

  it("no longer claims the fact is unstorable", async () => {
    const b = recordGoalPathBody(await src());
    expect(b).not.toContain("REUSE LINEAGE (not yet storable)");
    expect(b).toContain("REUSE LINEAGE (transmitted)");
  });
});

describe("a rejection must not destroy the record", () => {
  it("retries once WITHOUT the reuse fields on a non-ok response", async () => {
    const b = recordGoalPathBody(await src());
    expect(b).toContain("postGoalPath(true)");
    expect(b).toContain("postGoalPath(false)");
    expect(b).toMatch(/if \(!res\.ok && reuseFields\)/);
  });

  it("the retry is announced, not silent", async () => {
    // A silent downgrade would hide a receiver that never got the fields — and the point of
    // the change is that reuse attribution stops being invisible.
    const b = recordGoalPathBody(await src());
    expect(b).toMatch(/REJECTED \$\{res\.status\} WITH reuse lineage/);
  });

  it("still reports a rejection that survives the retry", async () => {
    // The pre-existing loud-failure behaviour must not be swallowed by the new retry.
    const b = recordGoalPathBody(await src());
    expect(b).toContain("this walk will not inform future reuse");
  });
});
