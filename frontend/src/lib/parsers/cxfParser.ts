// src/lib/parsers/cxfParser.ts
import { Measurement } from '../../types';

// CIE 1931 2° standard observer CMFs at 10nm intervals, 380–730nm (36 values)
const CMF_X = [
  0.001368, 0.004243, 0.014310, 0.043510, 0.134380, 0.283900, 0.348280, 0.336200, 0.290800,
  0.195360, 0.095640, 0.032010, 0.004900, 0.009300, 0.063270, 0.165500, 0.290400, 0.433450,
  0.594500, 0.762100, 0.916300, 1.026300, 1.062200, 1.045600, 0.971600, 0.854450, 0.708600,
  0.574200, 0.415400, 0.302400, 0.218000, 0.143700, 0.095800, 0.063700, 0.041900, 0.028700,
];
const CMF_Y = [
  0.000039, 0.000120, 0.000396, 0.001210, 0.004000, 0.011600, 0.023000, 0.038000, 0.060000,
  0.090980, 0.139020, 0.208020, 0.323000, 0.503000, 0.710000, 0.862000, 0.954000, 0.994950,
  0.995000, 0.952000, 0.870000, 0.757000, 0.631000, 0.503000, 0.381000, 0.265000, 0.175000,
  0.107000, 0.061000, 0.032000, 0.017000, 0.008210, 0.004102, 0.002091, 0.001047, 0.000520,
];
const CMF_Z = [
  0.006450, 0.020050, 0.067850, 0.207400, 0.645600, 1.385600, 1.747060, 1.772110, 1.669200,
  1.287640, 0.812950, 0.465180, 0.272000, 0.158200, 0.078250, 0.042160, 0.020300, 0.008750,
  0.003900, 0.002100, 0.001650, 0.001100, 0.000800, 0.000340, 0.000190, 0.000050, 0.000020,
  0.000050, 0.000030, 0.000050, 0.000010, 0.000000, 0.000000, 0.000000, 0.000000, 0.000000,
];
// D50 illuminant SPD at 10nm intervals, 380–730nm (CIE S 014-2)
const D50 = [
  23.942, 28.022, 31.493, 38.031, 43.207, 52.088, 64.458, 67.989, 76.221, 84.854,
  92.023, 97.420, 99.858, 100.000, 97.997, 97.478, 97.746, 97.278, 97.783, 95.756,
  97.434, 96.785, 97.010, 95.785, 95.694, 95.688, 92.949, 89.937, 88.200, 87.244,
  84.374, 82.831, 80.019, 80.460, 79.174, 79.048,
];
// D50 white point for ICC PCS
const D50_Xn = 96.422;
const D50_Yn = 100.000;
const D50_Zn = 82.521;

function labF(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

/**
 * Convert reflectance spectrum to CIE Lab under D50/2° using standard integration.
 * @param reflectance values 0–1 at 10nm step starting at startWL
 * @param startWL start wavelength (default 380)
 */
function spectraToLab(
  reflectance: number[],
  startWL = 380,
): { L: number; a: number; b: number } {
  // Map CMF index to reflectance index based on wavelength alignment
  const cmfStartWL = 380;
  let X = 0, Y = 0, Z = 0, k = 0;

  for (let ci = 0; ci < 36; ci++) {
    const wl = cmfStartWL + ci * 10;
    const ri = (wl - startWL) / 10;
    if (ri < 0 || ri >= reflectance.length) continue;
    const R = reflectance[ri];
    const d50 = D50[ci];
    X += R * d50 * CMF_X[ci];
    Y += R * d50 * CMF_Y[ci];
    Z += R * d50 * CMF_Z[ci];
    k += d50 * CMF_Y[ci];
  }

  const scale = 100 / k;
  const Xr = (X * scale) / D50_Xn;
  const Yr = (Y * scale) / D50_Yn;
  const Zr = (Z * scale) / D50_Zn;

  const L = Math.round((116 * labF(Yr) - 16) * 100) / 100;
  const a = Math.round(500 * (labF(Xr) - labF(Yr)) * 100) / 100;
  const b = Math.round(200 * (labF(Yr) - labF(Zr)) * 100) / 100;

  return { L, a, b };
}

/**
 * Parse CxF3 XML (cc: namespace, X-Rite/i1Profiler format).
 * Handles both standalone .cxf files and strings extracted from ICC ZXML tags.
 */
/** Extract Row, Column, Page, SampleID from cc:TagCollection children. */
function extractLocation(obj: Element): { row: number; col: number; page: number; sampleId: string } {
  const tagEls = obj.getElementsByTagNameNS('*', 'Tag');
  let row = -1, col = -1, page = 1;
  let sampleId = obj.getAttribute('Id') ?? '';

  for (let t = 0; t < tagEls.length; t++) {
    const name = tagEls[t].getAttribute('Name');
    const value = tagEls[t].getAttribute('Value') ?? '';
    if (name === 'Row') row = parseInt(value, 10);
    else if (name === 'Column') col = parseInt(value, 10);
    else if (name === 'Page') page = parseInt(value, 10);
    else if (name === 'SampleID' && value && value !== '-1') sampleId = value;
  }

  if (!sampleId || sampleId === '-1') {
    sampleId = row >= 0 && col >= 0 ? `R${row}C${col}P${page}` : '';
  }

  return { row, col, page, sampleId };
}

export function parseCxf3Xml(xmlText: string): CxfParseResult {
  // Strip trailing null bytes (X-Rite/i1Profiler files sometimes include padding)
  const cleanedText = xmlText.replace(/\0+$/, '');
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(cleanedText, 'text/xml');

  const parseError = xmlDoc.querySelector('parsererror');
  if (parseError) {
    return { measurements: [], hasSpectral: false, patchCount: 0 };
  }

  const allObjects = xmlDoc.getElementsByTagNameNS('*', 'Object');

  // ── Pass 1: collect Target objects → RGB device values by position key ──
  const rgbByKey = new Map<string, { r: number; g: number; b: number }>();

  for (let i = 0; i < allObjects.length; i++) {
    const obj = allObjects[i];
    if (obj.getAttribute('ObjectType') !== 'Target') continue;

    const { row, col, page } = extractLocation(obj);
    const key = `${row}:${col}:${page}`;

    const rEl = obj.getElementsByTagNameNS('*', 'R')[0];
    const gEl = obj.getElementsByTagNameNS('*', 'G')[0];
    const bEl = obj.getElementsByTagNameNS('*', 'B')[0];

    if (rEl && gEl && bEl) {
      rgbByKey.set(key, {
        r: parseInt(rEl.textContent ?? '0', 10),
        g: parseInt(gEl.textContent ?? '0', 10),
        b: parseInt(bEl.textContent ?? '0', 10),
      });
    }
  }

  // ── Pass 2: collect Measurement objects, prefer M0 over M2 ──
  const m0Objects: Element[] = [];
  const m2Objects: Element[] = [];

  for (let i = 0; i < allObjects.length; i++) {
    const obj = allObjects[i];
    const type = obj.getAttribute('ObjectType') ?? '';
    if (type === 'M0_Measurement') m0Objects.push(obj);
    else if (type.includes('Measurement')) m2Objects.push(obj);
  }

  const measureObjects = m0Objects.length > 0 ? m0Objects : m2Objects;

  const measurements: Measurement[] = [];
  let sharedWavelengths: number[] | undefined;

  for (let i = 0; i < measureObjects.length; i++) {
    const obj = measureObjects[i];

    const spectrumEls = obj.getElementsByTagNameNS('*', 'ReflectanceSpectrum');
    if (spectrumEls.length === 0) continue;

    const spectrumEl = spectrumEls[0];
    const startWL = parseInt(spectrumEl.getAttribute('StartWL') ?? '380', 10);
    const spectraText = spectrumEl.textContent?.trim() ?? '';
    const spectra = spectraText.split(/\s+/).map(Number).filter((v) => !isNaN(v));

    if (spectra.length === 0) continue;

    const wavelengths = spectra.map((_, j) => startWL + j * 10);
    if (!sharedWavelengths) sharedWavelengths = wavelengths;

    const { row, col, page, sampleId } = extractLocation(obj);
    const posKey = `${row}:${col}:${page}`;
    const rgb = rgbByKey.get(posKey);

    const lab = spectraToLab(spectra, startWL);
    const id = sampleId || `P${String(i + 1).padStart(4, '0')}`;

    measurements.push({
      SAMPLE_ID: id,
      CMYK_C: 0,
      CMYK_M: 0,
      CMYK_Y: 0,
      CMYK_K: 0,
      RGB_R: rgb?.r,
      RGB_G: rgb?.g,
      RGB_B: rgb?.b,
      LAB_L: lab.L,
      LAB_A: lab.a,
      LAB_B: lab.b,
      spectra,
      wavelengths,
    });
  }

  return {
    measurements,
    hasSpectral: measurements.length > 0,
    wavelengths: sharedWavelengths,
    patchCount: measurements.length,
  };
}

/**
 * Parser for CxF (Color Exchange Format) files
 * 
 * CxF is an XML-based format for exchanging color data between applications.
 * This parser extracts spectral and colorimetric measurements from CxF files.
 */

export interface CxfParseResult {
  measurements: Measurement[];
  hasSpectral: boolean;
  wavelengths?: number[];
  patchCount: number;
}

/**
 * Parse CxF file and extract measurement data.
 * Tries CxF3 (cc: namespace, X-Rite/i1Profiler) first, falls back to generic XML.
 */
export async function parseCxfFile(file: File): Promise<CxfParseResult> {
  const text = await file.text();

  // Detect CxF3 format (cc: namespace from X-Rite/i1Profiler)
  if (text.includes('colorexchangeformat.com') || text.includes('cc:CxF')) {
    return parseCxf3Xml(text);
  }

  // Legacy generic XML format (Patch/Sample/Colorant attribute-based)
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(text, 'text/xml');

  const parseError = xmlDoc.querySelector('parsererror');
  if (parseError) {
    throw new Error('Invalid CxF XML format');
  }

  const measurements = extractMeasurementsFromCxf(xmlDoc);
  const spectralData = extractSpectralData(xmlDoc);

  return {
    measurements,
    hasSpectral: spectralData.wavelengths.length > 0,
    wavelengths: spectralData.wavelengths.length > 0 ? spectralData.wavelengths : undefined,
    patchCount: measurements.length,
  };
}

/**
 * Extract measurements from CxF XML document
 */
function extractMeasurementsFromCxf(xmlDoc: Document): Measurement[] {
  const measurements: Measurement[] = [];
  
  // CxF typically uses CxF/X elements
  const colorantElements = xmlDoc.getElementsByTagNameNS('*', 'Colorant');
  const sampleElements = xmlDoc.getElementsByTagNameNS('*', 'Sample');
  const patchElements = xmlDoc.getElementsByTagNameNS('*', 'Patch');
  
  // Try different element types
  let elementsToProcess: Element[] = [];
  
  if (patchElements.length > 0) {
    elementsToProcess = Array.from(patchElements);
  } else if (sampleElements.length > 0) {
    elementsToProcess = Array.from(sampleElements);
  } else if (colorantElements.length > 0) {
    elementsToProcess = Array.from(colorantElements);
  } else {
    // Fallback: look for any elements with CMYK or Lab data
    const allElements = xmlDoc.querySelectorAll('*');
    elementsToProcess = Array.from(allElements).filter(el => {
      const attrs = el.attributes;
      for (let i = 0; i < attrs.length; i++) {
        const name = attrs[i].name.toUpperCase();
        if (name.includes('CMYK') || name.includes('LAB') || name.includes('LCH')) {
          return true;
        }
      }
      return false;
    });
  }
  
  elementsToProcess.forEach((element, index) => {
    const measurement = parseMeasurementElement(element, index);
    if (measurement) {
      measurements.push(measurement);
    }
  });
  
  // If no measurements found, try to find spectral data directly
  if (measurements.length === 0) {
    const spectralElements = xmlDoc.querySelectorAll('[*|reflectance], [reflectance]');
    spectralElements.forEach((element, index) => {
      const measurement = parseSpectralElement(element, index);
      if (measurement) {
        measurements.push(measurement);
      }
    });
  }
  
  return measurements;
}

/**
 * Parse a measurement element (Patch/Sample/Colorant)
 */
function parseMeasurementElement(element: Element, index: number): Measurement | null {
  // Extract SAMPLE_ID
  const sampleId = element.getAttribute('id') || 
                  element.getAttribute('name') || 
                  element.getAttribute('SAMPLE_ID') ||
                  `P${String(index + 1).padStart(4, '0')}`;
  
  // Extract CMYK values
  let c = parseFloat(element.getAttribute('C')?.toString() || 
                     element.getAttribute('CMYK_C')?.toString() || 
                     element.getAttribute('Cyan')?.toString() || '0');
  let m = parseFloat(element.getAttribute('M')?.toString() || 
                     element.getAttribute('CMYK_M')?.toString() || 
                     element.getAttribute('Magenta')?.toString() || '0');
  let y = parseFloat(element.getAttribute('Y')?.toString() || 
                     element.getAttribute('CMYK_Y')?.toString() || 
                     element.getAttribute('Yellow')?.toString() || '0');
  let k = parseFloat(element.getAttribute('K')?.toString() || 
                     element.getAttribute('CMYK_K')?.toString() || 
                     element.getAttribute('Black')?.toString() || '0');
  
  // Handle percentage values (0-100 vs 0-1)
  if (c <= 1 && m <= 1 && y <= 1 && k <= 1) {
    // Values are in 0-1 range, convert to percentage
    // But check if they're very small (already normalized)
    if (Math.max(c, m, y, k) < 0.1) {
      // Likely already normalized, keep as is but scale to 0-100
      c *= 100;
      m *= 100;
      y *= 100;
      k *= 100;
    }
  }
  
  // Extract Lab values
  let l = parseFloat(element.getAttribute('L')?.toString() || 
                     element.getAttribute('LAB_L')?.toString() || 
                     element.getAttribute('LStar')?.toString() || '0');
  let a = parseFloat(element.getAttribute('a')?.toString() || 
                     element.getAttribute('LAB_A')?.toString() || 
                     element.getAttribute('AStar')?.toString() || '0');
  let b = parseFloat(element.getAttribute('b')?.toString() || 
                     element.getAttribute('LAB_B')?.toString() || 
                     element.getAttribute('BStar')?.toString() || '0');
  
  // Check child elements for nested data
  const labElement = element.querySelector(':scope > Lab, :scope > CIELAB, :scope > Colorimetric');
  if (labElement) {
    l = parseFloat(labElement.getAttribute('L')?.toString() || l.toString());
    a = parseFloat(labElement.getAttribute('a')?.toString() || a.toString());
    b = parseFloat(labElement.getAttribute('b')?.toString() || b.toString());
  }
  
  const cmykElement = element.querySelector(':scope > CMYK, :scope > ProcessColor');
  if (cmykElement) {
    c = parseFloat(cmykElement.getAttribute('C')?.toString() || c.toString());
    m = parseFloat(cmykElement.getAttribute('M')?.toString() || m.toString());
    y = parseFloat(cmykElement.getAttribute('Y')?.toString() || y.toString());
    k = parseFloat(cmykElement.getAttribute('K')?.toString() || k.toString());
  }
  
  // Validate that we have at least some data
  if (l === 0 && a === 0 && b === 0 && c === 0 && m === 0 && y === 0 && k === 0) {
    // Check if there's any meaningful data
    const hasData = Array.from(element.attributes).some(attr => {
      const val = parseFloat(attr.value);
      return !isNaN(val) && val !== 0;
    });
    
    if (!hasData) {
      return null;
    }
  }
  
  return {
    SAMPLE_ID: sampleId,
    CMYK_C: Math.round(c * 100) / 100,
    CMYK_M: Math.round(m * 100) / 100,
    CMYK_Y: Math.round(y * 100) / 100,
    CMYK_K: Math.round(k * 100) / 100,
    LAB_L: Math.round(l * 100) / 100,
    LAB_A: Math.round(a * 100) / 100,
    LAB_B: Math.round(b * 100) / 100,
  };
}

/**
 * Parse spectral data element
 */
function parseSpectralElement(element: Element, index: number): Measurement | null {
  const reflectance = element.getAttribute('reflectance');
  if (!reflectance) return null;
  
  // Parse comma or space-separated values
  const values = reflectance.split(/[,\s]+/).map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
  
  if (values.length === 0) return null;
  
  // Create basic measurement with spectral data
  return {
    SAMPLE_ID: element.getAttribute('id') || `P${String(index + 1).padStart(4, '0')}`,
    CMYK_C: 0,
    CMYK_M: 0,
    CMYK_Y: 0,
    CMYK_K: 0,
    LAB_L: 50, // Default value
    LAB_A: 0,
    LAB_B: 0,
    spectra: values,
    wavelengths: values.map((_, i) => 380 + i * 10),
  };
}

/**
 * Extract spectral data from CxF document
 */
function extractSpectralData(xmlDoc: Document): { wavelengths: number[]; spectra: number[][] } {
  const wavelengths: number[] = [];
  const spectra: number[][] = [];
  
  // Look for Spectral elements
  const spectralElements = xmlDoc.querySelectorAll('[*|wavelengths], [wavelengths], [*|Spectrum], [Spectrum]');
  
  spectralElements.forEach(el => {
    const wlAttr = el.getAttribute('wavelengths');
    if (wlAttr) {
      const wls = wlAttr.split(/[,\s]+/).map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
      if (wls.length > wavelengths.length) {
        wavelengths.splice(0, wavelengths.length, ...wls);
      }
    }
    
    const spectrumAttr = el.getAttribute('spectrum') || el.getAttribute('reflectance');
    if (spectrumAttr) {
      const spec = spectrumAttr.split(/[,\s]+/).map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
      if (spec.length > 0) {
        spectra.push(spec);
      }
    }
  });
  
  // If no explicit wavelengths, use standard range
  if (wavelengths.length === 0 && spectra.length > 0) {
    const firstSpectrum = spectra[0];
    for (let i = 0; i < firstSpectrum.length; i++) {
      wavelengths.push(380 + i * 10);
    }
  }
  
  return { wavelengths, spectra };
}
