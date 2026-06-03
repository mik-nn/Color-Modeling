// frontend/scripts/experiments/h15_cyan_anchors.ts
//
// H15 — test cyan-ramp anchors (S5) against the standard S1 anchor set, on the
// same 90 same-mode BC pairs used by `h13_m0m2.ts`. S5 = S1 ∪ 4 cyan-ramp
// patches at RGB (0|64|128|192, 255, 255), targeting the substrate-specific
// 660 nm cyan absorption found by `h14_ink_diagnostic.ts`.
//
// Predicted to lower P95 by ≥ 1.0 ΔE on the DecorMatte ↔ {800M, ChromataWhite,
// Lyve, BelgianLinen} worst-pair set (4-of-6 hit rate, per H15 acceptance).
//
// Run: cd frontend && npx tsx scripts/experiments/h15_cyan_anchors.ts

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).DOMParser = jsdom.window.DOMParser

import { parseIcmFile } from '../../src/lib/parsers/icmParser'
import { runPaperRatioResidualTransfer } from '../../src/lib/predict/paperRatioResidual'
import { paperWPFromBrightestPatch } from '../../src/lib/predict/perLambdaAffine'
import { spectraToLab, deltaE00 } from '../../src/lib/colormath'
import { pickHeuristicAnchors } from '../../src/lib/sampling/heuristic'
import { canonicalPrintMode } from '../../src/utils/printMode'

const ROOT = path.resolve(process.cwd(), '..')
const PROFILES_ROOT = path.resolve(ROOT, 'data/profiles')
const SKIP_PROFILES = new Set(['BC_AllureAq_P9000_MK_EMP'])
// S5 cyan-ramp anchor targets (Epson RGB: G=B=255 keeps cyan ink active).
const CYAN_RAMP_TARGETS: Array<[number, number, number]> = [
  [0, 255, 255],
  [64, 255, 255],
  [128, 255, 255],
  [192, 255, 255],
]

interface PatchData {
  sampleId: string
  rgb: [number, number, number]
  m0: number[]
}
interface ProfileBundle {
  name: string
  preset: string
  patches: PatchData[]
  byId: Map<string, PatchData>
}

async function loadProfile(filePath: string): Promise<ProfileBundle | null> {
  const name = path.basename(filePath).replace(/\.icm$/i, '')
  if (SKIP_PROFILES.has(name)) return null
  const buf = await fs.readFile(filePath)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await parseIcmFile({ arrayBuffer: async () => ab } as any)
  if (!r.hasSpectral) return null
  let preset: string
  try {
    preset = canonicalPrintMode(name)
  } catch {
    return null
  }
  const patches: PatchData[] = []
  const byId = new Map<string, PatchData>()
  for (const m of r.measurements) {
    if (!m.spectra) continue
    if (m.RGB_R === undefined || m.RGB_G === undefined || m.RGB_B === undefined) continue
    const p: PatchData = {
      sampleId: m.SAMPLE_ID,
      rgb: [m.RGB_R, m.RGB_G, m.RGB_B],
      m0: m.spectra,
    }
    patches.push(p)
    byId.set(p.sampleId, p)
  }
  return { name, preset, patches, byId }
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
    else if (/^BC_.*\.icm$/i.test(e.name)) out.push(full)
  }
  return out
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))
  return s[idx]
}

// Find the patch in `D` (N×3 RGB row-major) closest to a target RGB, return its index.
function nearestRgbIdx(D: Float64Array, N: number, target: readonly [number, number, number]): number {
  let bestI = -1
  let bestD = Infinity
  for (let i = 0; i < N; i++) {
    const dr = D[i * 3] - target[0]
    const dg = D[i * 3 + 1] - target[1]
    const db = D[i * 3 + 2] - target[2]
    const d = dr * dr + dg * dg + db * db
    if (d < bestD) {
      bestD = d
      bestI = i
    }
  }
  return bestI
}

async function main() {
  const files = (await walk(PROFILES_ROOT)).sort()
  const profs: ProfileBundle[] = []
  for (const f of files) {
    const p = await loadProfile(f)
    if (p) profs.push(p)
  }
  console.log(`Loaded ${profs.length} BC profiles`)

  interface Row {
    ref: string
    target: string
    preset: string
    s1_median: number
    s1_p95: number
    s5_median: number
    s5_p95: number
    delta_median: number
    delta_p95: number
  }
  const rows: Row[] = []

  for (let i = 0; i < profs.length; i++) {
    for (let j = 0; j < profs.length; j++) {
      if (i === j) continue
      const A = profs[i]
      const B = profs[j]
      if (A.preset !== B.preset) continue

      const shared: string[] = []
      const aRows: PatchData[] = []
      const bRows: PatchData[] = []
      for (const p of A.patches) {
        const q = B.byId.get(p.sampleId)
        if (!q) continue
        shared.push(p.sampleId)
        aRows.push(p)
        bRows.push(q)
      }
      if (shared.length < 100) continue
      const L = aRows[0].m0.length
      const N = shared.length
      const X_A = new Float64Array(N * L)
      const X_B = new Float64Array(N * L)
      const D = new Float64Array(N * 3)
      for (let k = 0; k < N; k++) {
        for (let l = 0; l < L; l++) {
          X_A[k * L + l] = aRows[k].m0[l]
          X_B[k * L + l] = bRows[k].m0[l]
        }
        D[k * 3] = bRows[k].rgb[0]
        D[k * 3 + 1] = bRows[k].rgb[1]
        D[k * 3 + 2] = bRows[k].rgb[2]
      }

      const Baligned = {
        X: X_B, D, channels: 3 as const, N, L,
        wavelengths: Array.from({ length: L }, (_, k) => 380 + k * 10),
        sampleIds: shared, droppedCount: 0,
      }
      const anchorsS1 = pickHeuristicAnchors(Baligned)
      const idxS1 = (anchorsS1.meta?.chosenIdx as number[]).slice()
      const paperRowIdx = idxS1[0]
      const paperSpec = new Float64Array(L)
      for (let l = 0; l < L; l++) paperSpec[l] = X_B[paperRowIdx * L + l]
      const paperWP = paperWPFromBrightestPatch(paperSpec, 1, L, 380)

      // S5 = S1 ∪ 4 cyan-ramp anchors (skip duplicates).
      const idxS5 = idxS1.slice()
      const seen = new Set(idxS5)
      for (const target of CYAN_RAMP_TARGETS) {
        const k = nearestRgbIdx(D, N, target)
        if (k >= 0 && !seen.has(k)) {
          idxS5.push(k)
          seen.add(k)
        }
      }

      function runD1(anchorIdx: number[]) {
        const result = runPaperRatioResidualTransfer({
          X_A, X_B, D, sampleIds: shared, anchorIdx, paperRowIdx, L, paperWP,
          refProfile: A.name, targetProfile: B.name,
          residualRank: 5, uvBandCount: 4,
        })
        const anchorSet = new Set(anchorIdx)
        const des: number[] = []
        for (let k = 0; k < N; k++) {
          if (anchorSet.has(k)) continue
          const a = Array.from(result.X_pred.subarray(k * L, k * L + L))
          const b = Array.from(X_B.subarray(k * L, k * L + L))
          const la = spectraToLab(a)
          const lb = spectraToLab(b)
          des.push(deltaE00(la[0], la[1], la[2], lb[0], lb[1], lb[2]))
        }
        return { median: median(des), p95: percentile(des, 95), n: des.length }
      }

      const s1 = runD1(idxS1)
      const s5 = runD1(idxS5)
      rows.push({
        ref: A.name,
        target: B.name,
        preset: A.preset,
        s1_median: s1.median,
        s1_p95: s1.p95,
        s5_median: s5.median,
        s5_p95: s5.p95,
        delta_median: s5.median - s1.median,
        delta_p95: s5.p95 - s1.p95,
      })
    }
  }

  console.log(`\n=== H15 cyan-ramp anchors (S5 = S1 + 4 cyan, k=17) vs S1 (k=13) on ${rows.length} same-mode BC pairs ===`)
  const s1Meds = rows.map((r) => r.s1_median)
  const s5Meds = rows.map((r) => r.s5_median)
  const s1P95 = rows.map((r) => r.s1_p95)
  const s5P95 = rows.map((r) => r.s5_p95)
  console.log(`  S1 (k=13): med-of-meds=${median(s1Meds).toFixed(3)}  P95-of-meds=${percentile(s1Meds, 95).toFixed(3)}  median-P95=${median(s1P95).toFixed(3)}`)
  console.log(`  S5 (k=17): med-of-meds=${median(s5Meds).toFixed(3)}  P95-of-meds=${percentile(s5Meds, 95).toFixed(3)}  median-P95=${median(s5P95).toFixed(3)}`)
  const wins = rows.filter((r) => r.delta_median < -0.05).length
  const losses = rows.filter((r) => r.delta_median > 0.05).length
  const winsP95 = rows.filter((r) => r.delta_p95 < -0.2).length
  const lossesP95 = rows.filter((r) => r.delta_p95 > 0.2).length
  console.log(`  median wins ≥0.05 ΔE: ${wins}/${rows.length}   losses ≥0.05 ΔE: ${losses}`)
  console.log(`  P95 wins ≥0.2 ΔE: ${winsP95}   losses ≥0.2 ΔE: ${lossesP95}`)

  const passS1 = rows.filter((r) => r.s1_median <= 1.5 && r.s1_p95 <= 3.0).length
  const passS5 = rows.filter((r) => r.s5_median <= 1.5 && r.s5_p95 <= 3.0).length
  console.log(`  H4 pass: S1 ${(passS1 / rows.length * 100).toFixed(1)}%  S5 ${(passS5 / rows.length * 100).toFixed(1)}%`)

  console.log('\nWorst-S1-P95 pairs and their S5 outcome:')
  const worst = [...rows].sort((a, b) => b.s1_p95 - a.s1_p95).slice(0, 6)
  for (const r of worst) {
    console.log(`  ${r.preset.padEnd(20)} ${r.ref.slice(0, 30).padEnd(30)} → ${r.target.slice(0, 30).padEnd(30)} S1: med=${r.s1_median.toFixed(2)} P95=${r.s1_p95.toFixed(2)}   S5: med=${r.s5_median.toFixed(2)} P95=${r.s5_p95.toFixed(2)}   Δmed=${r.delta_median.toFixed(2)} ΔP95=${r.delta_p95.toFixed(2)}`)
  }

  // Per-mode aggregate.
  const byMode = new Map<string, Row[]>()
  for (const r of rows) {
    if (!byMode.has(r.preset)) byMode.set(r.preset, [])
    byMode.get(r.preset)!.push(r)
  }
  console.log('\n=== Per-mode H15 effect (medians) ===')
  console.log(`${'mode'.padEnd(24)} ${'n'.padStart(4)} ${'S1 med'.padStart(8)} ${'S5 med'.padStart(8)} ${'Δmed'.padStart(8)} ${'S1 P95'.padStart(8)} ${'S5 P95'.padStart(8)} ${'ΔP95'.padStart(8)}`)
  for (const mode of [...byMode.keys()].sort()) {
    const rs = byMode.get(mode)!
    const sm = median(rs.map((r) => r.s1_median))
    const fm = median(rs.map((r) => r.s5_median))
    const sp = median(rs.map((r) => r.s1_p95))
    const fp = median(rs.map((r) => r.s5_p95))
    console.log(`${mode.padEnd(24)} ${String(rs.length).padStart(4)} ${sm.toFixed(3).padStart(8)} ${fm.toFixed(3).padStart(8)} ${(fm - sm).toFixed(3).padStart(8)} ${sp.toFixed(3).padStart(8)} ${fp.toFixed(3).padStart(8)} ${(fp - sp).toFixed(3).padStart(8)}`)
  }

  const OUT = path.resolve(process.cwd(), 'data/cae-input/h15_cyan.json')
  await fs.mkdir(path.dirname(OUT), { recursive: true })
  await fs.writeFile(OUT, JSON.stringify({ pairs: rows.length, rows }, null, 2))
  console.log(`\nWrote ${path.relative(ROOT, OUT)}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
