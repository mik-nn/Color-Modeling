// frontend/scripts/experiments/h5_rank_distribution.ts
//
// H5 — low-rankness of the substrate-transform difference.
//
// For each same-chart pair of profiles (A, B), matched patch-wise by rounded RGB,
// build the per-patch reflectance difference matrix D = X_B − X_A (N × L) and find
// the smallest rank r whose truncated SVD captures ≥ 99% of the Frobenius energy.
// Energy of rank-r = (σ₁²+…+σᵣ²)/Σσᵢ², and σᵢ² are the eigenvalues of DᵀD (L×L),
// so we only need the eigenvalues of the L×L Gram matrix (L=36).
//
// Acceptance (H5): ≥ 90% of pairs have r ≤ 4. Reject: > 10% need r > 6.
//
// Run: cd frontend && npx tsx scripts/experiments/h5_rank_distribution.ts

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).DOMParser = jsdom.window.DOMParser
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).XMLSerializer = jsdom.window.XMLSerializer

import { parseIcmFile } from '../../src/lib/parsers/icmParser'
import { parseProfileFilename } from '../../src/utils/filenameParser'
import { jacobiEigen } from '../../src/lib/interp/pcaInterp'

const ROOT = path.resolve(process.cwd(), '..')
const PROFILES_ROOT = path.resolve(ROOT, 'data/profiles')
const ENERGY = Number(process.env.H5_ENERGY ?? 0.99)
const MIN_MATCH = Number(process.env.H5_MIN_MATCH ?? 100)

interface Prof {
  name: string
  set: 'BC' | 'MOAB'
  bands: number
  byRgb: Map<string, number[]>
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(full)))
    else if (/\.(icm|icc)$/i.test(e.name)) out.push(full)
  }
  return out
}

const rgbKey = (r: number, g: number, b: number) =>
  `${Math.round(r)},${Math.round(g)},${Math.round(b)}`

async function load(filePath: string): Promise<Prof | null> {
  const buf = await fs.readFile(filePath)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await parseIcmFile({ arrayBuffer: async () => ab } as any)
  if (!res.hasSpectral) return null
  const byRgb = new Map<string, number[]>()
  let bands = 0
  for (const m of res.measurements) {
    if (!m.spectra) continue
    if (m.RGB_R === undefined || m.RGB_G === undefined || m.RGB_B === undefined) continue
    bands = m.spectra.length
    byRgb.set(rgbKey(m.RGB_R, m.RGB_G, m.RGB_B), m.spectra)
  }
  if (byRgb.size < MIN_MATCH) return null
  const base = path.basename(filePath)
  const meta = parseProfileFilename(base)
  return {
    name: base.replace(/\.(icm|icc)$/i, ''),
    set: meta.brand === 'MOAB' ? 'MOAB' : 'BC',
    bands,
    byRgb,
  }
}

// Smallest rank capturing `energy` fraction of the Frobenius energy of D (N×L).
function energyRank(diff: number[][], energy: number): { r: number; bands: number } {
  const L = diff[0].length
  const G: number[][] = Array.from({ length: L }, () => new Array<number>(L).fill(0))
  for (const row of diff) {
    for (let i = 0; i < L; i++) for (let j = i; j < L; j++) G[i][j] += row[i] * row[j]
  }
  for (let i = 0; i < L; i++) for (let j = i; j < L; j++) G[j][i] = G[i][j]
  const ev = jacobiEigen(G).values.map((v) => Math.max(0, v)).sort((a, b) => b - a)
  const total = ev.reduce((a, b) => a + b, 0) || 1
  let cum = 0
  let r = 0
  for (; r < ev.length; r++) {
    cum += ev[r]
    if (cum / total >= energy) {
      r++
      break
    }
  }
  return { r, bands: L }
}

function diffMatrix(a: Prof, b: Prof): number[][] {
  const rows: number[][] = []
  for (const [key, sa] of a.byRgb) {
    const sb = b.byRgb.get(key)
    if (!sb || sb.length !== sa.length) continue
    rows.push(sa.map((v, i) => sb[i] - v))
  }
  return rows
}

function median(xs: number[]): number {
  const s = [...xs].sort((p, q) => p - q)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

async function main() {
  const files = (await walk(PROFILES_ROOT)).sort()
  const profs: Prof[] = []
  for (const f of files) {
    try {
      const p = await load(f)
      if (p) profs.push(p)
    } catch (e) {
      console.error(`[error] ${path.basename(f)}:`, e instanceof Error ? e.message : e)
    }
  }
  console.log(`Loaded ${profs.length} profiles`)

  const ranks: number[] = []
  const perPairLog: { pair: string; matched: number; r: number }[] = []
  for (let i = 0; i < profs.length; i++) {
    for (let j = i + 1; j < profs.length; j++) {
      const a = profs[i]
      const b = profs[j]
      if (a.set !== b.set) continue // only same-chart pairs match patch-wise
      const D = diffMatrix(a, b)
      if (D.length < MIN_MATCH) continue
      const { r } = energyRank(D, ENERGY)
      ranks.push(r)
      perPairLog.push({ pair: `${a.name} ↔ ${b.name}`, matched: D.length, r })
    }
  }

  if (ranks.length === 0) {
    console.log('No matched same-chart pairs found.')
    return
  }

  const hist = new Map<number, number>()
  for (const r of ranks) hist.set(r, (hist.get(r) ?? 0) + 1)
  const le4 = ranks.filter((r) => r <= 4).length / ranks.length
  const le6 = ranks.filter((r) => r <= 6).length / ranks.length

  console.log(`\nH5 rank distribution (≥${(ENERGY * 100).toFixed(0)}% Frobenius energy)`)
  console.log(`pairs: ${ranks.length}, median rank: ${median(ranks)}, max: ${Math.max(...ranks)}`)
  console.log(`fraction r≤4: ${(le4 * 100).toFixed(1)}%  (H5 pass ≥90%)`)
  console.log(`fraction r≤6: ${(le6 * 100).toFixed(1)}%  (H5 reject if >10% need r>6 → r≤6 < 90%)`)
  console.log('histogram (rank: count):')
  for (const r of [...hist.keys()].sort((p, q) => p - q)) console.log(`  ${r}: ${hist.get(r)}`)

  const verdict = le4 >= 0.9 ? 'PASS' : le6 < 0.9 ? 'REJECT' : 'MARGINAL'
  console.log(`\nH5 verdict: ${verdict}`)

  const outJson = path.resolve(process.cwd(), 'data/cae-input/h5-rank.json')
  await fs.mkdir(path.dirname(outJson), { recursive: true })
  await fs.writeFile(
    outJson,
    JSON.stringify(
      { energy: ENERGY, pairs: ranks.length, le4, le6, verdict, perPair: perPairLog },
      null,
      2,
    ),
  )
  console.log(`Wrote ${path.relative(ROOT, outJson)}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
