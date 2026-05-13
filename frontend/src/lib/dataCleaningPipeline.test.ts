import { describe, it, expect } from 'vitest';
import { DataCleaningPipeline, createCleaningPipeline, SpectralData } from './dataCleaningPipeline';

describe('DataCleaningPipeline', () => {
  describe('Savitzky-Golay Filter', () => {
    it('should smooth noisy data while preserving peak shapes', () => {
      // Create a signal with a clear peak and noise
      const wavelengths = Array.from({ length: 50 }, (_, i) => 400 + i * 10);
      const values = wavelengths.map((_, i) => {
        const center = 25;
        const distance = Math.abs(i - center);
        const peak = Math.exp(-(distance * distance) / 20);
        const noise = (Math.random() - 0.5) * 0.2;
        return peak + noise;
      });

      const pipeline = new DataCleaningPipeline({
        sgWindow_size: 5,
        sgPolynomialOrder: 2,
        outlierThreshold: 10, // Disable outlier detection for this test
        noiseReductionWindow: 1, // Disable noise reduction for this test
      });

      const smoothed = pipeline.applySavitzkyGolay(values);

      // Check that smoothing reduced variance in flat regions
      const originalVariance = calculateVariance(values.slice(5, 15));
      const smoothedVariance = calculateVariance(smoothed.slice(5, 15));
      
      expect(smoothedVariance).toBeLessThan(originalVariance);
      
      // Check that peak is preserved (value near center should still be high)
      expect(smoothed[25]).toBeGreaterThan(0.7);
    });

    it('should handle edge cases gracefully', () => {
      const pipeline = new DataCleaningPipeline();
      
      // Test with very short array
      const shortData = [1, 2, 3];
      const result = pipeline.applySavitzkyGolay(shortData);
      expect(result).toEqual(shortData); // Should return unchanged
      
      // Test with empty array
      const emptyData: number[] = [];
      const emptyResult = pipeline.applySavitzkyGolay(emptyData);
      expect(emptyResult).toEqual([]);
    });

    it('should throw error for invalid window size', () => {
      expect(() => new DataCleaningPipeline({ sgWindow_size: 4 })).toThrow(
        'Savitzky-Golay window size must be odd'
      );
    });

    it('should throw error when polynomial order >= window size', () => {
      expect(() => new DataCleaningPipeline({ sgWindow_size: 5, sgPolynomialOrder: 5 })).toThrow(
        'Polynomial order must be less than window size'
      );
    });
  });

  describe('Outlier Detection', () => {
    it('should detect outliers using Z-score method', () => {
      // Create data with a more extreme outlier that will be detected after smoothing
      const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 200]; // 200 is an extreme outlier
      
      const pipeline = new DataCleaningPipeline({
        outlierMethod: 'zscore',
        outlierThreshold: 2.5,
        outlierHandling: 'interpolate',
        sgWindow_size: 5,
        noiseReductionWindow: 1,
      });

      const result = pipeline.clean({ wavelengths: data.map((_, i) => i), values: data });
      
      expect(result.statistics.outliersRemoved).toBeGreaterThan(0);
      // The outlier should be interpolated to a reasonable value
      expect(result.cleanedData.values[9]).toBeLessThan(50);
    });

    it('should detect outliers using IQR method', () => {
      const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100]; // 100 is an outlier
      
      const pipeline = new DataCleaningPipeline({
        outlierMethod: 'iqr',
        outlierThreshold: 1.5,
        outlierHandling: 'interpolate',
        sgWindow_size: 5,
        noiseReductionWindow: 1,
      });

      const result = pipeline.clean({ wavelengths: data.map((_, i) => i), values: data });
      
      expect(result.statistics.outliersRemoved).toBeGreaterThan(0);
    });

    it('should detect outliers using MAD method (robust)', () => {
      const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 50]; // 50 is an outlier
      
      const pipeline = new DataCleaningPipeline({
        outlierMethod: 'mad',
        outlierThreshold: 3,
        outlierHandling: 'interpolate',
        sgWindow_size: 5,
        noiseReductionWindow: 1,
      });

      const result = pipeline.clean({ wavelengths: data.map((_, i) => i), values: data });
      
      expect(result.statistics.outliersRemoved).toBeGreaterThan(0);
    });

    it('should remove outliers when handling is set to remove', () => {
      // Create data with extreme outlier
      const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 500]; // 500 is extreme
      
      const pipeline = new DataCleaningPipeline({
        outlierMethod: 'zscore',
        outlierThreshold: 2,
        outlierHandling: 'remove',
        sgWindow_size: 5,
        noiseReductionWindow: 1,
      });

      const result = pipeline.clean({ wavelengths: data.map((_, i) => i), values: data });
      
      expect(result.cleanedData.values.length).toBeLessThan(data.length);
      expect(result.statistics.cleanedPoints).toBeLessThan(result.statistics.originalPoints);
    });
  });

  describe('Noise Reduction', () => {
    it('should reduce noise using moving average', () => {
      const noisyData = [1, 3, 2, 4, 3, 5, 4, 6, 5, 7];
      
      const pipeline = new DataCleaningPipeline({
        noiseReductionWindow: 3,
        sgWindow_size: 5,
        outlierThreshold: 10, // Disable outlier detection
      });

      const denoised = pipeline.applyNoiseReduction(noisyData);
      
      // Check that extreme values are smoothed
      expect(denoised[1]).toBeCloseTo(2, 0); // Average of 1, 3, 2
      expect(denoised[2]).toBeCloseTo(3, 0); // Average of 3, 2, 4
    });

    it('should handle NaN values during noise reduction', () => {
      const dataWithNaN = [1, 2, NaN, 4, 5];
      
      const pipeline = new DataCleaningPipeline({
        noiseReductionWindow: 3,
        sgWindow_size: 5,
        outlierThreshold: 10,
      });

      const result = pipeline.applyNoiseReduction(dataWithNaN);
      
      // NaN should be replaced by average of neighbors
      expect(isNaN(result[2])).toBe(false);
      expect(result[2]).toBeCloseTo(3, 0); // Average of 2 and 4
    });
  });

  describe('Full Pipeline', () => {
    it('should execute complete cleaning pipeline', () => {
      const wavelengths = Array.from({ length: 100 }, (_, i) => 400 + i * 5);
      const values = wavelengths.map((_, i) => {
        const signal = Math.sin(i / 10);
        const noise = (Math.random() - 0.5) * 0.1;
        const outlier = i === 50 ? 10 : 0; // Add one outlier
        return signal + noise + outlier;
      });

      const pipeline = createCleaningPipeline('moderate');
      const result = pipeline.clean({ wavelengths, values });

      expect(result.statistics.smoothingApplied).toBe(true);
      expect(result.statistics.noiseReductionApplied).toBe(true);
      expect(result.statistics.outliersRemoved).toBeGreaterThan(0);
      expect(result.cleanedData.wavelengths.length).toBe(wavelengths.length);
    });

    it('should work with preset configurations', () => {
      const data: SpectralData = {
        wavelengths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        values: [1, 2, 3, 4, 100, 5, 6, 7, 8, 9],
      };

      const gentle = createCleaningPipeline('gentle');
      const moderate = createCleaningPipeline('moderate');
      const aggressive = createCleaningPipeline('aggressive');

      const gentleResult = gentle.clean(data);
      const moderateResult = moderate.clean(data);
      const aggressiveResult = aggressive.clean(data);

      // All should process the data without errors
      expect(gentleResult.cleanedData.values.length).toBeGreaterThan(0);
      expect(moderateResult.cleanedData.values.length).toBeGreaterThan(0);
      
      // Aggressive might remove points
      expect(aggressiveResult.cleanedData.values.length).toBeGreaterThan(0);
    });
  });

  describe('Interpolation', () => {
    it('should interpolate missing values correctly', () => {
      const pipeline = new DataCleaningPipeline({
        outlierMethod: 'zscore',
        outlierThreshold: 2,
        sgWindow_size: 5,
        noiseReductionWindow: 1,
      });
      
      // Test with extreme outlier that will be detected and interpolated
      const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100]; // 100 at end is outlier
      
      const result = pipeline.clean({
        wavelengths: data.map((_, i) => i),
        values: data,
      });

      // The last value (outlier) should be interpolated to a reasonable value
      expect(result.cleanedData.values[9]).toBeGreaterThan(5);
      expect(result.cleanedData.values[9]).toBeLessThan(20);
    });
  });
});

// Helper function
function calculateVariance(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  return squaredDiffs.reduce((sum, d) => sum + d, 0) / values.length;
}
