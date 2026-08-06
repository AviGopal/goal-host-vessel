/**
 * Tests for `classifyExecutionPath` — how a terminalized dispatch is labelled
 * over the WalkTier vocabulary.
 *
 * This is what an operator is told about a run, and what every consumer of the
 * `execution_path:` trace tag counts. It previously had no test and got the
 * most common case wrong: a landed direct edit satisfies the "used a known
 * path" predicate exactly (selectedTemplateId set, attempts===1, reached),
 * so every successful feature_compose edit was counted as learned_pathway —
 * crediting pathway REUSE for work that reused nothing.
 */

import { describe, expect, test } from 'bun:test';
import { classifyExecutionPath } from '../src/execution-path';

describe('classifyExecutionPath', () => {
  test('a landed direct edit is feature_compose, not learned_pathway', () => {
    // The exact shape the early edit-intent path returns on a landed SHA.
    expect(classifyExecutionPath({
      selectedTemplateId: 'feature_compose',
      attempts: 1,
      reached: true,
      executionId: 'feature_compose:27b944a1985b27dd95b90158e6e0327273dbe81f',
    })).toBe('feature_compose');
  });

  test('a failed direct edit is still feature_compose', () => {
    // Classification describes HOW it was resolved, not whether it worked;
    // otherwise failed edits vanish from the path census entirely.
    expect(classifyExecutionPath({
      selectedTemplateId: 'feature_compose',
      attempts: 1,
      reached: false,
    })).toBe('feature_compose');
  });

  test('a genuine one-shot reuse of a learned composition is learned_pathway', () => {
    expect(classifyExecutionPath({
      selectedTemplateId: 'composed-cap-substrate-pulse-vitals-v2-aggregator-aut',
      attempts: 1,
      reached: true,
    })).toBe('learned_pathway');
  });

  test('a satisfier resolve is satisfier', () => {
    expect(classifyExecutionPath({
      selectedTemplateId: 'satisfier:codeReadResult',
      attempts: 2,
      reached: true,
    })).toBe('satisfier');
  });

  test('a satisfier that reached on the first attempt is still a satisfier', () => {
    // The ordering hazard this guards: attempts===1 + reached also matches the
    // generic "reused a known path" heuristic. A satisfier reused no pathway —
    // a vessel simply already produced the shape.
    expect(classifyExecutionPath({
      selectedTemplateId: 'satisfier:shellResult',
      attempts: 1,
      reached: true,
    })).toBe('satisfier');
  });

  test('the ReAct floor is universal_tool_fallback — the EXACT shape it returns', () => {
    // Verbatim from universalToolFallback's only non-null return: templateId
    // "universal-tool-fallback", attempts 1, reached true. Written against the
    // real source because an invented shape (selectedTemplateId: '') passed
    // while production was misclassified as learned_pathway — the floor's own
    // branch was unreachable.
    expect(classifyExecutionPath({
      selectedTemplateId: 'universal-tool-fallback',
      attempts: 1,
      reached: true,
      executionId: 'universal-tool-fallback:2f1a9c',
    })).toBe('universal_tool_fallback');
  });

  test('the floor is recognised by execution id even without the template id', () => {
    expect(classifyExecutionPath({
      selectedTemplateId: '',
      attempts: 3,
      reached: false,
      executionId: 'universal-tool-fallback:exec_abc123',
    })).toBe('universal_tool_fallback');
  });

  test('a landed direct edit is not swallowed by the reused-path heuristic', () => {
    // All three named mechanisms return attempts===1 + reached===true, so this
    // is the single ordering property the whole classifier rests on.
    for (const tid of ['feature_compose', 'universal-tool-fallback', 'satisfier:x']) {
      expect(classifyExecutionPath({ selectedTemplateId: tid, attempts: 1, reached: true }))
        .not.toBe('learned_pathway');
    }
  });

  test('anything else is fresh_derivation', () => {
    expect(classifyExecutionPath({ selectedTemplateId: '', attempts: 4, reached: false }))
      .toBe('fresh_derivation');
    expect(classifyExecutionPath({})).toBe('fresh_derivation');
  });

  test('never returns a value outside the WalkTier vocabulary', () => {
    const vocab = new Set([
      'learned_pathway', 'satisfier', 'universal_tool_fallback', 'feature_compose', 'fresh_derivation',
    ]);
    const cases = [
      {}, { selectedTemplateId: null }, { attempts: 0 }, { reached: true },
      { selectedTemplateId: 'x', attempts: 1, reached: true },
      { executionId: 'universal-tool-fallback:z' },
    ];
    for (const c of cases) expect(vocab.has(classifyExecutionPath(c))).toBe(true);
  });
});
