import { describe, it, expect } from 'vitest';
import { evalLoadedPairs } from './batchEval';
import type { ProfileData, Measurement } from '../../types';

const L = 36;

/** Deterministic positive reflectance from device RGB (smooth, invertible-ish). */
function spec(r: number, g: number, b: number): number[] {
  const lum = (r + g + b) / 765;
  const out = new Array<number>(L);
  for (let l = 0; l < L; l++) {
    // base on luminance + mild per-channel spectral tilt so different RGB → different spectra
    const tilt = 0.06 * (r / 255) * (l / L) + 0.06 * (b / 255) * (1 - l / L);
    out[l] = Math.min(0.98, Math.max(0.02, 0.04 + 0.85 * lum + tilt));
  }
  return out;
}

/** 5×5×5 RGB grid = 125 patches (incl. white, black, corners, 5 neutrals). */
function mkProfile(fullName: string, printMode: string): ProfileData {
  const levels = [0, 64, 128, 191, 255];
  const raw: Measurement[] = [];
  for (const r of levels) for (const g of levels) for (const b of levels) {
    raw.push({
      SAMPLE_ID: `RGB_${r}_${g}_${b}`,
      RGB_R: r, RGB_G: g, RGB_B: b,
      spectra: spec(r, g, b),
    } as Measurement);
  }
  return {
    metadata: {
      full_name: fullName, brand: 'BC', series: fullName, printer: 'P9000',
      ink: 'mk', substrate: fullName, parsed_at: new Date().toISOString(), printMode,
    },
    raw, clean: raw, has_spectral: true, patch_count: raw.length,
  } as ProfileData;
}

describe('evalLoadedPairs', () => {
  it('pairs only same-mode profiles, both directions, excluding self', () => {
    const a = mkProfile('BC_AAA_P9000_mk_CanvasMatte', 'CanvasMatte');
    const b = mkProfile('BC_BBB_P9000_mk_CanvasMatte', 'CanvasMatte');
    const c = mkProfile('BC_CCC_P9000_mk_PremiumLuster', 'PremiumLuster');
    const res = evalLoadedPairs([a, b, c], { minAligned: 50 });
    // 2 ordered CanvasMatte pairs (A→B, B→A); Luster alone → no pair
    const evaluated = res.pairs.filter((p) => !p.skipped);
    expect(evaluated).toHaveLength(2);
    expect(evaluated.every((p) => p.mode === 'CanvasMatte')).toBe(true);
    expect(evaluated.some((p) => p.ref === p.tgt)).toBe(false);
  });

  it('identical spectra → near-zero ΔE → pass', () => {
    const a = mkProfile('BC_AAA_P9000_mk_CanvasMatte', 'CanvasMatte');
    const b = mkProfile('BC_BBB_P9000_mk_CanvasMatte', 'CanvasMatte');
    const res = evalLoadedPairs([a, b], { minAligned: 50 });
    expect(res.total).toBe(2);
    expect(res.passed).toBe(2);
    expect(res.passRate).toBeCloseTo(1, 6);
    for (const p of res.pairs) expect(p.median).toBeLessThan(0.5);
  });

  it('reports per-mode aggregates', () => {
    const a = mkProfile('BC_AAA_P9000_mk_CanvasMatte', 'CanvasMatte');
    const b = mkProfile('BC_BBB_P9000_mk_CanvasMatte', 'CanvasMatte');
    const res = evalLoadedPairs([a, b], { minAligned: 50 });
    expect(res.byMode).toHaveLength(1);
    expect(res.byMode[0]).toMatchObject({ mode: 'CanvasMatte', passed: 2, total: 2 });
  });

  it('returns empty when fewer than 2 same-mode profiles', () => {
    const a = mkProfile('BC_AAA_P9000_mk_CanvasMatte', 'CanvasMatte');
    const c = mkProfile('BC_CCC_P9000_mk_PremiumLuster', 'PremiumLuster');
    const res = evalLoadedPairs([a, c], { minAligned: 50 });
    expect(res.total).toBe(0);
    expect(res.passRate).toBe(0);
  });
});
