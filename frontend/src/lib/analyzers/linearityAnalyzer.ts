// src/lib/analyzers/linearityAnalyzer.ts
import { ProfileData, Measurement, LinearityResult } from '../../types';

/**
 * Linearity Analyzer for comparing color profiles
 * 
 * Analyzes the linear transfer characteristics between two substrates
 * using correlation analysis, residual analysis, and slope stability metrics.
 */

export interface LinearityAnalysisOptions {
  useSpectralData?: boolean;
  minPatches?: number;
  outlierThreshold?: number;
}

const DEFAULT_OPTIONS: LinearityAnalysisOptions = {
  useSpectralData: false,
  minPatches: 50,
  outlierThreshold: 3.0, // Standard deviations
};

/**
 * Perform linearity analysis between two profiles
 */
export function analyzeLinearity(
  referenceProfile: ProfileData,
  targetProfile: ProfileData,
  options: LinearityAnalysisOptions = {}
): LinearityResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  // Match patches by CMYK values
  const matchedPatches = matchPatchesByCMYK(referenceProfile.raw, targetProfile.raw);
  
  if (matchedPatches.length < opts.minPatches!) {
    throw new Error(`Insufficient matching patches: ${matchedPatches.length} < ${opts.minPatches}`);
  }
  
  // Calculate Pearson correlation for LAB values
  const labCorrelation = calculatePearsonCorrelation(
    matchedPatches.map(p => [p.ref.LAB_L, p.ref.LAB_A, p.ref.LAB_B]).flat(),
    matchedPatches.map(p => [p.target.LAB_L, p.target.LAB_A, p.target.LAB_B]).flat()
  );
  
  // Calculate residuals and their correlation
  const residuals = matchedPatches.map(p => ({
    L: p.target.LAB_L - p.ref.LAB_L,
    a: p.target.LAB_A - p.ref.LAB_A,
    b: p.target.LAB_B - p.ref.LAB_B,
  }));
  
  const residualCorrelation = calculateResidualCorrelation(residuals);
  
  // Calculate R² for linear regression
  const rSquared = calculateRSquared(matchedPatches);
  
  // Calculate slope stability score
  const slopeStabilityScore = calculateSlopeStability(matchedPatches);
  
  // Calculate mean DeltaE after correction
  const meanDeltaEAfterCorrection = calculateMeanDeltaEAfterCorrection(matchedPatches);
  
  // Determine confidence level
  const linearityConfidence = determineConfidenceLevel(
    labCorrelation,
    rSquared,
    slopeStabilityScore
  );
  
  return {
    reference_substrate: referenceProfile.metadata.substrate,
    target_substrate: targetProfile.metadata.substrate,
    pearson_corr_lab: labCorrelation,
    pearson_corr_residuals: residualCorrelation,
    r_squared: rSquared,
    slope_stability_score: slopeStabilityScore,
    mean_deltaE_after_correction: meanDeltaEAfterCorrection,
    n_patches_used: matchedPatches.length,
    linearity_confidence: linearityConfidence,
  };
}

interface MatchedPatch {
  ref: Measurement;
  target: Measurement;
  cmykKey: string;
}

/**
 * Match patches between two profiles by CMYK values
 */
function matchPatchesByCMYK(refPatches: Measurement[], targetPatches: Measurement[]): MatchedPatch[] {
  const targetMap = new Map<string, Measurement>();
  
  // Create lookup map for target patches
  targetPatches.forEach(patch => {
    const key = createCMYKKey(patch);
    targetMap.set(key, patch);
  });
  
  // Match reference patches to target
  const matched: MatchedPatch[] = [];
  
  refPatches.forEach(refPatch => {
    const key = createCMYKKey(refPatch);
    const targetPatch = targetMap.get(key);
    
    if (targetPatch) {
      matched.push({
        ref: refPatch,
        target: targetPatch,
        cmykKey: key,
      });
    } else {
      // Try fuzzy matching with tolerance
      const fuzzyMatch = findFuzzyMatch(refPatch, targetPatches, 2.0); // 2% tolerance
      if (fuzzyMatch) {
        matched.push({
          ref: refPatch,
          target: fuzzyMatch,
          cmykKey: createCMYKKey(refPatch),
        });
      }
    }
  });
  
  return matched;
}

/**
 * Create a unique key for CMYK values
 */
function createCMYKKey(patch: Measurement): string {
  const roundTo = (v: number) => Math.round(v * 10) / 10; // Round to 1 decimal
  return `${roundTo(patch.CMYK_C)},${roundTo(patch.CMYK_M)},${roundTo(patch.CMYK_Y)},${roundTo(patch.CMYK_K)}`;
}

/**
 * Find a fuzzy match for a patch within tolerance
 */
function findFuzzyMatch(patch: Measurement, candidates: Measurement[], tolerance: number): Measurement | null {
  for (const candidate of candidates) {
    const diffC = Math.abs(candidate.CMYK_C - patch.CMYK_C);
    const diffM = Math.abs(candidate.CMYK_M - patch.CMYK_M);
    const diffY = Math.abs(candidate.CMYK_Y - patch.CMYK_Y);
    const diffK = Math.abs(candidate.CMYK_K - patch.CMYK_K);
    
    if (diffC <= tolerance && diffM <= tolerance && 
        diffY <= tolerance && diffK <= tolerance) {
      return candidate;
    }
  }
  return null;
}

/**
 * Calculate Pearson correlation coefficient
 */
function calculatePearsonCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length === 0) return 0;
  
  const n = x.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
  const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);
  
  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  
  if (denominator === 0) return 0;
  
  return numerator / denominator;
}

/**
 * Calculate correlation of residuals
 */
function calculateResidualCorrelation(residuals: Array<{L: number; a: number; b: number}>): number {
  // Flatten residuals
  const flatResiduals = residuals.flatMap(r => [r.L, r.a, r.b]);
  
  // Calculate variance of residuals
  const mean = flatResiduals.reduce((a, b) => a + b, 0) / flatResiduals.length;
  const variance = flatResiduals.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / flatResiduals.length;
  
  // If variance is low, residuals are consistent (good)
  // Return inverse correlation (lower variance = higher correlation)
  const stdDev = Math.sqrt(variance);
  
  // Normalize to 0-1 range (assuming typical stdDev range of 0-10)
  const normalizedCorrelation = Math.max(0, 1 - stdDev / 10);
  
  return normalizedCorrelation;
}

/**
 * Calculate R² (coefficient of determination)
 */
function calculateRSquared(matchedPatches: MatchedPatch[]): number {
  const n = matchedPatches.length;
  if (n === 0) return 0;
  
  // Calculate means
  const refMean = {
    L: matchedPatches.reduce((sum, p) => sum + p.ref.LAB_L, 0) / n,
    a: matchedPatches.reduce((sum, p) => sum + p.ref.LAB_A, 0) / n,
    b: matchedPatches.reduce((sum, p) => sum + p.ref.LAB_B, 0) / n,
  };
  
  // Calculate total sum of squares (SST) and residual sum of squares (SSR)
  let sst = 0;
  let ssr = 0;
  
  matchedPatches.forEach(p => {
    const refTotal = Math.pow(p.ref.LAB_L - refMean.L, 2) +
                     Math.pow(p.ref.LAB_A - refMean.a, 2) +
                     Math.pow(p.ref.LAB_B - refMean.b, 2);
    
    const targetTotal = Math.pow(p.target.LAB_L - refMean.L, 2) +
                        Math.pow(p.target.LAB_A - refMean.a, 2) +
                        Math.pow(p.target.LAB_B - refMean.b, 2);
    
    sst += refTotal;
    ssr += Math.pow(targetTotal - refTotal, 2);
  });
  
  if (sst === 0) return 1;
  
  return 1 - (ssr / sst);
}

/**
 * Calculate slope stability score
 * Measures consistency of relative slopes between CMYK channels
 */
function calculateSlopeStability(matchedPatches: MatchedPatch[]): number {
  if (matchedPatches.length < 2) return 0;
  
  // Group patches by dominant channel
  const groups: Record<string, Array<{ref: number; target: number}>> = {
    C: [], M: [], Y: [], K: []
  };
  
  matchedPatches.forEach(p => {
    // Use L* as response variable
    const maxChannel = getMaxChannel(p.ref);
    groups[maxChannel].push({
      ref: p.ref.LAB_L,
      target: p.target.LAB_L,
    });
  });
  
  // Calculate slope for each channel group
  const slopes: number[] = [];
  
  Object.values(groups).forEach(group => {
    if (group.length >= 2) {
      const slope = calculateLinearSlope(group.map(g => g.ref), group.map(g => g.target));
      if (isFinite(slope)) {
        slopes.push(slope);
      }
    }
  });
  
  if (slopes.length === 0) return 0;
  
  // Calculate coefficient of variation of slopes
  const meanSlope = slopes.reduce((a, b) => a + b, 0) / slopes.length;
  const variance = slopes.reduce((sum, s) => sum + Math.pow(s - meanSlope, 2), 0) / slopes.length;
  const stdDev = Math.sqrt(variance);
  
  // Lower CV = higher stability
  const cv = meanSlope !== 0 ? stdDev / Math.abs(meanSlope) : stdDev;
  
  // Convert to 0-1 score (lower CV = higher score)
  return Math.max(0, 1 - cv);
}

/**
 * Get the dominant CMYK channel
 */
function getMaxChannel(measurement: Measurement): 'C' | 'M' | 'Y' | 'K' {
  const values = {
    C: measurement.CMYK_C,
    M: measurement.CMYK_M,
    Y: measurement.CMYK_Y,
    K: measurement.CMYK_K,
  };
  
  return (Object.entries(values).reduce((max, [key, val]) => 
    val > max.val ? { key: key as 'C' | 'M' | 'Y' | 'K', val } : max
  , { key: 'K' as 'C' | 'M' | 'Y' | 'K', val: -1 })).key;
}

/**
 * Calculate linear regression slope
 */
function calculateLinearSlope(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 2) return 0;
  
  const n = x.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
  
  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return 0;
  
  return (n * sumXY - sumX * sumY) / denominator;
}

/**
 * Calculate mean DeltaE00 after linear correction
 */
function calculateMeanDeltaEAfterCorrection(matchedPatches: MatchedPatch[]): number {
  if (matchedPatches.length === 0) return Infinity;
  
  // Simple linear correction model
  const corrections = {
    L: matchedPatches.reduce((sum, p) => sum + (p.target.LAB_L - p.ref.LAB_L), 0) / matchedPatches.length,
    a: matchedPatches.reduce((sum, p) => sum + (p.target.LAB_A - p.ref.LAB_A), 0) / matchedPatches.length,
    b: matchedPatches.reduce((sum, p) => sum + (p.target.LAB_B - p.ref.LAB_B), 0) / matchedPatches.length,
  };
  
  // Apply correction and calculate DeltaE
  const deltaEs = matchedPatches.map(p => {
    const correctedTarget = {
      L: p.target.LAB_L - corrections.L,
      a: p.target.LAB_A - corrections.a,
      b: p.target.LAB_B - corrections.b,
    };
    
    return calculateDeltaE00(
      p.ref.LAB_L, p.ref.LAB_A, p.ref.LAB_B,
      correctedTarget.L, correctedTarget.a, correctedTarget.b
    );
  });
  
  return deltaEs.reduce((sum, de) => sum + de, 0) / deltaEs.length;
}

/**
 * Calculate CIEDE2000 (ΔE00) color difference
 * Simplified implementation
 */
function calculateDeltaE00(
  L1: number, a1: number, b1: number,
  L2: number, a2: number, b2: number
): number {
  // Simplified ΔE00 calculation
  // Full implementation would include weighting functions and rotation terms
  
  const dL = L2 - L1;
  const da = a2 - a1;
  const db = b2 - b1;
  
  // Mean values
  const C1 = Math.sqrt(a1 * a1 + b1 * b1);
  const C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const C_mean = (C1 + C2) / 2;
  
  // Weighting factors
  const SL = 1;
  const SC = 1 + 0.045 * C_mean;
  const SH = 1 + 0.015 * C_mean;
  
  const dC = C2 - C1;
  const dH = Math.sqrt(da * da + db * db - dC * dC);
  
  const dE = Math.sqrt(
    Math.pow(dL / SL, 2) +
    Math.pow(dC / SC, 2) +
    Math.pow(dH / SH, 2)
  );
  
  return dE;
}

/**
 * Determine confidence level based on metrics
 */
function determineConfidenceLevel(
  pearsonCorr: number,
  rSquared: number,
  slopeStability: number
): 'high' | 'medium' | 'low' {
  const avgScore = (pearsonCorr + rSquared + slopeStability) / 3;
  
  if (avgScore >= 0.85) return 'high';
  if (avgScore >= 0.65) return 'medium';
  return 'low';
}
