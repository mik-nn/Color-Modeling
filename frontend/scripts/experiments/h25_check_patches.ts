// Quick check: which nearest patches exist for proposed H25 channel-ramp anchors
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).DOMParser = jsdom.window.DOMParser
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).XMLSerializer = jsdom.window.XMLSerializer

import { parseIcmFile } from '../../src/lib/parsers/icmParser'

const ROOT = path.resolve(process.cwd(), '..')
const PROFILES_ROOT = path.resolve(ROOT, 'data/profiles')

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries: import('node:fs').Dirent[]
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...await walk(full))
    else if (e.isFile() && /\.(icm|icc)$/i.test(e.name)) out.push(full)
  }
  return out
}

async function main() {
  const files = await walk(PROFILES_ROOT)
  const icm = files.find(f => path.basename(f).startsWith('BC_') && path.basename(f).includes('ChromataWhite'))
    ?? files.find(f => path.basename(f).startsWith('BC_'))
  if (!icm) { console.log('no BC file found'); return }
  console.log(`Using: ${path.basename(icm)}`)
  const buf = await fs.readFile(icm)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await parseIcmFile({ arrayBuffer: async () => ab } as any)

  const targets: Array<{ label: string; rgb: [number,number,number] }> = [
    // Current S1 corners (already present)
    { label: 'paper (255,255,255)', rgb: [255,255,255] },
    { label: 'cyan  (  0,255,255)', rgb: [  0,255,255] },
    { label: 'magenta(255,  0,255)', rgb: [255,  0,255] },
    { label: 'yellow (255,255,  0)', rgb: [255,255,  0] },
    { label: 'red   (255,  0,  0)', rgb: [255,  0,  0] },
    { label: 'green  (  0,255,  0)', rgb: [  0,255,  0] },
    { label: 'blue   (  0,  0,255)', rgb: [  0,  0,255] },
    { label: 'black  (  0,  0,  0)', rgb: [  0,  0,  0] },
    // Proposed H25 mid-channel ramp points
    { label: 'C-50% (128,255,255)', rgb: [128,255,255] },
    { label: 'M-50% (255,128,255)', rgb: [255,128,255] },
    { label: 'Y-50% (255,255,128)', rgb: [255,255,128] },
    // User's suggestion
    { label: '(0,112,112) user', rgb: [  0,112,112] },
    // Neutral mid-points (for comparison)
    { label: 'neutral-50% (128,128,128)', rgb: [128,128,128] },
    { label: 'neutral-25% (192,192,192)', rgb: [192,192,192] },
    { label: 'neutral-75% (64,64,64)',    rgb: [64, 64, 64] },
  ]

  console.log('\n=== Nearest patch lookup (out of 905 patches) ===')
  console.log('Target                       Nearest found               L1-dist  CMY_A   CMY_B   CMY_C')
  for (const { label, rgb } of targets) {
    let bestDist = Infinity, bestM: typeof r.measurements[0] | null = null
    for (const m of r.measurements) {
      const d = Math.abs(m.RGB_R - rgb[0]) + Math.abs(m.RGB_G - rgb[1]) + Math.abs(m.RGB_B - rgb[2])
      if (d < bestDist) { bestDist = d; bestM = m }
    }
    if (!bestM) continue
    const cC = ((255 - bestM.RGB_R) / 255).toFixed(3)
    const cM = ((255 - bestM.RGB_G) / 255).toFixed(3)
    const cY = ((255 - bestM.RGB_B) / 255).toFixed(3)
    const found = `(${String(bestM.RGB_R).padStart(3)},${String(bestM.RGB_G).padStart(3)},${String(bestM.RGB_B).padStart(3)})`
    console.log(`${label.padEnd(28)}  ${found.padEnd(22)}  dist=${bestDist}   C=${cC} M=${cM} Y=${cY}`)
  }

  // Also show the CMY single-channel patches: R=0,G=255 patches (vary only B)
  // These are the Y-channel ramp: (0,255,255) = C max, (0,255, 0) = CY, (0,255,x) = varies Y with C=1
  console.log('\n=== Cyan-channel ramp (G=255, B=255, R varies) ===')
  const cyRamp = r.measurements
    .filter(m => m.RGB_G >= 248 && m.RGB_B >= 248)
    .sort((a, b) => a.RGB_R - b.RGB_R)
  for (const m of cyRamp) {
    const aC = ((255-m.RGB_R)/255).toFixed(3)
    console.log(`  RGB(${String(m.RGB_R).padStart(3)},${m.RGB_G},${m.RGB_B})  C=${aC} M=0.000 Y=0.000`)
  }

  console.log('\n=== Magenta-channel ramp (R=255, B=255, G varies) ===')
  const mRamp = r.measurements
    .filter(m => m.RGB_R >= 248 && m.RGB_B >= 248)
    .sort((a, b) => a.RGB_G - b.RGB_G)
  for (const m of mRamp) {
    const aM = ((255-m.RGB_G)/255).toFixed(3)
    console.log(`  RGB(${m.RGB_R},${String(m.RGB_G).padStart(3)},${m.RGB_B})  C=0.000 M=${aM} Y=0.000`)
  }

  console.log('\n=== Yellow-channel ramp (R=255, G=255, B varies) ===')
  const yRamp = r.measurements
    .filter(m => m.RGB_R >= 248 && m.RGB_G >= 248)
    .sort((a, b) => a.RGB_B - b.RGB_B)
  for (const m of yRamp) {
    const aY = ((255-m.RGB_B)/255).toFixed(3)
    console.log(`  RGB(${m.RGB_R},${m.RGB_G},${String(m.RGB_B).padStart(3)})  C=0.000 M=0.000 Y=${aY}`)
  }

  console.log('\n=== Neutral ramp (R=G=B) ===')
  const neutRamp = r.measurements
    .filter(m => Math.abs(m.RGB_R-m.RGB_G) + Math.abs(m.RGB_G-m.RGB_B) <= 2)
    .sort((a, b) => a.RGB_R - b.RGB_R)
  console.log(`  ${neutRamp.length} exact-neutral patches`)
  for (const m of neutRamp.slice(0, 5)) {
    const a = ((765-m.RGB_R-m.RGB_G-m.RGB_B)/765).toFixed(3)
    console.log(`  RGB(${m.RGB_R},${m.RGB_G},${m.RGB_B})  a_neutral=${a}`)
  }
  console.log(`  ...`)
}

main().catch(console.error)
