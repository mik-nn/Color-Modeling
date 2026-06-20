// H44 manifest builder — probe each printer's profiles and emit data/h44_manifest.json
//
// Records per-file: printer, substrate (from filename), patchCount, hasSpectral,
// wavelengthCount, parseError. Used by experiment A+B scripts to build the printer ladder.
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h44_manifest_builder.ts"

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).DOMParser = jsdom.window.DOMParser
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).XMLSerializer = jsdom.window.XMLSerializer
import { parseIcmFile } from '../../src/lib/parsers/icmParser'

const REPO = path.resolve(process.cwd(), '..')
const P9000_DIR = '/mnt/e/PET/LinkedInPosts/surecolor-p9000'

const PRINTERS: Array<{
  id: string
  label: string
  inkCount: number
  inkType: 'dye' | 'pigment'
  dirs: string[]
}> = [
  {
    id: 'canon_g2470',
    label: 'Canon G2470',
    inkCount: 4,
    inkType: 'dye',
    dirs: [path.join(REPO, 'data/profiles/Canon G2470')],
  },
  {
    id: 'canon_g1430',
    label: 'Canon G1430',
    inkCount: 4,
    inkType: 'dye',
    dirs: [path.join(REPO, 'data/profiles/G1430')],
  },
  {
    id: 'epson_p9000',
    label: 'Epson P9000',
    inkCount: 10,
    inkType: 'pigment',
    dirs: [P9000_DIR],
  },
  {
    id: 'epson_p9900',
    label: 'Epson P9900',
    inkCount: 11,
    inkType: 'pigment',
    dirs: [path.join(REPO, 'data/profiles/stylus-pro-9900')],
  },
  {
    id: 'canon_ipf4100',
    label: 'Canon iPF4100',
    inkCount: 12,
    inkType: 'pigment',
    dirs: [path.join(REPO, 'data/profiles/ipf-pro-4100/extracted')],
  },
  {
    id: 'canon_ipf8100_bc',
    label: 'Canon iPF8100 (BC)',
    inkCount: 12,
    inkType: 'pigment',
    dirs: [path.join(REPO, 'data/profiles/ipf8100')],
  },
  {
    id: 'canon_ipf8100_moab',
    label: 'Canon iPF8100 (MOAB)',
    inkCount: 12,
    inkType: 'pigment',
    dirs: [
      path.join(REPO, 'data/profiles/Canon+imagePROGRAF+iPF8100+MOAB+ICC+Profiles/Canon iPF8100 MOAB Profiles'),
    ],
  },
]

interface ManifestEntry {
  printer: string
  file: string
  substrate: string
  patchCount: number
  hasSpectral: boolean
  wavelengthCount: number
  parseError?: string
}

async function walkIcc(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const d of entries) {
    if (d.name.includes('Zone.Identifier')) continue
    const fp = path.join(dir, d.name)
    if (d.isDirectory()) out.push(...await walkIcc(fp))
    else if (d.isFile() && /\.(icm|icc)$/i.test(d.name)) out.push(fp)
  }
  return out
}

function substrateFromFilename(fp: string): string {
  const base = path.basename(fp, path.extname(fp))
  // Strip leading @ or BC_ prefix, trailing printer/mode suffixes
  return base.replace(/^[@]|^BC_/i, '').replace(/_?(Pro\d+|iPF\d+|G\d+|x?900|9900|4100|8100).*$/i, '').trim()
}

async function probeFile(fp: string): Promise<Omit<ManifestEntry, 'printer'>> {
  const substrate = substrateFromFilename(fp)
  try {
    const buf = await fs.readFile(fp)
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    // parseIcmFile expects a File-like object
    const fakefile = { arrayBuffer: async () => ab, name: path.basename(fp) } as unknown as File
    const result = await parseIcmFile(fakefile)
    return {
      file: path.basename(fp),
      substrate,
      patchCount: result.patchCount,
      hasSpectral: result.hasSpectral,
      wavelengthCount: result.wavelengths?.length ?? 0,
    }
  } catch (e) {
    return {
      file: path.basename(fp),
      substrate,
      patchCount: 0,
      hasSpectral: false,
      wavelengthCount: 0,
      parseError: String(e),
    }
  }
}

async function main() {
  const manifest: ManifestEntry[] = []

  for (const printer of PRINTERS) {
    console.log(`\n=== ${printer.label} (${printer.inkCount} inks, ${printer.inkType}) ===`)
    const files: string[] = []
    for (const dir of printer.dirs) files.push(...await walkIcc(dir))

    let ok = 0, spectral = 0, errors = 0
    for (const fp of files) {
      const entry = await probeFile(fp)
      manifest.push({ printer: printer.id, ...entry })
      if (entry.parseError) {
        errors++
        console.log(`  ERR  ${entry.file}: ${entry.parseError.slice(0, 80)}`)
      } else if (!entry.hasSpectral) {
        console.log(`  NOSP ${entry.file}: ${entry.patchCount} patches, no spectral`)
        ok++
      } else {
        console.log(`  OK   ${entry.file}: ${entry.patchCount} patches, ${entry.wavelengthCount} bands`)
        ok++; spectral++
      }
    }
    console.log(`  → ${files.length} files, ${ok} parsed, ${spectral} spectral, ${errors} errors`)
  }

  const outPath = path.join(REPO, 'data', 'h44_manifest.json')
  await fs.writeFile(outPath, JSON.stringify(manifest, null, 2))
  console.log(`\nWrote ${manifest.length} entries → ${outPath}`)

  // Summary table
  console.log('\n--- Summary ---')
  for (const printer of PRINTERS) {
    const rows = manifest.filter(e => e.printer === printer.id)
    const spectralRows = rows.filter(e => e.hasSpectral)
    const patchCounts = [...new Set(spectralRows.map(e => e.patchCount))]
    console.log(`${printer.label.padEnd(30)} total=${rows.length} spectral=${spectralRows.length} patches=${patchCounts.join(',')}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
