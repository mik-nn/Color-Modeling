import { describe, it, expect } from 'vitest';
import { loadProfileMatrix, alignByCommonSampleIds } from './matrix';
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

describe('alignByCommonSampleIds', () => {
  it('returns the intersection in B-order', () => {
    const pA = mkProfile('A', [
      mkPatch('R1C1P1', [10, 10, 10], [0.1, 0.1, 0.1]),
      mkPatch('R2C2P1', [20, 20, 20], [0.2, 0.2, 0.2]),
      mkPatch('R3C3P1', [30, 30, 30], [0.3, 0.3, 0.3]),
    ]);
    const pB = mkProfile('B', [
      mkPatch('R2C2P1', [21, 21, 21], [0.22, 0.22, 0.22]),
      mkPatch('R3C3P1', [31, 31, 31], [0.33, 0.33, 0.33]),
      mkPatch('R9C9P1', [99, 99, 99], [0.99, 0.99, 0.99]),
    ]);
    const a = loadProfileMatrix(pA);
    const b = loadProfileMatrix(pB);
    const aligned = alignByCommonSampleIds(a, b);
    expect(aligned.sampleIds).toEqual(['R2C2P1', 'R3C3P1']);
    expect(aligned.idxA.length).toBe(2);
    expect(aligned.idxB.length).toBe(2);
  });
});
