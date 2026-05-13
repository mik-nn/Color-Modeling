/**
 * Data Processing Service
 * 
 * Integrates Data Cleaning Pipeline with profile loading workflow.
 * Provides configurable data cleaning options for spectral measurements.
 */

import { ProfileData, Measurement } from '../types';
import { DataCleaningPipeline, CleaningOptions, createCleaningPipeline, SpectralData } from './dataCleaningPipeline';

export interface ProcessingOptions {
  /** Enable/disable data cleaning */
  enableCleaning: boolean;
  /** Cleaning preset: 'gentle' | 'moderate' | 'aggressive' */
  preset?: 'gentle' | 'moderate' | 'aggressive';
  /** Custom cleaning options (overrides preset if provided) */
  customOptions?: CleaningOptions;
}

export interface ProcessingResult {
  originalProfile: ProfileData;
  cleanedProfile: ProfileData;
  statistics: {
    measurementsProcessed: number;
    spectralBandsPerMeasurement: number;
    totalOutliersDetected: number;
    averageDeltaEBeforeAfter: number;
    smoothingApplied: boolean;
    noiseReductionApplied: boolean;
    processingTimeMs: number;
  };
}

export class DataProcessingService {
  private pipeline: DataCleaningPipeline | null = null;
  private options: ProcessingOptions;

  constructor(options: ProcessingOptions) {
    this.options = options;
    
    if (options.enableCleaning) {
      if (options.customOptions) {
        this.pipeline = new DataCleaningPipeline(options.customOptions);
      } else if (options.preset) {
        this.pipeline = createCleaningPipeline(options.preset);
      } else {
        this.pipeline = createCleaningPipeline('moderate');
      }
    }
  }

  /**
   * Process a profile with optional data cleaning
   */
  async processProfile(profile: ProfileData): Promise<ProcessingResult> {
    const startTime = performance.now();
    
    if (!this.options.enableCleaning || !this.pipeline) {
      // Return original profile without cleaning
      return {
        originalProfile: profile,
        cleanedProfile: profile,
        statistics: {
          measurementsProcessed: profile.raw.length,
          spectralBandsPerMeasurement: profile.wavelengths?.length ?? 0,
          totalOutliersDetected: 0,
          averageDeltaEBeforeAfter: 0,
          smoothingApplied: false,
          noiseReductionApplied: false,
          processingTimeMs: 0,
        },
      };
    }

    // Process each measurement with spectral data
    const cleanedMeasurements = profile.raw.map(measurement => {
      if (!measurement.spectra || !measurement.wavelengths) {
        // No spectral data, return as-is
        return { ...measurement, is_outlier: false };
      }

      // Create spectral data object
      const spectralData: SpectralData = {
        wavelengths: measurement.wavelengths,
        values: measurement.spectra,
      };

      // Apply cleaning pipeline
      const result = this.pipeline!.clean(spectralData);
      
      // Calculate DeltaE between original and cleaned
      const deltaE = this.calculateSpectralDeltaE(
        measurement.spectra,
        result.cleanedData.values
      );

      return {
        ...measurement,
        spectra: result.cleanedData.values,
        is_outlier: result.removedIndices.length > 0,
        cleaning_deltaE: deltaE,
        cleaning_stats: result.statistics,
      };
    });

    const endTime = performance.now();
    const processingTimeMs = endTime - startTime;

    // Calculate statistics
    const totalOutliers = cleanedMeasurements.filter(m => m.is_outlier).length;
    const avgDeltaE = this.calculateAverageDeltaE(profile.raw, cleanedMeasurements);

    // Get pipeline statistics from first measurement with spectral data
    const firstWithStats = cleanedMeasurements.find(m => m.cleaning_stats);
    const smoothingApplied = firstWithStats?.cleaning_stats?.smoothingApplied ?? false;
    const noiseReductionApplied = firstWithStats?.cleaning_stats?.noiseReductionApplied ?? false;

    return {
      originalProfile: profile,
      cleanedProfile: {
        ...profile,
        clean: cleanedMeasurements,
        average_deltaE_raw_clean: avgDeltaE,
      },
      statistics: {
        measurementsProcessed: profile.raw.length,
        spectralBandsPerMeasurement: profile.wavelengths?.length ?? 0,
        totalOutliersDetected: totalOutliers,
        averageDeltaEBeforeAfter: avgDeltaE,
        smoothingApplied,
        noiseReductionApplied,
        processingTimeMs,
      },
    };
  }

  /**
   * Process multiple profiles
   */
  async processMultipleProfiles(profiles: ProfileData[]): Promise<ProcessingResult[]> {
    const results: ProcessingResult[] = [];
    
    for (const profile of profiles) {
      const result = await this.processProfile(profile);
      results.push(result);
    }
    
    return results;
  }

  /**
   * Update cleaning options dynamically
   */
  updateOptions(options: Partial<ProcessingOptions>): void {
    this.options = { ...this.options, ...options };
    
    // Reinitialize pipeline if cleaning is enabled
    if (this.options.enableCleaning) {
      if (this.options.customOptions) {
        this.pipeline = new DataCleaningPipeline(this.options.customOptions);
      } else if (this.options.preset) {
        this.pipeline = createCleaningPipeline(this.options.preset);
      } else {
        this.pipeline = createCleaningPipeline('moderate');
      }
    } else {
      this.pipeline = null;
    }
  }

  /**
   * Get current cleaning configuration
   */
  getCurrentConfig(): { enabled: boolean; preset?: string; options?: CleaningOptions } {
    return {
      enabled: this.options.enableCleaning,
      preset: this.options.preset,
      options: this.options.customOptions,
    };
  }

  /**
   * Calculate DeltaE between two spectral curves
   * Uses root mean square difference as a proxy for color difference
   */
  private calculateSpectralDeltaE(original: number[], cleaned: number[]): number {
    if (original.length !== cleaned.length || original.length === 0) {
      return 0;
    }

    let sumSquaredDiff = 0;
    for (let i = 0; i < original.length; i++) {
      const diff = original[i] - cleaned[i];
      sumSquaredDiff += diff * diff;
    }

    return Math.sqrt(sumSquaredDiff / original.length);
  }

  /**
   * Calculate average DeltaE in Lab space between raw and cleaned measurements
   */
  private calculateAverageDeltaE(raw: Measurement[], cleaned: Measurement[]): number {
    if (raw.length === 0 || cleaned.length === 0) return 0;
    
    const minLen = Math.min(raw.length, cleaned.length);
    let totalDeltaE = 0;
    
    for (let i = 0; i < minLen; i++) {
      const dL = raw[i].LAB_L - cleaned[i].LAB_L;
      const da = raw[i].LAB_A - cleaned[i].LAB_A;
      const db = raw[i].LAB_B - cleaned[i].LAB_B;
      
      const deltaE = Math.sqrt(dL * dL + da * da + db * db);
      totalDeltaE += deltaE;
    }
    
    return totalDeltaE / minLen;
  }
}

/**
 * Factory function to create a processing service with common configurations
 */
export function createProcessingService(
  preset: 'gentle' | 'moderate' | 'aggressive' | 'none' = 'moderate'
): DataProcessingService {
  if (preset === 'none') {
    return new DataProcessingService({ enableCleaning: false });
  }

  return new DataProcessingService({
    enableCleaning: true,
    preset: preset,
  });
}
