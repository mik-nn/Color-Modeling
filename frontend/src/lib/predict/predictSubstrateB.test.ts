// src/lib/predict/predictSubstrateB.test.ts

import { describe, it, expect } from 'vitest';
import { predictSubstrateB } from './predictSubstrateB';

const L = 36;

// ─── Minimal flat-spectrum helpers ───────────────────────────────────────────

function flatSpectrum(v: number): Float64Array {
  const s = new Float64Array(L);
  s.fill(v);
  return s;
}

function makeDevices(n: number, step: number): Float64Array {
  // Linearly spaced C values, M and Y constant at 0.
  const d = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    d[i * 3]     = i * step; // C
    d[i * 3 + 1] = 0;        // M
    d[i * 3 + 2] = 0;        // Y
  }
  return d;
}

// ─── Sanity: pure paper-ratio world ──────────────────────────────────────────

describe('predictSubstrateB — pure paper ratio', () => {
  it('recovers B = scale * A when B is exactly a paper-ratio multiple of A', () => {
    const N = 20;
    const scale = 0.85; // B substrate is darker

    // A spectra: each patch = 0.5 * (1 + i/N) (different levels)
    const spectra_A = new Float64Array(N * L);
    for (let i = 0; i < N; i++) {
      for (let l = 0; l < L; l++) spectra_A[i * L + l] = 0.5 * (1 + i / N);
    }

    // B = scale * A everywhere
    const spectra_B_all = new Float64Array(N * L);
    for (let i = 0; i < N * L; i++) spectra_B_all[i] = scale * spectra_A[i];

    // Paper whites are flat and in scale ratio.
    const paper_A = flatSpectrum(0.9);
    const paper_B = flatSpectrum(0.9 * scale);

    // 8 anchor patches spread evenly across the N rows.
    const anchorRows = [0, 2, 4, 7, 10, 13, 16, 19];
    const k = anchorRows.length;
    const spectra_B_anchors = new Float64Array(k * L);
    const device_anchors = new Float64Array(k * 3);
    const device_A = makeDevices(N, 10);

    for (let j = 0; j < k; j++) {
      const row = anchorRows[j];
      for (let l = 0; l < L; l++) {
        spectra_B_anchors[j * L + l] = spectra_B_all[row * L + l];
      }
      device_anchors[j * 3]     = device_A[row * 3];
      device_anchors[j * 3 + 1] = device_A[row * 3 + 1];
      device_anchors[j * 3 + 2] = device_A[row * 3 + 2];
    }

    const pred = predictSubstrateB(
      spectra_A, spectra_B_anchors, device_A, device_anchors, paper_A, paper_B,
    );

    // All patches should be predicted within reflectance tolerance of 1e-6.
    for (let i = 0; i < N; i++) {
      for (let l = 0; l < L; l++) {
        const expected = spectra_B_all[i * L + l];
        expect(pred[i * L + l]).toBeCloseTo(expected, 5);
      }
    }
  });
});

// ─── Anchors are exact ────────────────────────────────────────────────────────

describe('predictSubstrateB — anchor exactness', () => {
  it('returns exact measured values at anchor positions', () => {
    const N = 30;
    const k = 8;

    // Random-ish spectra A.
    const spectra_A = new Float64Array(N * L);
    for (let i = 0; i < N; i++) {
      for (let l = 0; l < L; l++) {
        // Deterministic pseudo-random via a polynomial.
        spectra_A[i * L + l] = 0.1 + 0.5 * ((i * 7 + l * 3) % 17) / 17;
      }
    }
    // B: some nonlinear transform of A.
    const spectra_B_all = new Float64Array(N * L);
    for (let i = 0; i < N * L; i++) {
      spectra_B_all[i] = Math.sqrt(spectra_A[i]) * 0.9;
    }

    const paper_A = new Float64Array(L);
    const paper_B = new Float64Array(L);
    for (let l = 0; l < L; l++) {
      paper_A[l] = 0.9 + l * 0.001;
      paper_B[l] = 0.85 + l * 0.001;
    }

    const anchorRows = [0, 4, 8, 12, 16, 20, 24, 28];
    const spectra_B_anchors = new Float64Array(k * L);
    const device_A = makeDevices(N, 8);
    const device_anchors = new Float64Array(k * 3);

    for (let j = 0; j < k; j++) {
      const row = anchorRows[j];
      for (let l = 0; l < L; l++) {
        spectra_B_anchors[j * L + l] = spectra_B_all[row * L + l];
      }
      device_anchors[j * 3]     = device_A[row * 3];
      device_anchors[j * 3 + 1] = device_A[row * 3 + 1];
      device_anchors[j * 3 + 2] = device_A[row * 3 + 2];
    }

    const pred = predictSubstrateB(
      spectra_A, spectra_B_anchors, device_A, device_anchors, paper_A, paper_B,
    );

    // At each anchor row, prediction must equal B_true exactly (within float64 precision).
    for (let j = 0; j < k; j++) {
      const row = anchorRows[j];
      for (let l = 0; l < L; l++) {
        const expected = spectra_B_all[row * L + l];
        expect(pred[row * L + l]).toBeCloseTo(expected, 6);
      }
    }
  });
});

// ─── Output shape and clamping ────────────────────────────────────────────────

describe('predictSubstrateB — output invariants', () => {
  it('returns N×L values clamped to [0, 1]', () => {
    const N = 10;
    const k = 3;

    // Pathological case: B has very bright patches that could overflow.
    const spectra_A = new Float64Array(N * L).fill(0.3);
    const paper_A   = flatSpectrum(0.1); // very dark A paper
    const paper_B   = flatSpectrum(0.9); // much brighter B paper → ratio = 9 (clamped to 5)

    const anchorRows = [0, 4, 8];
    const spectra_B_anchors = new Float64Array(k * L).fill(0.85);
    const device_A = makeDevices(N, 25);
    const device_anchors = new Float64Array(k * 3);
    for (let j = 0; j < k; j++) {
      const row = anchorRows[j];
      device_anchors[j * 3]     = device_A[row * 3];
      device_anchors[j * 3 + 1] = device_A[row * 3 + 1];
      device_anchors[j * 3 + 2] = device_A[row * 3 + 2];
    }

    const pred = predictSubstrateB(
      spectra_A, spectra_B_anchors, device_A, device_anchors, paper_A, paper_B,
    );

    expect(pred.length).toBe(N * L);
    for (let i = 0; i < pred.length; i++) {
      expect(pred[i]).toBeGreaterThanOrEqual(0);
      expect(pred[i]).toBeLessThanOrEqual(1);
    }
  });

  it('throws on shape mismatch', () => {
    const spectra_A = new Float64Array(905 * L);
    const anchors   = new Float64Array(8 * L);
    const dev_A     = new Float64Array(905 * 3);
    const dev_anch  = new Float64Array(8 * 3);
    const pa        = new Float64Array(L);
    const pb        = new Float64Array(L);

    // Wrong paper_A length.
    expect(() =>
      predictSubstrateB(spectra_A, anchors, dev_A, dev_anch, new Float64Array(L + 1), pb),
    ).toThrow();

    // Wrong device_anchors length.
    expect(() =>
      predictSubstrateB(spectra_A, anchors, dev_A, new Float64Array(7 * 3), pa, pb),
    ).toThrow();
  });
});

// ─── k = 1 degenerate anchor ──────────────────────────────────────────────────

describe('predictSubstrateB — k=1', () => {
  it('still produces output without throwing, and the single anchor is exact', () => {
    const N = 20;
    const spectra_A = new Float64Array(N * L);
    for (let i = 0; i < N * L; i++) spectra_A[i] = 0.1 + (i % 7) / 20;

    const paper_A = flatSpectrum(0.88);
    const paper_B = flatSpectrum(0.75);

    const anchorRow = 10;
    const spectra_B_anchors = new Float64Array(L);
    for (let l = 0; l < L; l++) spectra_B_anchors[l] = 0.6 + l * 0.005;

    const device_A = makeDevices(N, 12);
    const device_anchors = new Float64Array(3);
    device_anchors[0] = device_A[anchorRow * 3];
    device_anchors[1] = device_A[anchorRow * 3 + 1];
    device_anchors[2] = device_A[anchorRow * 3 + 2];

    const pred = predictSubstrateB(
      spectra_A, spectra_B_anchors, device_A, device_anchors, paper_A, paper_B,
    );

    expect(pred.length).toBe(N * L);
    // Anchor row must be exact.
    for (let l = 0; l < L; l++) {
      expect(pred[anchorRow * L + l]).toBeCloseTo(spectra_B_anchors[l], 6);
    }
  });
});
