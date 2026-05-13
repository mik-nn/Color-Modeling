import { describe, it, expect } from 'vitest';
import { parseCxfFile } from '../lib/parsers/cxfParser';

describe('Debug CXF', () => {
  it('should debug spectral data parsing', async () => {
    const xmlContent = `<?xml version="1.0"?>
      <CxF>
        <Patch id="P0001" reflectance="10,20,30,40,50,60,70,80,90,100"/>
      </CxF>`;
    
    const file = new Blob([xmlContent], { type: 'text/xml' });
    const result = await parseCxfFile(file as File);
    
    console.log('Full result:', JSON.stringify(result, null, 2));
    console.log('Measurements count:', result.measurements.length);
    if (result.measurements.length > 0) {
      console.log('First measurement:', JSON.stringify(result.measurements[0], null, 2));
    }
    
    expect(result.measurements.length).toBeGreaterThan(0);
  });
});
