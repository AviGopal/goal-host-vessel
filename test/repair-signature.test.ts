import { describe, it, expect } from 'bun:test';
import { repairSignatureOf, classifyFailure } from '../src/repair-signature';

describe('repairSignatureOf', () => {
  it('returns exactly 16 hex characters', () => {
    const sig = repairSignatureOf('failed', ['shape-a', 'shape-b']);
    expect(sig).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic', () => {
    const sig1 = repairSignatureOf('failed', ['shape-a', 'shape-b']);
    const sig2 = repairSignatureOf('failed', ['shape-a', 'shape-b']);
    expect(sig1).toBe(sig2);
  });

  it('is shape-order-insensitive', () => {
    const sig1 = repairSignatureOf('failed', ['shape-a', 'shape-b']);
    const sig2 = repairSignatureOf('failed', ['shape-b', 'shape-a']);
    expect(sig1).toBe(sig2);
  });

  it('differs for different failure classes', () => {
    const sig1 = repairSignatureOf('failed', ['shape-a']);
    const sig2 = repairSignatureOf('hollow', ['shape-a']);
    expect(sig1).not.toBe(sig2);
  });

  it('handles empty shapes', () => {
    const sig = repairSignatureOf('failed', []);
    expect(sig).toMatch(/^[0-9a-f]{16}$/);
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
