// src/lib/dataLoader.ts
import { ProfileData, Measurement } from '../types';
import { parseProfileFilename } from '../utils/filenameParser';
import { parseIcmFile } from './parsers/icmParser';
import { parseCxfFile } from './parsers/cxfParser';

/**
 * Load and parse a color profile file (.icm or .cxf)
 */
export async function loadProfile(file: File): Promise<ProfileData> {
  const metadata = parseProfileFilename(file.name);
  const extension = file.name.split('.').pop()?.toLowerCase();
  
  let measurements: Measurement[] = [];
  let hasSpectral = false;
  let wavelengths: number[] | undefined;
  let patchCount = 0;
  
  try {
    if (extension === 'icm') {
      // Parse ICC profile
      const result = await parseIcmFile(file);
      measurements = result.measurements;
      hasSpectral = result.hasSpectral;
      wavelengths = result.wavelengths;
      patchCount = result.patchCount;
    } else if (extension === 'cxf' || extension === 'cxfz') {
      // Parse CxF file
      const result = await parseCxfFile(file);
      measurements = result.measurements;
      hasSpectral = result.hasSpectral;
      wavelengths = result.wavelengths;
      patchCount = result.patchCount;
    } else {
      throw new Error(`Unsupported file format: ${extension}`);
    }
  } catch (error) {
    console.error(`Error parsing ${file.name}:`, error);
    throw error;
  }
  
  // Apply basic data cleaning (outlier removal placeholder)
  const cleanMeasurements = applyBasicCleaning(measurements);
  
  // Calculate average DeltaE between raw and clean
  const averageDeltaERawClean = calculateAverageDeltaE(measurements, cleanMeasurements);
  
  return {
    metadata,
    raw: measurements,
    clean: cleanMeasurements,
    has_spectral: hasSpectral,
    patch_count: patchCount,
    average_deltaE_raw_clean: averageDeltaERawClean,
    wavelengths,
  };
}

/**
 * Apply basic cleaning to measurement data
 * - Remove obvious outliers
 * - Smooth spectral data if present
 */
function applyBasicCleaning(measurements: Measurement[]): Measurement[] {
  // For now, return a copy with minor adjustments
  // In production, this would implement Savitzky-Golay filtering
  // and statistical outlier detection
  
  return measurements.map(m => ({
    ...m,
    is_outlier: false, // Placeholder for outlier detection
  }));
}

/**
 * Calculate average DeltaE between raw and cleaned measurements
 */
function calculateAverageDeltaE(raw: Measurement[], clean: Measurement[]): number {
  if (raw.length === 0 || clean.length === 0) return 0;
  
  const minLen = Math.min(raw.length, clean.length);
  let totalDeltaE = 0;
  
  for (let i = 0; i < minLen; i++) {
    const dL = raw[i].LAB_L - clean[i].LAB_L;
    const da = raw[i].LAB_A - clean[i].LAB_A;
    const db = raw[i].LAB_B - clean[i].LAB_B;
    
    // Simple Euclidean distance in Lab space
    const deltaE = Math.sqrt(dL * dL + da * da + db * db);
    totalDeltaE += deltaE;
  }
  
  return totalDeltaE / minLen;
}

/**
 * Load multiple profile files
 */
export async function loadMultipleProfiles(files: FileList): Promise<ProfileData[]> {
  const promises = Array.from(files).map(file => loadProfile(file));
  const results = await Promise.allSettled(promises);
  
  const successfulProfiles: ProfileData[] = [];
  
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      successfulProfiles.push(result.value);
    } else {
      console.error(`Failed to load file ${files[index].name}:`, result.reason);
    }
  });
  
  return successfulProfiles;
}