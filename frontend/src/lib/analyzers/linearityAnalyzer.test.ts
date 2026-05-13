// src/lib/analyzers/linearityAnalyzer.test.ts
import { describe, it, expect } from 'vitest';
import { analyzeLinearity } from './linearityAnalyzer';
import { ProfileData, Measurement } from '../../types';

const createMockProfile = (substrate: string, measurements: Measurement[]): ProfileData => ({
  metadata: {
    full_name: `Test_${substrate}`,
    brand: 'Test',
    series: 'Test',
    printer: 'Test',
    ink: 'Test',
    substrate,
    parsed_at: new Date().toISOString(),
  },
  raw: measurements,
  clean: measurements,
  has_spectral: false,
  patch_count: measurements.length,
  wavelengths: undefined,
});

const createMeasurement = (c: number, m: number, y: number, k: number, l: number, a: number, b: number): Measurement => ({
  SAMPLE_ID: `P${Math.random().toString(36).substring(7)}`,
  CMYK_C: c,
  CMYK_M: m,
  CMYK_Y: y,
  CMYK_K: k,
  LAB_L: l,
  LAB_A: a,
  LAB_B: b,
});

describe('Linearity Analyzer', () => {
  describe('analyzeLinearity', () => {
    it('should calculate linearity metrics for two matching profiles', () => {
      // Create 60 matching patches with realistic Lab values that correlate positively
      const refMeasurements = Array.from({ length: 60 }, (_, i) => 
        createMeasurement(i % 100, (i * 2) % 100, (i * 3) % 100, 0, 100 - i * 0.5, i * 0.5 - 25, i * 0.3 - 15)
      );

      const targetMeasurements = refMeasurements.map((m) => 
        createMeasurement(m.CMYK_C, m.CMYK_M, m.CMYK_Y, m.CMYK_K, m.LAB_L - 2, m.LAB_A + 1, m.LAB_B + 1)
      );

      const refProfile = createMockProfile('ReferenceSubstrate', refMeasurements);
      const targetProfile = createMockProfile('TargetSubstrate', targetMeasurements);

      const result = analyzeLinearity(refProfile, targetProfile);

      expect(result.reference_substrate).toBe('ReferenceSubstrate');
      expect(result.target_substrate).toBe('TargetSubstrate');
      expect(result.n_patches_used).toBeGreaterThan(50);
      expect(result.slope_stability_score).toBeGreaterThanOrEqual(0);
      expect(result.slope_stability_score).toBeLessThanOrEqual(1);
      expect(['high', 'medium', 'low']).toContain(result.linearity_confidence);
    });

    it('should return high correlation for nearly identical profiles', () => {
      const measurements = Array.from({ length: 60 }, (_, i) => 
        createMeasurement(i % 100, (i * 2) % 100, (i * 3) % 100, 0, 100 - i * 0.5, i * 0.5 - 25, i * 0.3 - 15)
      );

      const refProfile = createMockProfile('Ref', measurements);
      const targetProfile = createMockProfile('Target', measurements);

      const result = analyzeLinearity(refProfile, targetProfile);

      expect(result.pearson_corr_lab).toBeCloseTo(1, 2);
      expect(result.r_squared).toBeCloseTo(1, 2);
      expect(result.linearity_confidence).toBe('high');
    });

    it('should throw error when insufficient patches match', () => {
      const refMeasurements = [
        createMeasurement(0, 0, 0, 0, 95, 0, 0),
        createMeasurement(10, 10, 10, 10, 80, 5, 5),
      ];

      const targetMeasurements = [
        createMeasurement(50, 50, 50, 50, 40, -5, -5),
        createMeasurement(60, 60, 60, 60, 35, -10, -10),
      ];

      const refProfile = createMockProfile('Ref', refMeasurements);
      const targetProfile = createMockProfile('Target', targetMeasurements);

      expect(() => analyzeLinearity(refProfile, targetProfile)).toThrow('Insufficient matching patches');
    });

    it('should handle fuzzy matching within tolerance', () => {
      const refMeasurements = Array.from({ length: 60 }, (_, i) => 
        createMeasurement(10 + i % 5, 20 + i % 5, 30 + i % 5, 5, 70 - i * 0.5, 15 + i * 0.3, 25 + i * 0.2)
      );

      const targetMeasurements = Array.from({ length: 60 }, (_, i) => 
        createMeasurement(10 + i % 5, 20 + i % 5, 30 + i % 5, 5, 68 - i * 0.5, 16 + i * 0.3, 26 + i * 0.2)
      );

      const refProfile = createMockProfile('Ref', refMeasurements);
      const targetProfile = createMockProfile('Target', targetMeasurements);

      const result = analyzeLinearity(refProfile, targetProfile);

      expect(result.n_patches_used).toBeGreaterThan(50);
    });

    it('should calculate mean DeltaE after correction', () => {
      const refMeasurements = Array.from({ length: 60 }, (_, i) => 
        createMeasurement(i % 100, (i * 2) % 100, (i * 3) % 100, 0, 100 - i * 0.5, i * 0.5 - 25, i * 0.3 - 15)
      );

      const targetMeasurements = refMeasurements.map((m) => 
        createMeasurement(m.CMYK_C, m.CMYK_M, m.CMYK_Y, m.CMYK_K, m.LAB_L - 2, m.LAB_A + 1, m.LAB_B + 1)
      );

      const refProfile = createMockProfile('Ref', refMeasurements);
      const targetProfile = createMockProfile('Target', targetMeasurements);

      const result = analyzeLinearity(refProfile, targetProfile);

      expect(result.mean_deltaE_after_correction).toBeDefined();
      expect(result.mean_deltaE_after_correction!).toBeGreaterThanOrEqual(0);
    });

    it('should calculate residual correlation', () => {
      const measurements = Array.from({ length: 60 }, (_, i) => 
        createMeasurement(i * 2 % 100, i % 100, i / 2 % 100, 0, 100 - i * 0.5, i * 0.3 - 25, i * 0.2 - 15)
      );

      const refProfile = createMockProfile('Ref', measurements);
      const targetProfile = createMockProfile('Target', measurements.map(m => ({
        ...m,
        LAB_L: m.LAB_L + (Math.random() - 0.5) * 2,
        LAB_A: m.LAB_A + (Math.random() - 0.5) * 2,
        LAB_B: m.LAB_B + (Math.random() - 0.5) * 2,
      })));

      const result = analyzeLinearity(refProfile, targetProfile);

      expect(result.pearson_corr_residuals).toBeDefined();
      expect(result.pearson_corr_residuals!).toBeGreaterThanOrEqual(0);
      expect(result.pearson_corr_residuals!).toBeLessThanOrEqual(1);
    });
  });
});
