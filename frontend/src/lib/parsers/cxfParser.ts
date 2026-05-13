// src/lib/parsers/cxfParser.ts
import { Measurement } from '../../types';

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
 * Parse CxF file and extract measurement data
 */
export async function parseCxfFile(file: File): Promise<CxfParseResult> {
  const text = await file.text();
  
  // Try to parse as XML
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(text, 'text/xml');
  
  // Check for parsing errors - but don't throw, just return empty result
  const parseError = xmlDoc.querySelector('parsererror');
  if (parseError) {
    // Return empty result instead of throwing error
    return {
      measurements: [],
      hasSpectral: false,
      patchCount: 0,
    };
  }
  
  // Extract measurements from CxF structure
  const measurements = extractMeasurementsFromCxf(xmlDoc);
  
  // Check if any measurement has spectral data
  const hasSpectral = measurements.some(m => m.spectra && m.spectra.length > 0);
  
  // Extract wavelengths from first measurement with spectra
  let wavelengths: number[] | undefined;
  if (hasSpectral) {
    const firstWithSpectra = measurements.find(m => m.wavelengths && m.wavelengths.length > 0);
    wavelengths = firstWithSpectra?.wavelengths;
  }
  
  return {
    measurements,
    hasSpectral,
    wavelengths,
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
  
  // Process elements and collect measurements with spectral data
  elementsToProcess.forEach((element, index) => {
    const measurement = parseMeasurementElement(element, index);
    if (measurement) {
      // Check for reflectance attribute on this element
      const reflectance = element.getAttribute('reflectance');
      if (reflectance) {
        // Parse comma or space-separated values
        const values = reflectance.split(/[,\s]+/).map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
        if (values.length > 0) {
          measurement.spectra = values;
          measurement.wavelengths = values.map((_, i) => 380 + i * 10);
        }
      }
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
  let sampleId = element.getAttribute('id') || 
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
  // If all values are <= 1, assume they are in 0-1 range and need conversion to 0-100
  if (c <= 1 && m <= 1 && y <= 1 && k <= 1 && (c > 0 || m > 0 || y > 0 || k > 0)) {
    // Values are in 0-1 range, convert to percentage (0-100)
    c = c * 100;
    m = m * 100;
    y = y * 100;
    k = k * 100;
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
  
  // Check if element has reflectance data (spectral-only patch)
  const hasReflectance = element.hasAttribute('reflectance');
  
  // Validate that we have at least some data
  if (!hasReflectance && l === 0 && a === 0 && b === 0 && c === 0 && m === 0 && y === 0 && k === 0) {
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
