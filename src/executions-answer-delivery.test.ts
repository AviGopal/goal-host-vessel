import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * A REACHED RUN WITH NO ANSWER IS A PROCESS REPORT, NOT A RESULT.
 *
 * GET /executions/:dispatchId builds its JSON key by key. Every key not named is dropped
 * silently — no error, no warning, no failing test, because omitting an optional field is legal.
 * `answerBody` was missing, so the human surface rendered a green "reached" row for a run whose
 * answer the record was holding the whole time.
 *
 * MEASURED 2026-08-18, three ordinary human goals with nothing to do with substrate internals:
 *
 *   "What is 17 percent of 4850?"                    -> record: "Final answer: 824"
 *   "Who wrote the novel Piranesi?"                  -> judge: "Susanna Clarke"
 *   "How many kilometres are there in 12 nautical miles?" -> judge: "22.224 km"
 *   "Name the capital city of Mongolia."             -> World Bank API: "Ulaanbaatar"
 *
 * All reached. All correct except the first. NONE delivered an answer to the surface.
 *
 * ★ THE SIBLING ENDPOINT ALWAYS HAD IT. goalWalkState carries answerBody, so the Obsidian panel
 *   received answers this endpoint could not, from the SAME record, for the SAME run. The bug
 *   was invisible from either side alone: one surface always worked, the other never did.
 */

const SRC = new URL('./index.ts', import.meta.url).pathname;
const source = () => readFileSync(SRC, 'utf8');

const executionsHandler = (): string => {
  const s = source();
  const i = s.indexOf('url.pathname.startsWith("/executions/")');
  expect(i).toBeGreaterThan(-1);
  return s.slice(i, i + 3000);
};

describe('GET /executions/:dispatchId delivers the answer', () => {
  it('guards the instrument: the handler is findable and is the right one', () => {
    const h = executionsHandler();
    expect(h).toContain('executionStore.get(dispatchId)');
    expect(h).toContain('goalReachReason');
  });

  it('THE REGRESSION: answerBody is in the response', () => {
    expect(executionsHandler()).toMatch(/answerBody:\s*\(record as \{ answerBody\?: string \}\)\.answerBody \?\? null/);
  });

  it('it is null-defaulted, never absent — a missing key and a null answer differ', () => {
    // `undefined` disappears from JSON entirely, and a consumer cannot tell "this run produced
    // no answer" from "this endpoint forgot to send one". That ambiguity is the whole defect.
    expect(executionsHandler()).toMatch(/answerBody:[^,]*\?\? null/);
  });

  it('the verdict fields are still present — delivery must not replace the process report', () => {
    const h = executionsHandler();
    for (const k of ['reached:', 'goalReachReason:', 'status:', 'walkLog:', 'learning:']) {
      expect(h).toContain(k);
    }
  });

  it('NEGATIVE CONTROL: the assertion rejects the pre-fix projection', () => {
    const preFix = `
        error: record.error,
        walkLog: record.walkLog,
        learning: record.learning ?? null,
      });`;
    expect(/answerBody:/.test(preFix)).toBe(false);
  });
});
