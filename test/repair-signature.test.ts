import { describe, it, expect } from 'bun:test';
import { repairSignatureOf, classifyFailure } from '../src/repair-signature';

/**
 * `repairSignatureOf` is async. These tests did not await it, so every assertion ran
 * against a Promise object: four failed loudly ("Received value must be a string") and —
 * the interesting one — 'differs for different failure classes' PASSED, because two
 * distinct unawaited Promises are trivially `not.toBe` each other. A green assertion that
 * would hold for ANY two values is not evidence; it is the failure mode wearing a pass.
 */

describe('repairSignatureOf', () => {
  // WIDTH IS 32, NOT 16. The implementation slices sha256 to 32 hex chars; this file
  // asserted 16 and was wrong for as long as it went unawaited. Both halves of that are
  // the point: the await bug hid a genuine expectation/implementation disagreement, so
  // fixing the await is what made the stale contract visible.
  it('returns exactly 32 hex characters', async () => {
    const sig = await repairSignatureOf('failed', ['shape-a', 'shape-b']);
    expect(sig).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is deterministic', async () => {
    const sig1 = await repairSignatureOf('failed', ['shape-a', 'shape-b']);
    const sig2 = await repairSignatureOf('failed', ['shape-a', 'shape-b']);
    expect(sig1).toBe(sig2);
  });

  it('is shape-order-insensitive', async () => {
    const sig1 = await repairSignatureOf('failed', ['shape-a', 'shape-b']);
    const sig2 = await repairSignatureOf('failed', ['shape-b', 'shape-a']);
    expect(sig1).toBe(sig2);
  });

  it('differs for different failure classes', async () => {
    const sig1 = await repairSignatureOf('failed', ['shape-a']);
    const sig2 = await repairSignatureOf('hollow', ['shape-a']);
    expect(sig1).not.toBe(sig2);
  });

  it('handles empty shapes', async () => {
    const sig = await repairSignatureOf('failed', []);
    expect(sig).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('classifyFailure', () => {
  it('returns hollow when reason mentions hollow', () => {
    expect(classifyFailure('goal was hollow')).toBe('hollow');
    expect(classifyFailure('HOLLOW result')).toBe('hollow');
  });

  it('returns hollow when reason mentions not reached', () => {
    expect(classifyFailure('goal not reached')).toBe('hollow');
    expect(classifyFailure('NOT REACHED')).toBe('hollow');
  });

  it('returns hollow when reason mentions incomplete', () => {
    expect(classifyFailure('task incomplete')).toBe('hollow');
    expect(classifyFailure('INCOMPLETE')).toBe('hollow');
  });

  it('returns failed for other reasons', () => {
    expect(classifyFailure('timeout')).toBe('failed');
    expect(classifyFailure('error occurred')).toBe('failed');
    expect(classifyFailure(null)).toBe('failed');
    expect(classifyFailure(undefined)).toBe('failed');
    expect(classifyFailure('')).toBe('failed');
  });
});
