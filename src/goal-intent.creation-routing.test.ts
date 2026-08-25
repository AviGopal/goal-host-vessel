import { isEditIntentGoal } from './goal-intent';
import { describe, expect, it } from 'bun:test';

describe('isEditIntentGoal — creation verbs route as edit-intent (regression for 13f7440)', () => {
  it('matches a creation verb with a concrete repos path', () => {
    expect(isEditIntentGoal('Create repos/foo/bar.ts with a helper')).toBe(true);
    expect(isEditIntentGoal('Author repos/x/y.ts')).toBe(true);
  });
  it('does not match a read goal that merely names a file', () => {
    expect(isEditIntentGoal('Summarise repos/x/y.ts')).toBe(false);
  });
});