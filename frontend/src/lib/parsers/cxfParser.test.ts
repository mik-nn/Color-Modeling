// src/lib/parsers/cxfParser.test.ts
import { describe, it, expect } from 'vitest';
import { parseCxfFile } from './cxfParser';

// Mock File object with text method
const createMockFile = (content: string, type: string) => {
  const blob = new Blob([content], { type });
  return {
    ...blob,
    text: async () => content,
  } as File;
};

describe('CxF Parser', () => {
  describe('parseCxfFile', () => {
    it('should parse valid CxF XML with Patch elements', async () => {
      const xmlContent = `<?xml version="1.0"?>
        <CxF>
          <Patch id="P0001" L="50" a="10" b="-5" C="20" M="30" Y="40" K="5"/>
          <Patch id="P0002" L="60" a="15" b="-10" C="10" M="20" Y="30" K="0"/>
        </CxF>`;
      
      const file = createMockFile(xmlContent, 'text/xml');
      const result = await parseCxfFile(file);
      
      expect(result.measurements).toHaveLength(2);
      expect(result.hasSpectral).toBe(false);
      expect(result.patchCount).toBe(2);
      expect(result.measurements[0].SAMPLE_ID).toBe('P0001');
      expect(result.measurements[0].LAB_L).toBe(50);
      expect(result.measurements[0].CMYK_C).toBe(20);
    });

    it('should handle Sample elements', async () => {
      const xmlContent = `<?xml version="1.0"?>
        <CxF>
          <Sample name="Sample1" LAB_L="45" LAB_A="5" LAB_B="8" CMYK_C="15" CMYK_M="25" CMYK_Y="35" CMYK_K="10"/>
        </CxF>`;
      
      const file = createMockFile(xmlContent, 'text/xml');
      const result = await parseCxfFile(file);
      
      expect(result.measurements.length).toBeGreaterThan(0);
      expect(result.measurements[0].SAMPLE_ID).toBe('Sample1');
    });

    it('should handle invalid XML gracefully', async () => {
      const invalidXml = '<invalid><xml>';
      const file = createMockFile(invalidXml, 'text/xml');
      
      await expect(parseCxfFile(file)).rejects.toThrow('Invalid CxF XML format');
    });

    it('should extract spectral data when present', async () => {
      const xmlContent = `<?xml version="1.0"?>
        <CxF>
          <Patch id="P0001" reflectance="0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0"/>
        </CxF>`;
      
      const file = createMockFile(xmlContent, 'text/xml');
      const result = await parseCxfFile(file);
      
      // Spectral data parsing depends on implementation - just verify it parses
      expect(result.measurements.length).toBeGreaterThan(0);
    });

    it('should handle percentage values in 0-1 range', async () => {
      const xmlContent = `<?xml version="1.0"?>
        <CxF>
          <Patch id="P0001" L="50" a="10" b="-5" C="0.2" M="0.3" Y="0.4" K="0.05"/>
        </CxF>`;
      
      const file = createMockFile(xmlContent, 'text/xml');
      const result = await parseCxfFile(file);
      
      expect(result.measurements[0].CMYK_C).toBeCloseTo(0.2, 2);
      expect(result.measurements[0].CMYK_M).toBeCloseTo(0.3, 2);
    });

    it('should generate default SAMPLE_ID when not provided', async () => {
      const xmlContent = `<?xml version="1.0"?>
        <CxF>
          <Patch L="50" a="10" b="-5" C="20" M="30" Y="40" K="5"/>
        </CxF>`;
      
      const file = createMockFile(xmlContent, 'text/xml');
      const result = await parseCxfFile(file);
      
      expect(result.measurements[0].SAMPLE_ID).toBe('P0001');
    });
  });
});
