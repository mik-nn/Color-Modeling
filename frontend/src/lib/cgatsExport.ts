// CGATS export for Neugebauer primary ramps
//
// Convention: RGB = device signal (255 = paper / no ink, 0 = maximum ink)
// Neugebauer primaries: 8 cube corners (W,C,M,Y,R,G,B,K)
//   W = (255,255,255)   C = (0,255,255)   M = (255,0,255)   Y = (255,255,0)
//   R = (255,0,0)       G = (0,255,0)     B = (0,0,255)     K = (0,0,0)
//
// A patch belongs to a Neugebauer primary ramp iff at least one channel equals
// exactly 255.  No tolerance — only values that exist in the data.
//
// The 6 ramp families (user-specified):
//   (R,255,255)  cyan ramp:    G=255, B=255, R varies  [W→C edge]
//   (255,G,255)  magenta ramp: R=255, B=255, G varies  [W→M edge]
//   (255,255,B)  yellow ramp:  R=255, G=255, B varies  [W→Y edge]
//   (255,G,B)    red face:     R=255, G and B free
//   (R,255,B)    green face:   G=255, R and B free
//   (R,G,255)    blue face:    B=255, R and G free

import { Measurement, ProfileData } from '../types';

// ─── Sort helpers ─────────────────────────────────────────────────────────────

// Bit mask of which channels are exactly 255: R=4, G=2, B=1
function mask255(r: number, g: number, b: number): number {
  return (r === 255 ? 4 : 0) | (g === 255 ? 2 : 0) | (b === 255 ? 1 : 0);
}

// Sort key: ramp edges first (mask=6,5,3), then faces (mask=4,2,1), then W (mask=7)
// Within group: ascending by the non-255 channel values (paper→ink direction)
const GROUP_ORDER: Record<number, number> = { 6: 0, 5: 1, 3: 2, 4: 3, 2: 4, 1: 5, 7: 6, 0: 7 };

function sortKey(m: Measurement): [number, number, number, number] {
  const r = m.RGB_R!, g = m.RGB_G!, b = m.RGB_B!;
  const mk = mask255(r, g, b);
  const group = GROUP_ORDER[mk] ?? 7;
  // Within group, sort by the sum of varying (non-255) channels ascending (paper→ink)
  const varySum = (r === 255 ? 0 : r) + (g === 255 ? 0 : g) + (b === 255 ? 0 : b);
  // Secondary: individual channels for stable order
  const varySec = (r === 255 ? 0 : r) * 65536 + (g === 255 ? 0 : g) * 256 + (b === 255 ? 0 : b);
  return [group, varySum, varySec, 0];
}

// ─── Filter ───────────────────────────────────────────────────────────────────

export function filterNeugebauerPrimaries(measurements: Measurement[]): Measurement[] {
  return measurements.filter(m => {
    const r = m.RGB_R, g = m.RGB_G, b = m.RGB_B;
    if (r === undefined || g === undefined || b === undefined) return false;
    // CMY ramps: two channels exactly 255, one varies
    // RGB ramps: one channel exactly 255, other two exactly equal
    return (g === 255 && b === 255) ||   // C ramp
           (r === 255 && b === 255) ||   // M ramp
           (r === 255 && g === 255) ||   // Y ramp
           (r === 255 && g === b)  ||   // R ramp
           (g === 255 && r === b)  ||   // G ramp
           (b === 255 && r === g);      // B ramp
  });
}

// ─── CGATS builder ────────────────────────────────────────────────────────────

export function buildCGATS(measurements: Measurement[], profile: ProfileData): string {
  const wls = profile.wavelengths ?? Array.from({ length: 36 }, (_, i) => 380 + i * 10);
  const hasSpectra = measurements.some(m => m.spectra && m.spectra.length > 0);

  const sorted = [...measurements].sort((a, b) => {
    const ka = sortKey(a), kb = sortKey(b);
    for (let i = 0; i < 3; i++) {
      if (ka[i] !== kb[i]) return ka[i] - kb[i];
    }
    return 0;
  });

  const fields = ['SAMPLE_ID', 'RGB_R', 'RGB_G', 'RGB_B', 'LAB_L', 'LAB_A', 'LAB_B'];
  if (hasSpectra) wls.forEach(wl => fields.push(`SPECTRAL_NM_${wl}`));

  const header = [
    'CGATS.17',
    `ORIGINATOR\t"Color-ModelingETL"`,
    `DESCRIPTOR\t"Neugebauer primaries - ${profile.metadata.substrate}"`,
    `CREATED\t"${new Date().toISOString().slice(0, 10)}"`,
    `NUMBER_OF_FIELDS\t${fields.length}`,
    'BEGIN_DATA_FORMAT',
    fields.join('\t'),
    'END_DATA_FORMAT',
    `NUMBER_OF_SETS\t${sorted.length}`,
    'BEGIN_DATA',
  ];

  const rows = sorted.map(m => {
    const row: (string | number)[] = [
      m.SAMPLE_ID,
      m.RGB_R!,
      m.RGB_G!,
      m.RGB_B!,
      m.LAB_L.toFixed(4),
      m.LAB_A.toFixed(4),
      m.LAB_B.toFixed(4),
    ];
    if (hasSpectra) {
      if (m.spectra) {
        // 0–1 reflectance → 0–100 % per CGATS convention
        m.spectra.forEach(v => row.push((v * 100).toFixed(4)));
      } else {
        wls.forEach(() => row.push(''));
      }
    }
    return row.join('\t');
  });

  return [...header, ...rows, 'END_DATA'].join('\n');
}

// ─── Download ─────────────────────────────────────────────────────────────────

export function downloadCGATS(cgats: string, filename: string): void {
  const blob = new Blob([cgats], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
