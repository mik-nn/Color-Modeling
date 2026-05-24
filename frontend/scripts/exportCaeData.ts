// frontend/scripts/exportCaeData.ts
//
// One-shot TS → JSON exporter for the Python CAE training pipeline.
//
// Reads all P9000 ICM profiles from the local sample directory, filters
// to MK (matte-black) variants, parses each via the existing TS pipeline
// (iccTagScanner → cxfParser → ICM extractor), and writes a single
// profiles-mk.json file consumed by python/cae/dataset.py.
//
// Run: cd frontend && npx tsx scripts/exportCaeData.ts
//
// The output file is large (~10 MB) and gitignored. Re-run whenever you
// load a new MK substrate into the sample directory.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

// jsdom polyfill — cxfParser uses DOMParser which only exists in browsers.
const jsdom = new JSDOM('<!doctype html><html><body></body></html>');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).DOMParser = jsdom.window.DOMParser;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).XMLSerializer = jsdom.window.XMLSerializer;

import { parseIcmFile } from '../src/lib/parsers/icmParser';

const SAMPLE_DIR = '/mnt/e/PET/LinkedInPosts/surecolor-p9000/';
const OUT_DIR = path.resolve(process.cwd(), 'data/cae-input');
const OUT_FILE = path.join(OUT_DIR, 'profiles-mk.json');

interface ExportedPatch {
  sample_id: string;
  rgb: [number, number, number];
  spectrum: number[]; // length 36, 380..730 nm @ 10 nm
}

interface ExportedProfile {
  full_name: string;
  substrate: string;
  ink_mode: 'mk' | 'pk' | 'unknown';
  paper_idx: number;          // row index of paper anchor (RGB = 255,255,255)
  paper_spectrum: number[];   // length 36
  patches: ExportedPatch[];
  wavelength_start_nm: number;
  wavelength_step_nm: number;
}

function inkMode(filename: string): 'mk' | 'pk' | 'unknown' {
  if (/_mk_|_MK_/i.test(filename)) return 'mk';
  if (/_pk_|_PK_/i.test(filename)) return 'pk';
  return 'unknown';
}

function substrate(filename: string): string {
  const base = filename.replace(/^.*\//, '').replace(/\.icm$/i, '');
  // BC_<series>_P9000_<mk|pk>_<substrate>
  const parts = base.split('_');
  return parts[parts.length - 1] || 'unknown';
}

function profileLabel(filename: string): string {
  return filename.replace(/^.*\//, '').replace(/\.icm$/i, '');
}

async function exportProfile(filePath: string): Promise<ExportedProfile | null> {
  const buf = await fs.readFile(filePath);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  // Construct a minimal File-like object that parseIcmFile accepts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeFile = { arrayBuffer: async () => arrayBuffer } as any;
  const result = await parseIcmFile(fakeFile);
  if (!result.hasSpectral) {
    console.warn(`[skip] ${filePath} — no spectral data`);
    return null;
  }

  // Find paper anchor (RGB exactly 255,255,255 with spectrum).
  const paperIdx = result.measurements.findIndex(
    m => m.RGB_R === 255 && m.RGB_G === 255 && m.RGB_B === 255 && m.spectra,
  );
  if (paperIdx < 0) {
    console.warn(`[skip] ${filePath} — no paper anchor (255,255,255 with spectrum)`);
    return null;
  }
  const paperSpec = result.measurements[paperIdx].spectra!;
  const startWL = result.measurements[paperIdx].wavelengths?.[0] ?? 380;
  const step = result.measurements[paperIdx].wavelengths
    ? result.measurements[paperIdx].wavelengths![1] - result.measurements[paperIdx].wavelengths![0]
    : 10;

  const patches: ExportedPatch[] = [];
  for (const m of result.measurements) {
    if (!m.spectra) continue;
    if (m.RGB_R === undefined || m.RGB_G === undefined || m.RGB_B === undefined) continue;
    if (m.spectra.length !== paperSpec.length) continue;
    patches.push({
      sample_id: m.SAMPLE_ID,
      rgb: [m.RGB_R, m.RGB_G, m.RGB_B],
      spectrum: m.spectra,
    });
  }

  const filename = path.basename(filePath);
  return {
    full_name: profileLabel(filename),
    substrate: substrate(filename),
    ink_mode: inkMode(filename),
    paper_idx: patches.findIndex(p => p.rgb[0] === 255 && p.rgb[1] === 255 && p.rgb[2] === 255),
    paper_spectrum: paperSpec,
    patches,
    wavelength_start_nm: startWL,
    wavelength_step_nm: step,
  };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const all = await fs.readdir(SAMPLE_DIR);
  const icms = all
    .filter(f => f.toLowerCase().endsWith('.icm'))
    .map(f => path.join(SAMPLE_DIR, f))
    .sort();

  console.log(`Found ${icms.length} ICM files in ${SAMPLE_DIR}`);

  const mkProfiles: ExportedProfile[] = [];
  for (const fp of icms) {
    const mode = inkMode(fp);
    if (mode !== 'mk') continue;
    console.log(`Parsing ${path.basename(fp)}`);
    try {
      const exported = await exportProfile(fp);
      if (exported) mkProfiles.push(exported);
    } catch (e) {
      console.error(`[error] ${fp}:`, e instanceof Error ? e.message : e);
    }
  }

  console.log(`\nParsed ${mkProfiles.length} MK profiles with spectral data.`);
  const totalPatches = mkProfiles.reduce((s, p) => s + p.patches.length, 0);
  console.log(`Total patches: ${totalPatches}`);

  const payload = {
    schema_version: 1,
    source_dir: SAMPLE_DIR,
    exported_at: new Date().toISOString(),
    profile_count: mkProfiles.length,
    profiles: mkProfiles,
  };
  await fs.writeFile(OUT_FILE, JSON.stringify(payload));
  const bytes = (await fs.stat(OUT_FILE)).size;
  console.log(`\nWrote ${OUT_FILE} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
