import { describe, it, expect } from 'vitest';
import {
  computeSpreadCurv, classifyPairCompatibility, rankReferencesByProximity,
  SPREADCURV_FAIL_THRESHOLD,
} from './spreadCurv';
import type { ProfileMatrices } from '../dataset/matrix';

const L = 36;

/**
 * Build a synthetic RGB profile with a paper white + a neutral ramp whose 560nm
 * reflectance follows y = 1 + c1·a + c2·a² exactly, so spreadCurv560 = ‖c1,c2‖.
 * Non-560 bands are flat (curv 0) to keep the broadband mean interpretable.
 */
function mkRamp(c1: number, c2: number, levels = [32, 64, 96, 128, 160, 192, 224]): ProfileMatrices {
  const paperRefl = 0.8;
  const patches: { rgb: [number, number, number]; spec: number[] }[] = [];
  // paper white
  patches.push({ rgb: [255, 255, 255], spec: new Array(L).fill(paperRefl) });
  for (const lv of levels) {
    const a = (765 - 3 * lv) / 765;
    const spec = new Array(L).fill(paperRefl);
    spec[18] = paperRefl * (1 + c1 * a + c2 * a * a); // 560nm follows the model
    patches.push({ rgb: [lv, lv, lv], spec });
  }
  const N = patches.length;
  const X = new Float64Array(N * L);
  const D = new Float64Array(N * 3);
  for (let i = 0; i < N; i++) {
    D[i * 3] = patches[i].rgb[0]; D[i * 3 + 1] = patches[i].rgb[1]; D[i * 3 + 2] = patches[i].rgb[2];
    for (let l = 0; l < L; l++) X[i * L + l] = patches[i].spec[l];
  }
  return {
    X, D, channels: 3, N, L,
    wavelengths: Array.from({ length: L }, (_, i) => 380 + i * 10),
    sampleIds: patches.map((_, i) => `p${i}`), droppedCount: 0,
  };
}

describe('computeSpreadCurv', () => {
  it('recovers ‖c1,c2‖ at 560nm from a known quadratic ramp', () => {
    const c1 = -1.5, c2 = 0.5;
    const sc = computeSpreadCurv(mkRamp(c1, c2));
    expect(sc).not.toBeNull();
    expect(sc!.s560).toBeCloseTo(Math.hypot(c1, c2), 4);
    expect(sc!.nNeutrals).toBe(7);
  });

  it('orders holdout (low curv) below absorbed (high curv) like DecorMatte vs glossy', () => {
    const low = computeSpreadCurv(mkRamp(-1.5, 0.48))!;   // DecorMatte-like
    const high = computeSpreadCurv(mkRamp(-2.0, 0.9))!;   // glossy-like
    expect(low.s560).toBeLessThan(high.s560);
  });

  it('returns null on a profile with fewer than 3 neutral patches', () => {
    const p = mkRamp(-1.5, 0.5, [128]); // 1 neutral only
    expect(computeSpreadCurv(p)).toBeNull();
  });

  it('returns null on a CMYK profile (RGB-only)', () => {
    const p = mkRamp(-1.5, 0.5);
    expect(computeSpreadCurv({ ...p, channels: 4 })).toBeNull();
  });
});

describe('classifyPairCompatibility', () => {
  it('warns when |Δcurv560| ≥ threshold, ok when below', () => {
    const a = { s560: 1.58, bb: 1.4, nNeutrals: 7 }; // DecorMatte-like
    const b = { s560: 1.58 + SPREADCURV_FAIL_THRESHOLD + 0.01, bb: 1.4, nNeutrals: 7 };
    const c = { s560: 1.60, bb: 1.4, nNeutrals: 7 };
    expect(classifyPairCompatibility(a, b).risk).toBe('warn');
    expect(classifyPairCompatibility(a, c).risk).toBe('ok');
  });
});

describe('rankReferencesByProximity', () => {
  it('orders nearest spreadCurv first', () => {
    const target = { s560: 2.0, bb: 1.9, nNeutrals: 7 };
    const ranked = rankReferencesByProximity(target, [
      { ref: 'far', curv: { s560: 2.5, bb: 2.4, nNeutrals: 7 } },
      { ref: 'near', curv: { s560: 2.05, bb: 1.95, nNeutrals: 7 } },
      { ref: 'mid', curv: { s560: 2.2, bb: 2.1, nNeutrals: 7 } },
    ]);
    expect(ranked.map((r) => r.ref)).toEqual(['near', 'mid', 'far']);
    expect(ranked[0].risk).toBe('ok');
    expect(ranked[2].dCurv).toBeCloseTo(0.5, 6);
  });
});
