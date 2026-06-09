import { describe, it, expect } from 'vitest';
import { loadProfileMatrix, alignProfiles } from './matrix';
import type { Measurement, ProfileData } from '../../types';

function mkPatch(sampleId: string, rgb: [number, number, number], spectra: number[]): Measurement {
  return {
    SAMPLE_ID: sampleId,
    CMYK_C: 0, CMYK_M: 0, CMYK_Y: 0, CMYK_K: 0,
    RGB_R: rgb[0], RGB_G: rgb[1], RGB_B: rgb[2],
    device: { space: 'rgb', values: [rgb[0], rgb[1], rgb[2]] },
    LAB_L: 50, LAB_A: 0, LAB_B: 0,
    spectra,
    wavelengths: Array.from({ length: spectra.length }, (_, i) => 380 + i * 10),
  };
}

function mkProfile(name: string, patches: Measurement[]): ProfileData {
  return {
    metadata: {
      full_name: name, brand: 'BC', series: 'X', printer: 'P9000',
      ink: 'mk', substrate: name, parsed_at: '2026-05-23T00:00:00Z',
    },
    raw: patches,
    clean: patches,
    has_spectral: true,
    patch_count: patches.length,
  };
}

describe('loadProfileMatrix', () => {
  it('builds N×L and N×3 matrices in sorted SAMPLE_ID order', () => {
    const p = mkProfile('demo', [
      mkPatch('R2C1P1', [128, 128, 128], [0.5, 0.5, 0.5]),
      mkPatch('R1C1P1', [255, 255, 255], [0.9, 0.9, 0.9]),
      mkPatch('R1C2P1', [0, 0, 0],       [0.05, 0.05, 0.05]),
    ]);
    const m = loadProfileMatrix(p);
    expect(m.N).toBe(3);
    expect(m.L).toBe(3);
    expect(m.channels).toBe(3);
    expect(m.sampleIds).toEqual(['R1C1P1', 'R1C2P1', 'R2C1P1']);
    // First row should be the (255,255,255) patch.
    expect(m.D[0]).toBe(255);
    expect(m.D[1]).toBe(255);
    expect(m.D[2]).toBe(255);
    expect(m.X[0]).toBeCloseTo(0.9);
  });

  it('drops patches missing spectra or device values', () => {
    const noSpec: Measurement = {
      ...mkPatch('R3C3P1', [10, 20, 30], [0]),
      spectra: undefined,
    };
    const noDev: Measurement = {
      SAMPLE_ID: 'R3C4P1',
      CMYK_C: 0, CMYK_M: 0, CMYK_Y: 0, CMYK_K: 0,
      LAB_L: 50, LAB_A: 0, LAB_B: 0,
      spectra: [0.1, 0.2, 0.3],
    };
    const ok = mkPatch('R3C5P1', [5, 5, 5], [0.1, 0.1, 0.1]);
    const m = loadProfileMatrix(mkProfile('drop', [noSpec, noDev, ok]));
    expect(m.N).toBe(1);
    expect(m.droppedCount).toBe(2);
    expect(m.sampleIds).toEqual(['R3C5P1']);
  });

  it('throws when no usable patches remain', () => {
    expect(() => loadProfileMatrix(mkProfile('empty', []))).toThrow(/no usable patches/);
  });
});


describe('alignProfiles', () => {
  it('exact-matches identical RGB grids, keeps real spectra of both', () => {
    const pA = mkProfile('A', [
      mkPatch('RGB_255_255_255', [255, 255, 255], [0.9, 0.9, 0.9]),
      mkPatch('RGB_0_0_0', [0, 0, 0], [0.05, 0.05, 0.05]),
      mkPatch('RGB_128_128_128', [128, 128, 128], [0.5, 0.5, 0.5]),
    ]);
    const pB = mkProfile('B', [
      mkPatch('RGB_255_255_255', [255, 255, 255], [0.95, 0.95, 0.95]),
      mkPatch('RGB_0_0_0', [0, 0, 0], [0.04, 0.04, 0.04]),
      mkPatch('RGB_128_128_128', [128, 128, 128], [0.55, 0.55, 0.55]),
    ]);
    const a = loadProfileMatrix(pA);
    const b = loadProfileMatrix(pB);
    const al = alignProfiles(a, b);
    expect(al.N).toBe(3);
    expect(al.exactCount).toBe(3);
    expect(al.interpCount).toBe(0);
    expect(al.looRms).toBeNull();
    expect(al.D[0]).toBe(0);
    expect(al.X_A[0]).toBeCloseTo(0.05);
    expect(al.X_B[0]).toBeCloseTo(0.04);
  });

  it('interpolates B onto A grid when grids differ; A stays real', () => {
    const pA = mkProfile('A', [
      mkPatch('RGB_0_0_0', [0, 0, 0], [0.0, 0.0, 0.0]),
      mkPatch('RGB_255_255_255', [255, 255, 255], [1.0, 1.0, 1.0]),
      mkPatch('RGB_128_128_128', [128, 128, 128], [0.5, 0.5, 0.5]),
    ]);
    const pB = mkProfile('B', [
      mkPatch('RGB_0_0_0', [0, 0, 0], [0.0, 0.0, 0.0]),
      mkPatch('RGB_255_255_255', [255, 255, 255], [1.0, 1.0, 1.0]),
      mkPatch('RGB_100_100_100', [100, 100, 100], [0.4, 0.4, 0.4]),
      mkPatch('RGB_150_150_150', [150, 150, 150], [0.6, 0.6, 0.6]),
    ]);
    const a = loadProfileMatrix(pA);
    const b = loadProfileMatrix(pB);
    const al = alignProfiles(a, b);
    expect(al.N).toBe(3);
    expect(al.exactCount).toBe(2);
    expect(al.interpCount).toBe(1);
    expect(al.looRms).not.toBeNull();
    const mid = al.sampleIds.indexOf('RGB_128_128_128');
    expect(al.X_A[mid * a.L]).toBeCloseTo(0.5);
    expect(al.X_B[mid * a.L]).toBeGreaterThan(0.4);
    expect(al.X_B[mid * a.L]).toBeLessThan(0.6);
  });

  it('drops A points outside B device bounding box', () => {
    const pA = mkProfile('A', [
      mkPatch('RGB_0_0_0', [0, 0, 0], [0.0, 0.0, 0.0]),
      mkPatch('RGB_128_128_128', [128, 128, 128], [0.5, 0.5, 0.5]),
      mkPatch('RGB_255_255_255', [255, 255, 255], [1.0, 1.0, 1.0]),
    ]);
    const pB = mkProfile('B', [
      mkPatch('RGB_0_0_0', [0, 0, 0], [0.0, 0.0, 0.0]),
      mkPatch('RGB_100_100_100', [100, 100, 100], [0.4, 0.4, 0.4]),
      mkPatch('RGB_150_150_150', [150, 150, 150], [0.6, 0.6, 0.6]),
    ]);
    const a = loadProfileMatrix(pA);
    const b = loadProfileMatrix(pB);
    const al = alignProfiles(a, b);
    expect(al.droppedOutOfGamut).toBe(1);
    expect(al.exactCount).toBe(1);
    expect(al.interpCount).toBe(1);
    expect(al.sampleIds).not.toContain('RGB_255_255_255');
    expect(al.N).toBe(2);
  });

  it('throws on CMYK interpolation (no 4D IDW yet)', () => {
    const cmykPatch = (c: number, spectra: number[]): Measurement => ({
      SAMPLE_ID: `CMYK_${c}`,
      CMYK_C: c, CMYK_M: 0, CMYK_Y: 0, CMYK_K: 0,
      device: { space: 'cmyk', values: [c, 0, 0, 0] },
      LAB_L: 50, LAB_A: 0, LAB_B: 0,
      spectra,
      wavelengths: spectra.map((_, i) => 380 + i * 10),
    });
    const a = loadProfileMatrix(mkProfile('A', [cmykPatch(10, [0.5, 0.5]), cmykPatch(50, [0.3, 0.3])]));
    const b = loadProfileMatrix(mkProfile('B', [cmykPatch(20, [0.4, 0.4]), cmykPatch(60, [0.2, 0.2])]));
    expect(() => alignProfiles(a, b)).toThrow(/CMYK interpolation/);
  });

  it('throws on wavelength count mismatch', () => {
    const a = loadProfileMatrix(mkProfile('A', [mkPatch('RGB_0_0_0', [0, 0, 0], [0.1, 0.2, 0.3])]));
    const b = loadProfileMatrix(mkProfile('B', [mkPatch('RGB_0_0_0', [0, 0, 0], [0.1, 0.2])]));
    expect(() => alignProfiles(a, b)).toThrow(/wavelength count mismatch/);
  });
});
