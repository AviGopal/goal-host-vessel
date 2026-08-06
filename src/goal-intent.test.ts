import { describe, expect, it } from 'bun:test';

import { goalRequestsDurableArtifact, isEditIntentGoal } from './goal-intent';

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

describe('goalRequestsDurableArtifact', () => {
  it('OBSERVED LIVE: the goal that reached and wrote nothing must be recognised', () => {
    // dispatch cb45905c — the floor shortcut skipped the walk, reached with 6/7 tools,
    // delivered its verdict, and never created the note the goal named.
    expect(goalRequestsDurableArtifact('Summarise the purpose of repos/llm-resolver-vessel based on its README and record it as a durable note titled llm-resolver-vessel-purpose.')).toBe(true);
  });

  it('needs BOTH a verb and a durable noun, so a bare question is not an artifact ask', () => {
    expect(goalRequestsDurableArtifact('how many TypeScript modules are under repos/x/src')).toBe(false);
    expect(goalRequestsDurableArtifact('record the count')).toBe(false);      // verb, no durable noun
    expect(goalRequestsDurableArtifact('what is in the vault')).toBe(false);  // noun, no verb
  });

  it('matches the writ- stem the bridge relies on', () => {
    expect(goalRequestsDurableArtifact('write a note about the registry')).toBe(true);
    expect(goalRequestsDurableArtifact('written findings for the audit')).toBe(true);
  });
});
