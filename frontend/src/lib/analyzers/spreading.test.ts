// spreading.test.ts
import { describe, it, expect } from 'vitest';
import {
  applySpreading3,
  packTheta3,
  unpackTheta3,
  monotonicityPenalty3,
  IDENTITY_SPREADING,
} from './spreading';

describe('applySpreading3', () => {
  it('identity params (a=0) → no change', () => {
    const N = 3;
    const cmy = new Float64Array([0.2, 0.5, 0.8, 0, 1, 0.5, 0.3, 0.7, 0.1]);
    const out = applySpreading3(cmy, IDENTITY_SPREADING, N);
    for (let i = 0; i < N * 3; i++) {
      expect(out[i]).toBeCloseTo(cmy[i], 10);
    }
  });

  it('output clamped to [0,1]', () => {
    const cmy = new Float64Array([0, 0.5, 1]);
    const params = { theta: [-5, 5, 2] as [number, number, number] };
    const out = applySpreading3(cmy, params, 1);
    for (let i = 0; i < 3; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(0);
      expect(out[i]).toBeLessThanOrEqual(1);
    }
  });

  it('endpoint constraints f(0)=0, f(1)=1 for any a', () => {
    for (const a of [-1, 0, 1, 2, -0.5]) {
      const params = { theta: [a, a, a] as [number, number, number] };
      const cmy0 = new Float64Array([0, 0, 0]);
      const cmy1 = new Float64Array([1, 1, 1]);
      const out0 = applySpreading3(cmy0, params, 1);
      const out1 = applySpreading3(cmy1, params, 1);
      for (let ch = 0; ch < 3; ch++) {
        expect(out0[ch]).toBeCloseTo(0, 10);
        expect(out1[ch]).toBeCloseTo(1, 10);
      }
    }
  });
});

describe('packTheta3 / unpackTheta3', () => {
  it('round-trip preserves values', () => {
    const params = { theta: [0.3, -0.1, 0.8] as [number, number, number] };
    const flat = packTheta3(params);
    const out = unpackTheta3(flat);
    for (let ch = 0; ch < 3; ch++) {
      expect(out.theta[ch]).toBeCloseTo(params.theta[ch], 10);
    }
  });
});

describe('monotonicityPenalty3', () => {
  it('zero penalty for identity (a=0)', () => {
    expect(monotonicityPenalty3(IDENTITY_SPREADING)).toBe(0);
  });

  it('zero penalty when a > -0.5', () => {
    expect(monotonicityPenalty3({ theta: [-0.4, 0, 0.5] })).toBe(0);
  });

  it('positive penalty when a < -0.5', () => {
    expect(monotonicityPenalty3({ theta: [-1, 0, 0] })).toBeGreaterThan(0);
  });
});
