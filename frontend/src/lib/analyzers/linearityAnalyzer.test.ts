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
      const refMeasurements = [
        createMeasurement(0, 0, 0, 0, 95, 0, 0),
        createMeasurement(100, 0, 0, 0, 50, 30, -10),
        createMeasurement(0, 100, 0, 0, 45, -20, 15),
        createMeasurement(0, 0, 100, 0, 85, 10, 40),
        createMeasurement(0, 0, 0, 100, 25, 0, 0),
      ];

      // Target with slight variations (simulating substrate difference)
      const targetMeasurements = [
        createMeasurement(0, 0, 0, 0, 93, 1, 1),
        createMeasurement(100, 0, 0, 0, 48, 32, -8),
        createMeasurement(0, 100, 0, 0, 43, -18, 17),
        createMeasurement(0, 0, 100, 0, 83, 12, 42),
        createMeasurement(0, 0, 0, 100, 23, 1, 1),
      ];

      const refProfile = createMockProfile('ReferenceSubstrate', refMeasurements);
      const targetProfile = createMockProfile('TargetSubstrate', targetMeasurements);

      const result = analyzeLinearity(refProfile, targetProfile);

      expect(result.reference_substrate).toBe('ReferenceSubstrate');
      expect(result.target_substrate).toBe('TargetSubstrate');
      expect(result.n_patches_used).toBe(5);
      expect(result.pearson_corr_lab).toBeGreaterThan(0.5);
      expect(result.r_squared).toBeGreaterThan(0.5);
      expect(result.slope_stability_score).toBeGreaterThanOrEqual(0);
      expect(result.slope_stability_score).toBeLessThanOrEqual(1);
      expect(['high', 'medium', 'low']).toContain(result.linearity_confidence);
    });

    it('should return high correlation for nearly identical profiles', () => {
      const measurements = [
        createMeasurement(0, 0, 0, 0, 95, 0, 0),
        createMeasurement(50, 50, 0, 0, 60, 20, 30),
        createMeasurement(100, 100, 100, 0, 30, 10, -5),
      ];

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
      const refMeasurements = [
        createMeasurement(10, 20, 30, 5, 70, 15, 25),
        createMeasurement(11, 21, 31, 6, 69, 14, 24), // Slightly different
      ];

      const targetMeasurements = [
        createMeasurement(10, 20, 30, 5, 68, 16, 26),
        createMeasurement(10.5, 19.5, 29.5, 5.5, 67, 15, 25), // Within tolerance
      ];

      const refProfile = createMockProfile('Ref', refMeasurements);
      const targetProfile = createMockProfile('Target', targetMeasurements);

      const result = analyzeLinearity(refProfile, targetProfile);

      expect(result.n_patches_used).toBeGreaterThanOrEqual(1);
    });

    it('should calculate mean DeltaE after correction', () => {
      const refMeasurements = [
        createMeasurement(0, 0, 0, 0, 95, 0, 0),
        createMeasurement(50, 0, 0, 0, 60, 20, 30),
        createMeasurement(0, 50, 0, 0, 55, -15, 25),
      ];

      const targetMeasurements = [
        createMeasurement(0, 0, 0, 0, 93, 1, 1), // Slight offset
        createMeasurement(50, 0, 0, 0, 58, 21, 31),
        createMeasurement(0, 50, 0, 0, 53, -14, 26),
      ];

      const refProfile = createMockProfile('Ref', refMeasurements);
      const targetProfile = createMockProfile('Target', targetMeasurements);

      const result = analyzeLinearity(refProfile, targetProfile);

      expect(result.mean_deltaE_after_correction).toBeDefined();
      expect(result.mean_deltaE_after_correction!).toBeGreaterThanOrEqual(0);
    });

    it('should calculate residual correlation', () => {
      const measurements = Array.from({ length: 50 }, (_, i) => 
        createMeasurement(i * 2, i, i / 2, 0, 100 - i, i / 5, i / 10)
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
