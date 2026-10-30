import { describe, it, expect } from "bun:test";
import * as mod from "../../src/write-door";

describe("writeDropLine refusal messages", () => {
  it('reports refused store write as "not in the goal\'s product"', () => {
    let capturedLine: string | undefined;
    const record = (line: string) => {
      capturedLine = line;
    };

    // This is the scenario described in the goal: a store write shape
    // that is not part of the goal's product.
    // `admitted` is false, so the write door is active.
    // `refusedWrite` will see that 'memoryNote_write' is a store write
    // but not in `goalProduct`, so it will be refused.
    mod.writeDoorShapes(
      ['memoryNote_write'],
      false, // admitted
      'satisfier',
      'test-goal-hash-1',
      record,
      new Set(['some-other-shape']) // goalProduct
    );

    // The bug is that writeDropLine returns a generic "goal not admitted as a change"
    // message for all refusals. This test asserts the correct, specific message.
    const expected = `[write-door] dropped memoryNote_write: not in the goal's product (door=satisfier, goal_hash=test-goal-hash-1)`;
    
    // This assertion will fail until the bug is fixed.
    expect(capturedLine).toBe(expected);
  });

  it('reports refused change shape as "goal not admitted as a change" (CONTROL)', () => {
    let capturedLine: string | undefined;
    const record = (line: string) => {
      capturedLine = line;
    };

    // This is a control case. 'fs_write' is a change shape.
    // When `admitted` is false, it should be refused. The "goal not admitted as a change"
    // message is correct in this context. This behavior should be preserved.
    mod.writeDoorShapes(
      ['fs_write'],
      false, // admitted
      'target',
      'test-goal-hash-2',
      record,
      new Set() // goalProduct is irrelevant for change shapes
    );

    const expected = `[write-door] dropped fs_write: goal not admitted as a change (door=target, goal_hash=test-goal-hash-2)`;

    // This assertion should pass before and after the fix.
    expect(capturedLine).toBe(expected);
  });
});
