import { describe, it, expect } from 'vitest';
import { evaluatePrediction } from './evaluate';
import { D50_PERFECT_WHITE } from '../colormath';

const L = 4;

describe('evaluatePrediction', () => {
  it('reports zero error when prediction == truth', () => {
    const N = 5;
    const Xt = new Float64Array([
      0.9, 0.9, 0.9, 0.9,
      0.5, 0.4, 0.3, 0.2,
      0.1, 0.1, 0.1, 0.1,
      0.6, 0.65, 0.7, 0.75,
      0.2, 0.25, 0.3, 0.35,
    ]);
    const Xp = new Float64Array(Xt);
    const r = evaluatePrediction({
      variant: 'identity', k: 0,
      XPred: Xp, XTrue: Xt, L,
      sampleIds: ['a', 'b', 'c', 'd', 'e'],
      paperWP: D50_PERFECT_WHITE,
      targetProfile: 'demo',
    });
    expect(r.medianDE00).toBeCloseTo(0, 6);
    expect(r.p95DE00).toBeCloseTo(0, 6);
    expect(r.meanRMS).toBeCloseTo(0, 6);
    expect(r.nTest).toBe(N);
  });

  it('produces strictly positive ΔE on a perturbed prediction', () => {
    const Xt = new Float64Array([0.8, 0.7, 0.6, 0.5]);
    const Xp = new Float64Array([0.7, 0.6, 0.5, 0.4]);
    const r = evaluatePrediction({
      variant: 'shifted', k: 0,
      XPred: Xp, XTrue: Xt, L,
      sampleIds: ['p1'],
      paperWP: D50_PERFECT_WHITE,
      targetProfile: 'demo',
    });
    expect(r.medianDE00).toBeGreaterThan(0);
    expect(r.meanRMS).toBeGreaterThan(0);
    expect(r.worstPatchSampleIds).toEqual(['p1']);
  });

  it('throws on matrix shape mismatch', () => {
    expect(() =>
      evaluatePrediction({
        variant: 'bad', k: 0,
        XPred: new Float64Array(8),
        XTrue: new Float64Array(4),
        L,
        sampleIds: ['a'],
        paperWP: D50_PERFECT_WHITE,
        targetProfile: 'demo',
      }),
    ).toThrow(/shape mismatch/);
  });
});
