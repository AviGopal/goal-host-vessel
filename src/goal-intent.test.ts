import { describe, expect, it } from 'bun:test';

import { goalDemandsLandedEdit, goalRequestsDurableArtifact, isEditIntentGoal } from './goal-intent';

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

describe('goalDemandsLandedEdit — a CREATION goal must demand landing evidence too', () => {
  it('THE FIX: create/author a new source file demands a landed edit (was reached on LLM narrative)', () => {
    // Measured live (dispatch 7a8811bb): "Author a brand-new module repos/.../detect-posterior-drift.ts"
    // reached:true via the LLM judge ("The system successfully created the specified file") with the
    // file absent — a persisted false reach. Creation verbs were missing from the demand list.
    expect(goalDemandsLandedEdit('Author a brand-new module repos/development-vessel/src/seed/detect-posterior-drift.ts — a detector template following its sibling detect-* files — that flags any arm whose predicted success diverges from its actual reach rate across a large number of graded executions.')).toBe(true);
    expect(goalDemandsLandedEdit('Create the new file repos/development-vessel/src/seed/detect-calibration-drift.ts. It should define and export a single-task detector template that yields a report identifying miscalibrated arms.')).toBe(true);
    expect(goalDemandsLandedEdit('write repos/activity-api/src/lib/new-helper.ts with a helper')).toBe(true);
  });

  it('leaves existing edit-goal behavior unchanged', () => {
    expect(goalDemandsLandedEdit('In repos/goal-host-vessel/src/index.ts, fix the sink resolution')).toBe(true);
    expect(goalDemandsLandedEdit('add a guard to repos/activity-api/src/lib/reach-classify.ts')).toBe(true);
  });

  it('does NOT demand a landed edit for a read/count goal or a bare vessel mention', () => {
    expect(goalDemandsLandedEdit('how many TypeScript modules are under repos/boredom-vessel/src')).toBe(false);
    expect(goalDemandsLandedEdit('Summarise repos/discovery-vessel/src/index.ts')).toBe(false);
    expect(goalDemandsLandedEdit('write a report on how many resolvers exist')).toBe(false);
  });

  it('NON-REGRESSION: a durable-artifact NOTE write is not forced to produce a git sha', () => {
    // A note write has its own sink path and need not land a commit; demanding one would
    // falsely reject a written note (a false rejection is worse than the hole it closes).
    expect(goalDemandsLandedEdit('write a note titled X and save it to repos/development-vessel/notes/x.md')).toBe(false);
  });

  it('DOCUMENTED LIMITATION: a code-file creation that ALSO asks for a note evades the gate', () => {
    // The durable-artifact exclusion is deliberately fail-open-narrow: a goal that creates a
    // real code file BUT also says "...and document the findings in a note" trips
    // goalRequestsDurableArtifact and escapes the landing requirement — restoring today's
    // behavior for such mixed goals. Closing this needs "durable is the PRIMARY deliverable"
    // heuristics; we pin the known evasion instead of guessing, so the boundary is chosen, not
    // accidental. If this ever matters in practice, that is the signal to make it precise.
    expect(goalDemandsLandedEdit('Create repos/development-vessel/src/x-helper.ts and document the findings in a note')).toBe(false);
  });
});
