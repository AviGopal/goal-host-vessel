import { goalRequestsDurableArtifact } from './goal-intent';
import { describe, it, expect } from 'bun:test';

describe('goalRequestsDurableArtifact', () => {
  it('should return true for "save the findings"', () => {
    expect(goalRequestsDurableArtifact('save the findings')).toBe(true);
  });

  it('should return false for "hello world"', () => {
    expect(goalRequestsDurableArtifact('hello world')).toBe(false);
  });
});