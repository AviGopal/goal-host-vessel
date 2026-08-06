import { describe, expect, it } from 'bun:test';

import { isEditIntentGoal } from './goal-intent';

/**
 * This predicate now gates two decisions in the same function — edit-intent routing late,
 * and whether a reused floor pathway may skip the walk early. A false positive here sends
 * a read goal down the commit path; a false negative diverts a code change to the ReAct
 * floor, which reads and reasons but lands nothing, so the goal reports an answer and
 * changes no code.
 */
describe('isEditIntentGoal', () => {
  it('matches a concrete file plus a mutation verb', () => {
    expect(isEditIntentGoal('In repos/goal-host-vessel/src/index.ts, fix the sink resolution')).toBe(true);
    expect(isEditIntentGoal('add a guard to repos/activity-api/src/lib/reach-classify.ts')).toBe(true);
  });

  it('does NOT match a read goal that merely names a file', () => {
    expect(isEditIntentGoal('Summarise repos/discovery-vessel/src/index.ts')).toBe(false);
    expect(isEditIntentGoal('how many TypeScript modules are under repos/boredom-vessel/src')).toBe(false);
  });

  it('does NOT match a mutation verb with no concrete file', () => {
    // "update" against a vessel, not a path — the walk's business, not the edit path.
    expect(isEditIntentGoal('update the discovery registry advertisement')).toBe(false);
  });

  it('requires a file EXTENSION, not just a repos/ prefix', () => {
    expect(isEditIntentGoal('refactor repos/goal-host-vessel/src')).toBe(false);
  });
});
