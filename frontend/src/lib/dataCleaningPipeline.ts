/**
 * Data Cleaning Pipeline for Spectral Data
 * 
 * Provides methods for:
 * - Savitzky-Golay smoothing filter
 * - Outlier detection and removal
 * - Noise reduction algorithms
 */

export interface SpectralData {
  wavelengths: number[];
  values: number[];
}

export interface CleaningOptions {
  /** Window size for Savitzky-Golay filter (must be odd) */
  sgWindow_size?: number;
  /** Polynomial order for Savitzky-Golay filter */
  sgPolynomialOrder?: number;
  /** Number of standard deviations for outlier detection */
  outlierThreshold?: number;
  /** Method for outlier detection: 'zscore' | 'iqr' | 'mad' */
  outlierMethod?: 'zscore' | 'iqr' | 'mad';
  /** Whether to remove outliers or replace with interpolated values */
  outlierHandling?: 'remove' | 'interpolate';
  /** Window size for moving average noise reduction */
  noiseReductionWindow?: number;
}

export interface CleaningResult {
  cleanedData: SpectralData;
  removedIndices: number[];
  statistics: {
    originalPoints: number;
    cleanedPoints: number;
    outliersRemoved: number;
    smoothingApplied: boolean;
    noiseReductionApplied: boolean;
  };
}

export class DataCleaningPipeline {
  private options: Required<CleaningOptions>;

  constructor(options: CleaningOptions = {}) {
    this.options = {
      sgWindow_size: options.sgWindow_size ?? 5,
      sgPolynomialOrder: options.sgPolynomialOrder ?? 2,
      outlierThreshold: options.outlierThreshold ?? 3,
      outlierMethod: options.outlierMethod ?? 'zscore',
      outlierHandling: options.outlierHandling ?? 'interpolate',
      noiseReductionWindow: options.noiseReductionWindow ?? 3,
    };

    // Validate Savitzky-Golay parameters
    if (this.options.sgWindow_size % 2 === 0) {
      throw new Error('Savitzky-Golay window size must be odd');
    }
    if (this.options.sgPolynomialOrder >= this.options.sgWindow_size) {
      throw new Error('Polynomial order must be less than window size');
    }
  }

  /**
   * Execute the full cleaning pipeline
   */
  clean(data: SpectralData): CleaningResult {
    const originalPoints = data.values.length;
    let currentData = { ...data, values: [...data.values] };
    const removedIndices: number[] = [];

    // Step 1: Apply Savitzky-Golay smoothing
    const smoothedValues = this.applySavitzkyGolay(currentData.values);
    currentData.values = smoothedValues;

    // Step 2: Detect and handle outliers
    const outlierResult = this.handleOutliers(currentData.values);
    currentData.values = outlierResult.values;
    removedIndices.push(...outlierResult.removedIndices);

    // Step 3: Apply additional noise reduction
    const denoisedValues = this.applyNoiseReduction(currentData.values);
    currentData.values = denoisedValues;

    return {
      cleanedData: {
        wavelengths: currentData.wavelengths,
        values: currentData.values,
      },
      removedIndices,
      statistics: {
        originalPoints,
        cleanedPoints: currentData.values.length,
        outliersRemoved: removedIndices.length,
        smoothingApplied: true,
        noiseReductionApplied: true,
      },
    };
  }

  /**
   * Apply Savitzky-Golay smoothing filter
   * 
   * This filter preserves higher moments of the data (like peak heights and widths)
   * while smoothing out noise. It fits a polynomial to a sliding window of points.
   */
  applySavitzkyGolay(values: number[]): number[] {
    const { sgWindow_size: windowSize, sgPolynomialOrder: order } = this.options;
    
    if (values.length < windowSize) {
      console.warn('Data too short for Savitzky-Golay filter, returning original data');
      return [...values];
    }

    // Pre-compute convolution coefficients
    const coefficients = this.computeSavitzkyGolayCoefficients(windowSize, order);
    
    const result = new Array(values.length);
    const halfWindow = Math.floor(windowSize / 2);

    // Apply filter to interior points
    for (let i = halfWindow; i < values.length - halfWindow; i++) {
      let sum = 0;
      for (let j = 0; j < windowSize; j++) {
        sum += coefficients[j] * values[i - halfWindow + j];
      }
      result[i] = sum;
    }

    // Handle boundaries by copying original values or using smaller windows
    for (let i = 0; i < halfWindow; i++) {
      result[i] = values[i];
    }
    for (let i = values.length - halfWindow; i < values.length; i++) {
      result[i] = values[i];
    }

    return result;
  }

  /**
   * Compute Savitzky-Golay convolution coefficients using least squares
   */
  private computeSavitzkyGolayCoefficients(windowSize: number, order: number): number[] {
    const halfWindow = Math.floor(windowSize / 2);
    
    // Build design matrix A where A[i][j] = i^j
    const A: number[][] = [];
    for (let i = -halfWindow; i <= halfWindow; i++) {
      const row: number[] = [];
      for (let j = 0; j <= order; j++) {
        row.push(Math.pow(i, j));
      }
      A.push(row);
    }

    // Compute (A^T * A)^(-1) * A^T using normal equations
    const AT = this.transpose(A);
    const ATA = this.multiply(AT, A);
    const ATA_inv = this.inverse(ATA);
    const coeffs_matrix = this.multiply(ATA_inv, AT);

    // Extract coefficients for the 0th derivative (smoothing)
    // We want the first row (corresponding to the constant term)
    const coefficients = coeffs_matrix[0];
    
    return coefficients;
  }

  /**
   * Detect and handle outliers in the data
   */
  private handleOutliers(values: number[]): { values: number[]; removedIndices: number[] } {
    const { outlierThreshold, outlierMethod, outlierHandling } = this.options;
    const removedIndices: number[] = [];
    const result = [...values];

    let outlierMask: boolean[];

    switch (outlierMethod) {
      case 'zscore':
        outlierMask = this.detectOutliersZScore(values, outlierThreshold);
        break;
      case 'iqr':
        outlierMask = this.detectOutliersIQR(values, outlierThreshold);
        break;
      case 'mad':
        outlierMask = this.detectOutliersMAD(values, outlierThreshold);
        break;
      default:
        outlierMask = this.detectOutliersZScore(values, outlierThreshold);
    }

    // Handle outliers based on strategy
    for (let i = 0; i < outlierMask.length; i++) {
      if (outlierMask[i]) {
        removedIndices.push(i);
        
        if (outlierHandling === 'interpolate') {
          // Replace with linear interpolation from neighbors
          result[i] = this.interpolateValue(values, i);
        } else {
          // Mark for removal (will be handled by caller if needed)
          result[i] = NaN;
        }
      }
    }

    // If removing, filter out NaN values
    if (outlierHandling === 'remove') {
      return {
        values: result.filter(v => !isNaN(v)),
        removedIndices,
      };
    }

    return { values: result, removedIndices };
  }

  /**
   * Detect outliers using Z-score method
   */
  private detectOutliersZScore(values: number[], threshold: number): boolean[] {
    const mean = this.mean(values);
    const stdDev = this.standardDeviation(values, mean);
    
    if (stdDev === 0) {
      return values.map(() => false);
    }

    return values.map(v => Math.abs((v - mean) / stdDev) > threshold);
  }

  /**
   * Detect outliers using Interquartile Range (IQR) method
   */
  private detectOutliersIQR(values: number[], threshold: number): boolean[] {
    const sorted = [...values].sort((a, b) => a - b);
    const q1 = this.percentile(sorted, 25);
    const q3 = this.percentile(sorted, 75);
    const iqr = q3 - q1;
    
    const lowerBound = q1 - threshold * iqr;
    const upperBound = q3 + threshold * iqr;

    return values.map(v => v < lowerBound || v > upperBound);
  }

  /**
   * Detect outliers using Median Absolute Deviation (MAD) method
   * More robust to outliers than Z-score
   */
  private detectOutliersMAD(values: number[], threshold: number): boolean[] {
    const median = this.median(values);
    const absoluteDeviations = values.map(v => Math.abs(v - median));
    const mad = this.median(absoluteDeviations);
    
    if (mad === 0) {
      return values.map(() => false);
    }

    // Modified Z-score using MAD
    const modifiedZScore = values.map(v => 0.6745 * (v - median) / mad);
    return modifiedZScore.map(z => Math.abs(z) > threshold);
  }

  /**
   * Apply noise reduction using moving average or other methods
   */
  applyNoiseReduction(values: number[]): number[] {
    const windowSize = this.options.noiseReductionWindow;
    
    if (windowSize <= 1 || values.length < windowSize) {
      return [...values];
    }

    const result = new Array(values.length);
    const halfWindow = Math.floor(windowSize / 2);

    // Apply moving average
    for (let i = 0; i < values.length; i++) {
      const start = Math.max(0, i - halfWindow);
      const end = Math.min(values.length, i + halfWindow + 1);
      
      let sum = 0;
      let count = 0;
      for (let j = start; j < end; j++) {
        if (!isNaN(values[j])) {
          sum += values[j];
          count++;
        }
      }
      
      result[i] = count > 0 ? sum / count : values[i];
    }

    return result;
  }

  /**
   * Interpolate a value at the given index using neighboring values
   */
  private interpolateValue(values: number[], index: number): number {
    // Find nearest non-outlier neighbors
    let leftIndex = index - 1;
    let rightIndex = index + 1;

    while (leftIndex >= 0 && isNaN(values[leftIndex])) {
      leftIndex--;
    }
    while (rightIndex < values.length && isNaN(values[rightIndex])) {
      rightIndex++;
    }

    if (leftIndex < 0 && rightIndex >= values.length) {
      return 0; // No valid neighbors
    }
    if (leftIndex < 0) {
      return values[rightIndex];
    }
    if (rightIndex >= values.length) {
      return values[leftIndex];
    }

    // Linear interpolation
    const fraction = (index - leftIndex) / (rightIndex - leftIndex);
    return values[leftIndex] + fraction * (values[rightIndex] - values[leftIndex]);
  }

  // Utility functions
  private mean(values: number[]): number {
    const validValues = values.filter(v => !isNaN(v));
    if (validValues.length === 0) return 0;
    return validValues.reduce((sum, v) => sum + v, 0) / validValues.length;
  }

  private standardDeviation(values: number[], mean: number): number {
    const validValues = values.filter(v => !isNaN(v));
    if (validValues.length < 2) return 0;
    const squaredDiffs = validValues.map(v => Math.pow(v - mean, 2));
    const avgSquaredDiff = squaredDiffs.reduce((sum, d) => sum + d, 0) / (validValues.length - 1);
    return Math.sqrt(avgSquaredDiff);
  }

  private median(values: number[]): number {
    const validValues = values.filter(v => !isNaN(v)).sort((a, b) => a - b);
    if (validValues.length === 0) return 0;
    const mid = Math.floor(validValues.length / 2);
    if (validValues.length % 2 === 0) {
      return (validValues[mid - 1] + validValues[mid]) / 2;
    }
    return validValues[mid];
  }

  private percentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 0) return 0;
    const index = (p / 100) * (sortedValues.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) {
      return sortedValues[lower];
    }
    const fraction = index - lower;
    return sortedValues[lower] + fraction * (sortedValues[upper] - sortedValues[lower]);
  }

  private transpose(matrix: number[][]): number[][] {
    return matrix[0].map((_, colIndex) => matrix.map(row => row[colIndex]));
  }

  private multiply(a: number[][], b: number[][]): number[][] {
    const result: number[][] = [];
    for (let i = 0; i < a.length; i++) {
      result[i] = [];
      for (let j = 0; j < b[0].length; j++) {
        let sum = 0;
        for (let k = 0; k < b.length; k++) {
          sum += a[i][k] * b[k][j];
        }
        result[i][j] = sum;
      }
    }
    return result;
  }

  private inverse(matrix: number[][]): number[][] {
    // For small matrices (2x2, 3x3, etc.) use direct formula
    // For larger matrices, use Gaussian elimination
    const n = matrix.length;
    
    // Create augmented matrix [A|I]
    const aug = matrix.map((row, i) => [
      ...row,
      ...Array(n).fill(0).map((_, j) => (i === j ? 1 : 0)),
    ]);

    // Gaussian elimination with partial pivoting
    for (let col = 0; col < n; col++) {
      // Find pivot
      let maxRow = col;
      for (let row = col + 1; row < n; row++) {
        if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) {
          maxRow = row;
        }
      }
      
      // Swap rows
      [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

      // Scale pivot row
      const pivot = aug[col][col];
      if (Math.abs(pivot) < 1e-10) {
        throw new Error('Matrix is singular or nearly singular');
      }
      
      for (let j = 0; j < 2 * n; j++) {
        aug[col][j] /= pivot;
      }

      // Eliminate column
      for (let row = 0; row < n; row++) {
        if (row !== col) {
          const factor = aug[row][col];
          for (let j = 0; j < 2 * n; j++) {
            aug[row][j] -= factor * aug[col][j];
          }
        }
      }
    }

    // Extract inverse matrix
    return aug.map(row => row.slice(n));
  }
}

/**
 * Factory function to create a data cleaning pipeline with common presets
 */
export function createCleaningPipeline(preset: 'gentle' | 'moderate' | 'aggressive' = 'moderate'): DataCleaningPipeline {
  const presets: Record<string, CleaningOptions> = {
    gentle: {
      sgWindow_size: 5,
      sgPolynomialOrder: 2,
      outlierThreshold: 3.5,
      outlierMethod: 'mad',
      outlierHandling: 'interpolate',
      noiseReductionWindow: 3,
    },
    moderate: {
      sgWindow_size: 7,
      sgPolynomialOrder: 2,
      outlierThreshold: 3,
      outlierMethod: 'zscore',
      outlierHandling: 'interpolate',
      noiseReductionWindow: 3,
    },
    aggressive: {
      sgWindow_size: 9,
      sgPolynomialOrder: 3,
      outlierThreshold: 2.5,
      outlierMethod: 'iqr',
      outlierHandling: 'remove',
      noiseReductionWindow: 5,
    },
  };

  return new DataCleaningPipeline(presets[preset]);
}
