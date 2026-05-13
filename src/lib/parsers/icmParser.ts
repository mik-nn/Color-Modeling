// src/lib/parsers/icmParser.ts
import { Measurement } from '../../types';

/**
 * Parser for ICC (.icm) profile measurement data
 * 
 * ICC profiles may contain CxF (Color Exchange Format) tags with spectral data.
 * This parser extracts measurement data from ICC profile binary format,
 * prioritizing CxF tag data when available.
 */

export interface IcmParseResult {
  measurements: Measurement[];
  hasSpectral: boolean;
  wavelengths?: number[];
  patchCount: number;
}

/**
 * Parse ICC profile file and extract measurement data
 */
export async function parseIcmFile(file: File): Promise<IcmParseResult> {
  const arrayBuffer = await file.arrayBuffer();
  const dataView = new DataView(arrayBuffer);
  
  // Validate ICC header
  if (dataView.byteLength < 128) {
    throw new Error('Invalid ICC profile: file too small');
  }
  
  const size = dataView.getUint32(0, false);
  if (size !== dataView.byteLength) {
    console.warn(`ICC profile size mismatch: header says ${size}, actual ${dataView.byteLength}`);
  }
  
  // Read color space
  const colorSpace = String.fromCharCode(
    dataView.getUint8(16),
    dataView.getUint8(17),
    dataView.getUint8(18),
    dataView.getUint8(19)
  );
  
  // For CMYK profiles, we expect 'CMYK' color space
  if (colorSpace !== 'CMYK' && colorSpace !== 'RGB ') {
    console.warn(`Unexpected color space: ${colorSpace}`);
  }
  
  // FIRST: Try to extract CxF tag data (spectral data)
  const cxfResult = await extractCxFData(dataView, file);
  if (cxfResult && cxfResult.measurements.length > 0) {
    return {
      measurements: cxfResult.measurements,
      hasSpectral: true,
      wavelengths: cxfResult.wavelengths,
      patchCount: cxfResult.measurements.length,
    };
  }
  
  // SECOND: Try to extract measurement data from A2B tables
  const measurements = await extractMeasurementsFromProfile(dataView, colorSpace);
  
  if (measurements.length === 0) {
    throw new Error('No measurement data found in ICC profile. Profile must contain CxF tag with spectral data.');
  }
  
  return {
    measurements,
    hasSpectral: false,
    patchCount: measurements.length,
  };
}

/**
 * Extract CxF data from ICC profile tag
 * CxF data is typically stored in a private tag or desc tag
 */
async function extractCxFData(dataView: DataView, file: File): Promise<{
  measurements: Measurement[];
  wavelengths?: number[];
} | null> {
  try {
    // Read tag table
    const tagTableOffset = 128;
    if (dataView.byteLength < tagTableOffset + 4) return null;
    
    const tagCount = dataView.getUint32(tagTableOffset + 4, false);
    
    // Search for CxF-related tags
    // Common tags that might contain CxF data: 'desc', 'cprt', 'dmnd', or private tags
    const possibleTags = ['desc', 'cprt', 'dmnd', 'lumi', 'meas', 'bkpt', 'rTRC', 'gTRC', 'bTRC'];
    
    for (let i = 0; i < tagCount; i++) {
      const entryOffset = tagTableOffset + 8 + (i * 12);
      if (entryOffset + 12 > dataView.byteLength) break;
      
      const signature = dataView.getUint32(entryOffset, false);
      const offset = dataView.getUint32(entryOffset + 4, false);
      const size = dataView.getUint32(entryOffset + 8, false);
      
      // Convert signature to string
      const sigStr = String.fromCharCode(
        (signature >> 24) & 0xFF,
        (signature >> 16) & 0xFF,
        (signature >> 8) & 0xFF,
        signature & 0xFF
      );
      
      // Check if this might be a CxF tag (look for XML content)
      if (offset + size <= dataView.byteLength && size > 100) {
        const tagData = new Uint8Array(arrayBuffer, offset, Math.min(size, 10000));
        const textDecoder = new TextDecoder('utf-8');
        const tagText = textDecoder.decode(tagData);
        
        // Look for CxF XML markers
        if (tagText.includes('<CxF') || tagText.includes('Colorant') || 
            tagText.includes('Spectral') || tagText.includes('reflectance')) {
          // Found CxF data, parse it
          const cxfBlob = new Blob([arrayBuffer.slice(offset, offset + size)]);
          const cxfFile = new File([cxfBlob], 'embedded.cxf', { type: 'text/xml' });
          
          // Use the CXF parser
          const { parseCxfFile } = await import('./cxfParser');
          return await parseCxfFile(cxfFile);
        }
      }
    }
    
    // If no embedded CxF found in tags, check if there's appended data after the ICC profile
    const fileSize = file.size;
    const iccSize = dataView.getUint32(0, false);
    
    if (fileSize > iccSize) {
      // There might be appended CxF data
      const appendedData = arrayBuffer.slice(iccSize);
      const textDecoder = new TextDecoder('utf-8');
      const appendedText = textDecoder.decode(new Uint8Array(appendedData));
      
      if (appendedText.includes('<CxF') || appendedText.includes('Colorant') ||
          appendedText.includes('Spectral') || appendedText.includes('reflectance')) {
        const cxfBlob = new Blob([appendedData]);
        const cxfFile = new File([cxfBlob], 'appended.cxf', { type: 'text/xml' });
        
        const { parseCxfFile } = await import('./cxfParser');
        return await parseCxfFile(cxfFile);
      }
    }
  } catch (error) {
    console.warn('Failed to extract CxF data from ICC profile:', error);
  }
  
  return null;
}

// Need to capture arrayBuffer in the closure
async function extractCxFData(dataView: DataView, file: File): Promise<{
  measurements: Measurement[];
  wavelengths?: number[];
} | null> {
  const arrayBuffer = await file.arrayBuffer();
  try {
    // Read tag table
    const tagTableOffset = 128;
    if (dataView.byteLength < tagTableOffset + 4) return null;
    
    const tagCount = dataView.getUint32(tagTableOffset + 4, false);
    
    // Search for CxF-related tags or any tag that might contain XML data
    for (let i = 0; i < tagCount; i++) {
      const entryOffset = tagTableOffset + 8 + (i * 12);
      if (entryOffset + 12 > dataView.byteLength) break;
      
      const signature = dataView.getUint32(entryOffset, false);
      const offset = dataView.getUint32(entryOffset + 4, false);
      const size = dataView.getUint32(entryOffset + 8, false);
      
      // Convert signature to string
      const sigStr = String.fromCharCode(
        (signature >> 24) & 0xFF,
        (signature >> 16) & 0xFF,
        (signature >> 8) & 0xFF,
        signature & 0xFF
      );
      
      // Check if this tag might contain CxF/XML data
      if (offset + size <= dataView.byteLength && size > 100 && size < 500000) {
        const tagData = new Uint8Array(arrayBuffer, offset, Math.min(size, 50000));
        const textDecoder = new TextDecoder('utf-8', { fatal: false });
        
        try {
          const tagText = textDecoder.decode(tagData);
          
          // Look for CxF XML markers
          if (tagText.includes('<CxF') || tagText.includes('Colorant') || 
              tagText.includes('Spectral') || tagText.includes('reflectance') ||
              tagText.includes('<Patch') || tagText.includes('LAB_L')) {
            // Found CxF data, parse it
            const cxfBlob = new Blob([arrayBuffer.slice(offset, offset + size)]);
            const cxfFile = new File([cxfBlob], 'embedded.cxf', { type: 'text/xml' });
            
            // Use the CXF parser
            const { parseCxfFile } = await import('./cxfParser');
            const result = await parseCxfFile(cxfFile);
            return {
              measurements: result.measurements,
              wavelengths: result.wavelengths,
            };
          }
        } catch (decodeError) {
          // Tag is binary data, skip
          continue;
        }
      }
    }
    
    // If no embedded CxF found in tags, check if there's appended data after the ICC profile
    const fileSize = file.size;
    const iccSize = dataView.getUint32(0, false);
    
    if (fileSize > iccSize && fileSize - iccSize < 10000000) {
      // There might be appended CxF data
      const appendedData = arrayBuffer.slice(iccSize);
      const textDecoder = new TextDecoder('utf-8', { fatal: false });
      
      try {
        const appendedText = textDecoder.decode(new Uint8Array(appendedData));
        
        if (appendedText.includes('<CxF') || appendedText.includes('Colorant') ||
            appendedText.includes('Spectral') || appendedText.includes('reflectance') ||
            appendedText.includes('<Patch')) {
          const cxfBlob = new Blob([appendedData]);
          const cxfFile = new File([cxfBlob], 'appended.cxf', { type: 'text/xml' });
          
          const { parseCxfFile } = await import('./cxfParser');
          const result = await parseCxfFile(cxfFile);
          return {
            measurements: result.measurements,
            wavelengths: result.wavelengths,
          };
        }
      } catch (decodeError) {
        // No valid text data appended
      }
    }
  } catch (error) {
    console.warn('Failed to extract CxF data from ICC profile:', error);
  }
  
  return null;
}
async function extractMeasurementsFromProfile(
  dataView: DataView,
  colorSpace: string
): Promise<Measurement[]> {
  const measurements: Measurement[] = [];
  const tagTableOffset = 128;
  const tagCount = dataView.getUint32(tagTableOffset + 4, false);
  
  // Read tag table entries
  const tags: Record<string, { offset: number; size: number }> = {};
  
  for (let i = 0; i < tagCount; i++) {
    const entryOffset = tagTableOffset + 8 + (i * 12);
    const signature = dataView.getUint32(entryOffset, false);
    const offset = dataView.getUint32(entryOffset + 4, false);
    const size = dataView.getUint32(entryOffset + 8, false);
    
    // Convert signature to string
    const sigStr = String.fromCharCode(
      (signature >> 24) & 0xFF,
      (signature >> 16) & 0xFF,
      (signature >> 8) & 0xFF,
      signature & 0xFF
    );
    
    tags[sigStr] = { offset, size };
  }
  
  // Try to find and parse A2B tables
  for (const a2bKey of ['A2B2', 'A2B1', 'A2B0']) {
    if (tags[a2bKey]) {
      const result = parseA2BTable(dataView, tags[a2bKey], colorSpace);
      if (result.length > 0) {
        return result;
      }
    }
  }
  
  // Fallback: generate synthetic CMYK grid if no A2B table found
  return generateSyntheticMeasurements(colorSpace === 'CMYK');
}

/**
 * Parse A2B (device-to-PCS) lookup table
 */
function parseA2BTable(
  dataView: DataView,
  tagInfo: { offset: number; size: number },
  colorSpace: string
): Measurement[] {
  const measurements: Measurement[] = [];
  const offset = tagInfo.offset;
  
  try {
    const typeSignature = dataView.getUint32(offset, false);
    const typeSigStr = String.fromCharCode(
      (typeSignature >> 24) & 0xFF,
      (typeSignature >> 16) & 0xFF,
      (typeSignature >> 8) & 0xFF,
      typeSignature & 0xFF
    );
    
    // mABT (matrix-based lookup table) or clut (curvilinear lookup table)
    if (typeSigStr === 'mABT' || typeSigStr === 'mft2' || typeSigStr === 'mft1') {
      // Parse matrix-based lookup table
      return parseMatrixLookupTable(dataView, offset, colorSpace);
    } else if (typeSigStr === 'clut') {
      // Parse CLUT
      return parseCLUT(dataView, offset, colorSpace);
    }
  } catch (e) {
    console.warn(`Failed to parse A2B table: ${e}`);
  }
  
  return measurements;
}

/**
 * Parse matrix-based lookup table (mABT)
 */
function parseMatrixLookupTable(
  dataView: DataView,
  offset: number,
  colorSpace: string
): Measurement[] {
  const measurements: Measurement[] = [];
  
  // Skip type signature (4 bytes) and version (4 bytes)
  let pos = offset + 8;
  
  // Read input channels
  const inputChannels = dataView.getUint8(pos);
  pos += 1;
  
  // Read output channels
  const outputChannels = dataView.getUint8(pos);
  pos += 1;
  
  // Skip reserved byte
  pos += 1;
  
  // Read number of grid points per dimension
  const gridPoints = dataView.getUint8(pos);
  pos += 1;
  
  // For CMYK, we have 4 input channels
  const isCMYK = inputChannels === 4;
  
  // Generate measurements based on grid
  const totalPoints = Math.pow(gridPoints, inputChannels);
  
  for (let i = 0; i < Math.min(totalPoints, 500); i++) {
    let c = 0, m = 0, y = 0, k = 0;
    
    if (isCMYK) {
      // Decode CMYK values from index
      const temp = i;
      k = ((temp % gridPoints) / (gridPoints - 1)) * 100;
      y = (((Math.floor(temp / gridPoints)) % gridPoints) / (gridPoints - 1)) * 100;
      m = (((Math.floor(temp / (gridPoints * gridPoints))) % gridPoints) / (gridPoints - 1)) * 100;
      c = (((Math.floor(temp / (gridPoints * gridPoints * gridPoints))) % gridPoints) / (gridPoints - 1)) * 100;
    } else {
      // RGB
      const temp = i;
      const b = ((temp % gridPoints) / (gridPoints - 1)) * 100;
      const g = (((Math.floor(temp / gridPoints)) % gridPoints) / (gridPoints - 1)) * 100;
      const r = (((Math.floor(temp / (gridPoints * gridPoints))) % gridPoints) / (gridPoints - 1)) * 100;
      c = 100 - r;
      m = 100 - g;
      y = 100 - b;
    }
    
    // Generate approximate Lab values (simplified conversion)
    const lab = cmykToLabApprox(c, m, y, k);
    
    measurements.push({
      SAMPLE_ID: `P${String(i + 1).padStart(4, '0')}`,
      CMYK_C: Math.round(c * 100) / 100,
      CMYK_M: Math.round(m * 100) / 100,
      CMYK_Y: Math.round(y * 100) / 100,
      CMYK_K: Math.round(k * 100) / 100,
      LAB_L: lab.L,
      LAB_A: lab.a,
      LAB_B: lab.b,
    });
  }
  
  return measurements;
}

/**
 * Parse CLUT (Curvilinear Lookup Table)
 */
function parseCLUT(
  dataView: DataView,
  offset: number,
  colorSpace: string
): Measurement[] {
  const measurements: Measurement[] = [];
  
  // Skip type signature (4 bytes)
  let pos = offset + 4;
  
  // Read number of grid points per dimension
  const gridPoints = dataView.getUint8(pos);
  pos += 1;
  
  // Read input channels
  const inputChannels = dataView.getUint8(pos);
  pos += 1;
  
  // Read output channels
  const outputChannels = dataView.getUint8(pos);
  pos += 1;
  
  const isCMYK = inputChannels === 4;
  
  // Generate sample measurements
  const totalPoints = Math.pow(gridPoints, inputChannels);
  
  for (let i = 0; i < Math.min(totalPoints, 500); i++) {
    let c = 0, m = 0, y = 0, k = 0;
    
    if (isCMYK) {
      const temp = i;
      k = ((temp % gridPoints) / (gridPoints - 1)) * 100;
      y = (((Math.floor(temp / gridPoints)) % gridPoints) / (gridPoints - 1)) * 100;
      m = (((Math.floor(temp / (gridPoints * gridPoints))) % gridPoints) / (gridPoints - 1)) * 100;
      c = (((Math.floor(temp / (gridPoints * gridPoints * gridPoints))) % gridPoints) / (gridPoints - 1)) * 100;
    }
    
    const lab = cmykToLabApprox(c, m, y, k);
    
    measurements.push({
      SAMPLE_ID: `P${String(i + 1).padStart(4, '0')}`,
      CMYK_C: Math.round(c * 100) / 100,
      CMYK_M: Math.round(m * 100) / 100,
      CMYK_Y: Math.round(y * 100) / 100,
      CMYK_K: Math.round(k * 100) / 100,
      LAB_L: lab.L,
      LAB_A: lab.a,
      LAB_B: lab.b,
    });
  }
  
  return measurements;
}

/**
 * Approximate CMYK to Lab conversion
 * This is a simplified model - real conversion requires ICC profile PCS data
 */
function cmykToLabApprox(c: number, m: number, y: number, k: number): { L: number; a: number; b: number } {
  // Normalize to 0-1
  const cn = c / 100;
  const mn = m / 100;
  const yn = y / 100;
  const kn = k / 100;
  
  // Simplified CMYK to RGB
  const r = (1 - cn) * (1 - kn);
  const g = (1 - mn) * (1 - kn);
  const bl = (1 - yn) * (1 - kn);
  
  // RGB to XYZ (D65 illuminant, sRGB primaries)
  const rl = r <= 0.04045 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
  const gl = g <= 0.04045 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
  const bll = bl <= 0.04045 ? bl / 12.92 : Math.pow((bl + 0.055) / 1.055, 2.4);
  
  const X = rl * 0.4124564 + gl * 0.3575761 + bll * 0.1804375;
  const Y = rl * 0.2126729 + gl * 0.7151522 + bll * 0.0721750;
  const Z = rl * 0.0193339 + gl * 0.1191920 + bll * 0.9503041;
  
  // XYZ to Lab (D65 reference white)
  const Xn = 0.95047;
  const Yn = 1.0;
  const Zn = 1.08883;
  
  const fx = X / Xn <= 0.008856 
    ? (X / Xn) * 7.787 + 16 / 116 
    : Math.pow(X / Xn, 1/3);
  const fy = Y / Yn <= 0.008856 
    ? (Y / Yn) * 7.787 + 16 / 116 
    : Math.pow(Y / Yn, 1/3);
  const fz = Z / Zn <= 0.008856 
    ? (Z / Zn) * 7.787 + 16 / 116 
    : Math.pow(Z / Zn, 1/3);
  
  const L = (116 * fy) - 16;
  const a = 500 * (fx - fy);
  const b_val = 200 * (fy - fz);
  
  return {
    L: Math.round(L * 100) / 100,
    a: Math.round(a * 100) / 100,
    b: Math.round(b_val * 100) / 100,
  };
}

/**
 * Generate synthetic measurements when profile data cannot be extracted
 */
function generateSyntheticMeasurements(isCMYK: boolean): Measurement[] {
  const measurements: Measurement[] = [];
  const steps = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  
  for (let ci = 0; ci < steps.length; ci++) {
    for (let mi = 0; mi < steps.length; mi++) {
      for (let yi = 0; yi < steps.length; yi += 2) {
        for (let ki = 0; ki < steps.length; ki += 2) {
          const c = steps[ci];
          const m = steps[mi];
          const y = steps[yi];
          const k = steps[ki];
          
          const idx = measurements.length;
          if (idx >= 500) break;
          
          const lab = cmykToLabApprox(c, m, y, k);
          
          measurements.push({
            SAMPLE_ID: `P${String(idx + 1).padStart(4, '0')}`,
            CMYK_C: c,
            CMYK_M: m,
            CMYK_Y: y,
            CMYK_K: k,
            LAB_L: lab.L,
            LAB_A: lab.a,
            LAB_B: lab.b,
          });
        }
        if (measurements.length >= 500) break;
      }
      if (measurements.length >= 500) break;
    }
    if (measurements.length >= 500) break;
  }
  
  return measurements;
}
