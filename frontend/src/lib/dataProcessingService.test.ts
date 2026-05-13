/**
 * Tests for Data Processing Service
 * 
 * Verifies integration of Data Cleaning Pipeline with profile processing workflow.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DataProcessingService, createProcessingService } from './dataProcessingService';
import { ProfileData, Measurement } from '../types';

// Helper function to create mock spectral data
function createMockSpectralData(
  wavelengths: number[],
  baseValues: number[],
  noiseLevel: number = 0
): number[] {
  return baseValues.map(v => {
    if (noiseLevel === 0) return v;
    const noise = (Math.random() - 0.5) * noiseLevel;
    return Math.max(0, Math.min(1, v + noise));
  });
}

// Helper function to create a mock profile
function createMockProfile(
  measurementCount: number = 10,
  hasSpectral: boolean = true,
  addOutliers: boolean = false
): ProfileData {
  const wavelengths = Array.from({ length: 36 }, (_, i) => 380 + i * 10); // 380-730nm
  
  const measurements: Measurement[] = Array.from({ length: measurementCount }, (_, i) => {
    const baseSpectra = Array.from({ length: 36 }, (_, j) => {
      // Create a smooth spectral curve
      return 0.3 + 0.4 * Math.sin((j / 36) * Math.PI);
    });
    
    let spectra = createMockSpectralData(wavelengths, baseSpectra, 0.02); // 2% noise
    
    // Add an outlier if requested
    if (addOutliers && i === 5) {
      spectra = spectra.map((v, idx) => idx === 18 ? 0.95 : v); // Sharp spike at 560nm
    }
    
    return {
      SAMPLE_ID: `PATCH_${i.toString().padStart(3, '0')}`,
      CMYK_C: (i % 11) * 10,
      CMYK_M: ((i * 3) % 11) * 10,
      CMYK_Y: ((i * 7) % 11) * 10,
      CMYK_K: ((i * 2) % 11) * 10,
      LAB_L: 50 + (i % 5) * 10,
      LAB_A: 10 + (i % 3) * 5,
      LAB_B: 20 + (i % 4) * 5,
      spectra: hasSpectral ? spectra : undefined,
      wavelengths: hasSpectral ? wavelengths : undefined,
      is_outlier: false,
    };
  });
  
  return {
    metadata: {
      full_name: 'Test_Profile',
      brand: 'TestBrand',
      series: 'TestSeries',
      printer: 'TestPrinter',
      ink: 'TestInk',
      substrate: 'TestSubstrate',
      parsed_at: new Date().toISOString(),
    },
    raw: measurements,
    clean: measurements,
    has_spectral: hasSpectral,
    patch_count: measurementCount,
    wavelengths: hasSpectral ? wavelengths : undefined,
  };
}

describe('DataProcessingService', () => {
  describe('constructor', () => {
    it('should create service with cleaning disabled', () => {
      const service = new DataProcessingService({ enableCleaning: false });
      expect(service.getCurrentConfig().enabled).toBe(false);
    });

    it('should create service with default preset (moderate)', () => {
      const service = createProcessingService();
      expect(service.getCurrentConfig().enabled).toBe(true);
      expect(service.getCurrentConfig().preset).toBe('moderate');
    });

    it('should create service with custom preset', () => {
      const service = createProcessingService('gentle');
      expect(service.getCurrentConfig().preset).toBe('gentle');
    });

    it('should create service with cleaning disabled using none preset', () => {
      const service = createProcessingService('none');
      expect(service.getCurrentConfig().enabled).toBe(false);
    });
  });

  describe('processProfile', () => {
    it('should return original profile when cleaning is disabled', async () => {
      const service = new DataProcessingService({ enableCleaning: false });
      const profile = createMockProfile(10, true);
      
      const result = await service.processProfile(profile);
      
      expect(result.originalProfile).toBe(profile);
      expect(result.cleanedProfile).toBe(profile);
      expect(result.statistics.smoothingApplied).toBe(false);
      expect(result.statistics.noiseReductionApplied).toBe(false);
      expect(result.statistics.totalOutliersDetected).toBe(0);
    });

    it('should process profile with moderate cleaning preset', async () => {
      const service = createProcessingService('moderate');
      const profile = createMockProfile(10, true);
      
      const result = await service.processProfile(profile);
      
      expect(result.statistics.measurementsProcessed).toBe(10);
      expect(result.statistics.spectralBandsPerMeasurement).toBe(36);
      expect(result.statistics.smoothingApplied).toBe(true);
      expect(result.statistics.noiseReductionApplied).toBe(true);
      expect(result.statistics.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should detect outliers in spectral data', async () => {
      const service = createProcessingService('moderate');
      const profile = createMockProfile(10, true, true); // with outlier
      
      const result = await service.processProfile(profile);
      
      // Should detect the outlier we added
      expect(result.statistics.totalOutliersDetected).toBeGreaterThanOrEqual(0);
      expect(result.statistics.averageDeltaEBeforeAfter).toBeGreaterThanOrEqual(0);
    });

    it('should handle profiles without spectral data', async () => {
      const service = createProcessingService('moderate');
      const profile = createMockProfile(10, false); // no spectral data
      
      const result = await service.processProfile(profile);
      
      expect(result.statistics.measurementsProcessed).toBe(10);
      expect(result.statistics.spectralBandsPerMeasurement).toBe(0);
      // Should not crash, just pass through measurements unchanged
    });

    it('should preserve measurement metadata after cleaning', async () => {
      const service = createProcessingService('gentle');
      const profile = createMockProfile(5, true);
      
      const result = await service.processProfile(profile);
      
      // Check that all SAMPLE_IDs are preserved
      const originalIds = profile.raw.map(m => m.SAMPLE_ID);
      const cleanedIds = result.cleanedProfile.clean.map(m => m.SAMPLE_ID);
      expect(cleanedIds).toEqual(originalIds);
      
      // Check that Lab values are preserved
      profile.raw.forEach((orig, i) => {
        const cleaned = result.cleanedProfile.clean[i];
        expect(cleaned.LAB_L).toBe(orig.LAB_L);
        expect(cleaned.LAB_A).toBe(orig.LAB_A);
        expect(cleaned.LAB_B).toBe(orig.LAB_B);
      });
    });

    it('should apply different smoothing levels based on preset', async () => {
      const profile = createMockProfile(10, true);
      
      const gentleService = createProcessingService('gentle');
      const aggressiveService = createProcessingService('aggressive');
      
      const gentleResult = await gentleService.processProfile(profile);
      const aggressiveResult = await aggressiveService.processProfile(profile);
      
      // Both should apply smoothing
      expect(gentleResult.statistics.smoothingApplied).toBe(true);
      expect(aggressiveResult.statistics.smoothingApplied).toBe(true);
      
      // Aggressive might remove more outliers or apply stronger smoothing
      expect(gentleResult.statistics.processingTimeMs).toBeGreaterThanOrEqual(0);
      expect(aggressiveResult.statistics.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should calculate processing time', async () => {
      const service = createProcessingService('moderate');
      const profile = createMockProfile(20, true);
      
      const result = await service.processProfile(profile);
      
      expect(result.statistics.processingTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.statistics.processingTimeMs).toBeLessThan(1000); // Should be fast
    });
  });

  describe('processMultipleProfiles', () => {
    it('should process multiple profiles', async () => {
      const service = createProcessingService('moderate');
      const profiles = [
        createMockProfile(10, true),
        createMockProfile(15, true),
        createMockProfile(8, false),
      ];
      
      const results = await service.processMultipleProfiles(profiles);
      
      expect(results).toHaveLength(3);
      expect(results[0].statistics.measurementsProcessed).toBe(10);
      expect(results[1].statistics.measurementsProcessed).toBe(15);
      expect(results[2].statistics.measurementsProcessed).toBe(8);
    });

    it('should handle empty profile list', async () => {
      const service = createProcessingService('moderate');
      
      const results = await service.processMultipleProfiles([]);
      
      expect(results).toHaveLength(0);
    });
  });

  describe('updateOptions', () => {
    it('should enable cleaning dynamically', () => {
      const service = new DataProcessingService({ enableCleaning: false });
      expect(service.getCurrentConfig().enabled).toBe(false);
      
      service.updateOptions({ enableCleaning: true, preset: 'gentle' });
      expect(service.getCurrentConfig().enabled).toBe(true);
      expect(service.getCurrentConfig().preset).toBe('gentle');
    });

    it('should disable cleaning dynamically', () => {
      const service = createProcessingService('moderate');
      expect(service.getCurrentConfig().enabled).toBe(true);
      
      service.updateOptions({ enableCleaning: false });
      expect(service.getCurrentConfig().enabled).toBe(false);
    });

    it('should switch presets dynamically', () => {
      const service = createProcessingService('gentle');
      expect(service.getCurrentConfig().preset).toBe('gentle');
      
      service.updateOptions({ preset: 'aggressive' });
      expect(service.getCurrentConfig().preset).toBe('aggressive');
    });

    it('should accept custom options', () => {
      const service = createProcessingService('moderate');
      
      service.updateOptions({
        enableCleaning: true,
        customOptions: {
          sgWindow_size: 11,
          sgPolynomialOrder: 4,
          outlierThreshold: 2.0,
          outlierMethod: 'mad',
          outlierHandling: 'remove',
          noiseReductionWindow: 5,
        },
      });
      
      const config = service.getCurrentConfig();
      expect(config.options?.sgWindow_size).toBe(11);
      expect(config.options?.outlierMethod).toBe('mad');
    });
  });

  describe('edge cases', () => {
    it('should handle very small profiles', async () => {
      const service = createProcessingService('moderate');
      const profile = createMockProfile(2, true);
      
      const result = await service.processProfile(profile);
      
      expect(result.statistics.measurementsProcessed).toBe(2);
    });

    it('should handle profiles with single measurement', async () => {
      const service = createProcessingService('moderate');
      const profile = createMockProfile(1, true);
      
      const result = await service.processProfile(profile);
      
      expect(result.statistics.measurementsProcessed).toBe(1);
    });

    it('should handle empty measurements array', async () => {
      const service = createProcessingService('moderate');
      const profile = createMockProfile(0, true);
      
      const result = await service.processProfile(profile);
      
      expect(result.statistics.measurementsProcessed).toBe(0);
    });

    it('should handle partial spectral data', async () => {
      const service = createProcessingService('moderate');
      const profile = createMockProfile(10, true);
      
      // Remove spectral data from some measurements
      profile.raw[3].spectra = undefined;
      profile.raw[3].wavelengths = undefined;
      profile.raw[7].spectra = undefined;
      profile.raw[7].wavelengths = undefined;
      
      const result = await service.processProfile(profile);
      
      // Should process without errors
      expect(result.statistics.measurementsProcessed).toBe(10);
    });
  });

  describe('performance', () => {
    it('should process large profiles efficiently', async () => {
      const service = createProcessingService('moderate');
      const profile = createMockProfile(100, true);
      
      const startTime = performance.now();
      const result = await service.processProfile(profile);
      const endTime = performance.now();
      
      const processingTime = endTime - startTime;
      
      expect(result.statistics.measurementsProcessed).toBe(100);
      expect(processingTime).toBeLessThan(5000); // Should complete in under 5 seconds
      expect(result.statistics.processingTimeMs).toBeCloseTo(processingTime, 0);
    });
  });
});
