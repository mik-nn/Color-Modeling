import { describe, it, expect } from 'vitest';
import { splitCalTest } from './split';

describe('splitCalTest fixed', () => {
  it('partitions cal vs test exactly', () => {
    const s = splitCalTest(10, { kind: 'fixed', calIdx: [0, 3, 7] });
    expect([...s.calIdx]).toEqual([0, 3, 7]);
    expect([...s.testIdx]).toEqual([1, 2, 4, 5, 6, 8, 9]);
  });

  it('throws on out-of-range index', () => {
    expect(() => splitCalTest(5, { kind: 'fixed', calIdx: [1, 5] })).toThrow(/out of range/);
  });
});

describe('splitCalTest random', () => {
  it('respects testFraction approximately and is deterministic under seed', () => {
    const a = splitCalTest(100, { kind: 'random', testFraction: 0.2, seed: 42 });
    const b = splitCalTest(100, { kind: 'random', testFraction: 0.2, seed: 42 });
    expect([...a.testIdx]).toEqual([...b.testIdx]);
    expect(a.testIdx.length).toBe(20);
    expect(a.calIdx.length).toBe(80);
    const all = new Set<number>([...a.calIdx, ...a.testIdx]);
    expect(all.size).toBe(100);
  });

  it('different seeds produce different splits', () => {
    const a = splitCalTest(100, { kind: 'random', testFraction: 0.2, seed: 1 });
    const b = splitCalTest(100, { kind: 'random', testFraction: 0.2, seed: 2 });
    expect([...a.testIdx]).not.toEqual([...b.testIdx]);
  });

  it('rejects fractions outside (0, 1)', () => {
    expect(() => splitCalTest(10, { kind: 'random', testFraction: 0 })).toThrow();
    expect(() => splitCalTest(10, { kind: 'random', testFraction: 1 })).toThrow();
  });
});

describe('splitCalTest kfold', () => {
  it('5 folds together cover every index exactly once', () => {
    const N = 50;
    const k = 5;
    const seen = new Set<number>();
    for (let fold = 0; fold < k; fold++) {
      const s = splitCalTest(N, { kind: 'kfold', k, fold, seed: 7 });
      for (const i of s.testIdx) {
        expect(seen.has(i)).toBe(false);
        seen.add(i);
      }
      expect(s.calIdx.length + s.testIdx.length).toBe(N);
    }
    expect(seen.size).toBe(N);
  });

  it('requires k ≥ 2 and fold in [0, k)', () => {
    expect(() => splitCalTest(10, { kind: 'kfold', k: 1, fold: 0 })).toThrow();
    expect(() => splitCalTest(10, { kind: 'kfold', k: 3, fold: 3 })).toThrow();
  });
});
