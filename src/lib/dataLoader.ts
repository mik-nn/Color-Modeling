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
    if (extension === 'icm' || extension === 'icc') {
      const result = await parseIcmFile(file);
      measurements = result.measurements;
      hasSpectral = result.hasSpectral;
      wavelengths = result.wavelengths;
      patchCount = result.patchCount;
    } else if (extension === 'cxf') {
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

  const cleanMeasurements = applyBasicCleaning(measurements);
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
 * Apply basic cleaning to measurement data (outlier flagging placeholder).
 */
function applyBasicCleaning(measurements: Measurement[]): Measurement[] {
  return measurements.map(m => ({ ...m, is_outlier: false }));
}

/**
 * Calculate average DeltaE (Euclidean in Lab) between raw and cleaned measurements.
 */
function calculateAverageDeltaE(raw: Measurement[], clean: Measurement[]): number {
  if (raw.length === 0 || clean.length === 0) return 0;

  const minLen = Math.min(raw.length, clean.length);
  let total = 0;

  for (let i = 0; i < minLen; i++) {
    const dL = raw[i].LAB_L - clean[i].LAB_L;
    const da = raw[i].LAB_A - clean[i].LAB_A;
    const db = raw[i].LAB_B - clean[i].LAB_B;
    total += Math.sqrt(dL * dL + da * da + db * db);
  }

  return total / minLen;
}

/**
 * Load multiple profile files, collecting successful parses.
 */
export async function loadMultipleProfiles(files: FileList): Promise<ProfileData[]> {
  const results = await Promise.allSettled(
    Array.from(files).map(file => loadProfile(file))
  );

  const profiles: ProfileData[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      profiles.push(result.value);
    } else {
      console.error(`Failed to load ${files[index].name}:`, result.reason);
    }
  });

  return profiles;
}
