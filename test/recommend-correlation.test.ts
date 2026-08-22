/**
 * The walk must carry the correlation id of the recommendation it actually selected.
 *
 * THE REGRESSION THIS PINS. `/recommend` mints a `correlation_id` per recommendation and
 * writes it to `thompson_selection_log`; the trace-store route accepts it back on the
 * execution ("Selection-to-execution correlation (from /recommend endpoint)"). Both ends
 * were built. Nothing carried the value between them, because `recommendExcluding`
 * returned the template id alone and dropped the rest of the recommendation.
 *
 * Measured on the live substrate 2026-08-22:
 *   correlation_id populated on 0 of 8,650 non-auth executions
 *   v_selection_outcomes: 226 rows, and NOT ONE carries an outcome field —
 *     every column is selection-side (alpha_at_selection, selection_probability)
 *
 * So Thompson's own choices could never be graded AS choices. Credit reaches arms (keyed
 * on activity_id) but never reaches decisions, which is exactly the
 * counterfactual-at-decision-time record law 12 asks for.
 *
 * WHY A TAG. The value rides the prefixed-tag provenance channel the walk already uses
 * (`dispatcher_used:`, `state_signature:`, `satisfier_shape:`, `edit_intent:`), so it
 * needs no schema change and lands on the execution through the `tags` path already
 * threaded to host.runGoal.
 *
 * The load-bearing property is ATTRIBUTION CORRECTNESS, not merely presence: the id must
 * belong to the recommendation that was picked. Reporting the first recommendation's id
 * while executing a different arm would attribute an outcome to a decision that was never
 * taken — worse than no link at all, and precisely the class of defect this audit exists
 * to find.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RAW = readFileSync(join(import.meta.dir, '..', 'src', 'index.ts'), 'utf8');
// Comment lines are stripped before matching: this fix's own comments quote the shapes
// they describe, and matching prose instead of code is a trap this codebase has hit.
const SRC = RAW.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('recommend → execution correlation', () => {
  test('THE REGRESSION: recommendExcluding no longer returns a bare id', () => {
    // Returned `Promise<string | null>` before, which is what discarded correlation_id.
    expect(SRC).toMatch(/async function recommendExcluding\([^)]*\):\s*Promise<RecommendPick \| null>/);
  });

  test('it reads correlation_id off the recommendation it selected', () => {
    expect(SRC).toMatch(/correlation_id/);
    // Read from the loop variable `x` — the picked recommendation — not from the response
    // envelope or the first element.
    expect(SRC).toMatch(/x\?\.correlation_id/);
  });

  test('ATTRIBUTION: the id is captured inside the selection branch, not before it', () => {
    // Guards the property that matters. The capture must sit after the exclusion and
    // shape filters, in the same block that returns the chosen id.
    const fn = SRC.slice(
      SRC.indexOf('async function recommendExcluding'),
      SRC.indexOf('function correlationTag'),
    );
    const returnIdx = fn.indexOf('return { id, correlationId }');
    const captureIdx = fn.indexOf('x?.correlation_id');
    expect(captureIdx).toBeGreaterThan(-1);
    expect(returnIdx).toBeGreaterThan(captureIdx);
    // and both must be inside the guarded branch
    const guardIdx = fn.indexOf('!excludedNorm.has(norm(id))');
    expect(captureIdx).toBeGreaterThan(guardIdx);
  });

  test('the dispatch carries it as a correlation: tag', () => {
    expect(SRC).toMatch(/tags:\s*\[\.\.\.\(opts\.tags \?\? \[\]\),\s*\.\.\.correlationTag\(pickCorrelationId\)\]/);
  });

  test('every call site threads it — none silently drops the pick', () => {
    // Three call sites feed recommendExcluding's result into dispatch. A site that takes
    // `.id` without recording `.correlationId` would leave that attempt unattributable.
    const callSites = SRC.split('\n').filter((l) => /await recommendExcluding\(/.test(l));
    expect(callSites.length).toBe(3);
    const assignments = SRC.split('\n').filter((l) => /pickCorrelationId\s*=/.test(l));
    // one per call site (plus the declaration, which uses `let ... =`)
    expect(assignments.length).toBeGreaterThanOrEqual(3);
  });

  test('the tag is omitted rather than fabricated when there is no correlation id', () => {
    const fn = SRC.slice(SRC.indexOf('function correlationTag'), SRC.indexOf('function correlationTag') + 400);
    expect(fn).toMatch(/length > 0/);
    expect(fn).toMatch(/:\s*\[\]/);
  });

  test('NEGATIVE CONTROL: the pre-fix signature would fail the first assertion', () => {
    const preFix = 'async function recommendExcluding(goalText: string): Promise<string | null> {';
    expect(/Promise<RecommendPick \| null>/.test(preFix)).toBe(false);
    expect(/Promise<string \| null>/.test(preFix)).toBe(true);
  });
});
