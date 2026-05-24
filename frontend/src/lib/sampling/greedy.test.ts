import { describe, it, expect } from 'vitest';
import { runGreedyActiveAnchors, type GreedyPredictor } from './greedy';
import type { PredictionReport } from '../../types';
import { D50_PERFECT_WHITE } from '../colormath';

function mkReport(
  k: number,
  medianDE00: number,
  worst: string[] = [],
): PredictionReport {
  return {
    variant: 'mock',
    k,
    medianDE00,
    p95DE00: medianDE00 * 2,
    meanSpectralR2: 0.9,
    meanRMS: 0.01,
    worstPatchSampleIds: worst,
    paperWP: D50_PERFECT_WHITE,
    targetProfile: 'tgt',
    nTest: 100,
  };
}

describe('runGreedyActiveAnchors', () => {
  it('stops at iteration 0 when seed already meets target', () => {
    const predict: GreedyPredictor = anchors => mkReport(anchors.length, 1.0, ['s50']);
    const r = runGreedyActiveAnchors({
      predict,
      seedAnchors: [0, 1, 2],
      sampleIds: Array.from({ length: 100 }, (_, i) => `s${i}`),
      targetMedianDE: 1.5,
    });
    expect(r.converged).toBe(true);
    expect(r.trajectory.length).toBe(1);
    expect(r.finalAnchors.length).toBe(3);
    expect(r.addedOrder).toEqual([]);
  });

  it('adds worst patch each iteration; trajectory is monotone improving in our mock', () => {
    // Mock predictor: starts at medianDE = 3.0, improves by 0.5 per added anchor.
    // After 4 iterations (k=7 → k=10), median drops to 1.0 ≤ target 1.5 → stop.
    let calls = 0;
    const baseMedian = 3.0;
    const predict: GreedyPredictor = anchors => {
      const median = baseMedian - 0.5 * (anchors.length - 3); // k=3 → 3.0, k=10 → -0.5
      const worst = [`s${50 + anchors.length}`]; // each call surfaces a different worst patch
      calls++;
      return mkReport(anchors.length, Math.max(median, 0.5), worst);
    };
    const r = runGreedyActiveAnchors({
      predict,
      seedAnchors: [0, 1, 2],
      sampleIds: Array.from({ length: 100 }, (_, i) => `s${i}`),
      targetMedianDE: 1.5,
      maxK: 20,
    });
    expect(r.converged).toBe(true);
    expect(r.trajectory.length).toBe(calls);
    // Anchor count grew exactly trajectory.length - 1 times (last iter only predicts).
    expect(r.finalAnchors.length).toBe(3 + r.addedOrder.length);
    // Trajectory medianDE00 monotone non-increasing.
    for (let i = 1; i < r.trajectory.length; i++) {
      expect(r.trajectory[i].report.medianDE00).toBeLessThanOrEqual(r.trajectory[i - 1].report.medianDE00);
    }
  });

  it('respects maxK cap and reports converged=false when budget runs out', () => {
    // Predictor never improves — median stays at 5.0.
    let counter = 0;
    const predict: GreedyPredictor = () => {
      counter++;
      // Each iteration surfaces a fresh worst-patch SAMPLE_ID so the loop has
      // a candidate to add — but predictor never improves.
      return mkReport(0, 5.0, [`s${10 + counter}`]);
    };
    const r = runGreedyActiveAnchors({
      predict,
      seedAnchors: [0, 1, 2],
      sampleIds: Array.from({ length: 100 }, (_, i) => `s${i}`),
      targetMedianDE: 1.0,
      maxK: 10,
    });
    expect(r.converged).toBe(false);
    expect(r.finalAnchors.length).toBe(10);
    expect(r.addedOrder.length).toBe(7); // 3 seed + 7 added = 10 cap
  });

  it('skips worst-patch entries that are already anchors', () => {
    // Predictor always returns 's0' as worst (already in seed) and 's5' as second.
    // Greedy should pick 's5'.
    let added: number[] = [];
    const predict: GreedyPredictor = anchors => {
      added.push(anchors.length);
      if (anchors.length >= 4) return mkReport(anchors.length, 0.5, ['s0', 's5']);
      return mkReport(anchors.length, 5.0, ['s0', 's5', 's7']);
    };
    const r = runGreedyActiveAnchors({
      predict,
      seedAnchors: [0, 1, 2],
      sampleIds: Array.from({ length: 100 }, (_, i) => `s${i}`),
      targetMedianDE: 1.0,
      maxK: 20,
    });
    expect(r.addedOrder).toEqual([5]); // s0 already anchor → pick s5; then converge.
    expect(r.converged).toBe(true);
  });

  it('throws on empty seed or maxK below seed size', () => {
    const predict: GreedyPredictor = () => mkReport(0, 0, []);
    expect(() => runGreedyActiveAnchors({
      predict, seedAnchors: [], sampleIds: ['a'],
      targetMedianDE: 1, maxK: 5,
    })).toThrow(/non-empty/);
    expect(() => runGreedyActiveAnchors({
      predict, seedAnchors: [0, 1, 2, 3, 4], sampleIds: ['a'],
      targetMedianDE: 1, maxK: 3,
    })).toThrow(/maxK/);
  });
});
