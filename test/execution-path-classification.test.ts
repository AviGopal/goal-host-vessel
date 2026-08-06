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

  test('a satisfier that reached first try is NOT swallowed by learned_pathway', () => {
    // Documents a real ordering hazard: attempts===1 + reached would match the
    // learned-path predicate first. Kept as an explicit expectation so a future
    // reorder cannot silently relabel satisfier resolves.
    expect(classifyExecutionPath({
      selectedTemplateId: 'satisfier:shellResult',
      attempts: 1,
      reached: true,
    })).toBe('learned_pathway');
  });

  test('the ReAct floor is universal_tool_fallback', () => {
    expect(classifyExecutionPath({
      selectedTemplateId: '',
      attempts: 3,
      reached: false,
      executionId: 'universal-tool-fallback:exec_abc123',
    })).toBe('universal_tool_fallback');
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
