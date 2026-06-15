// frontend/scripts/experiments/h19_ksweep_dopt.ts
//
// D-optimal minimum-k characterization for the article.
// For each same-mode BC pair, runs D1+D7 at k=6,7,8,9,10,13 using:
//   (a) greedy: first k entries from pickHeuristicAnchors
//   (b) D-optimal: dOptimalAnchors(X_A_clean, N, L, paperRowIdx, k)
// Reports pass-fraction vs k table for both strategies.
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h19_ksweep_dopt.ts"

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).DOMParser = jsdom.window.DOMParser
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).XMLSerializer = jsdom.window.XMLSerializer

import { parseIcmFile } from '../../src/lib/parsers/icmParser'
import { loadProfileMatrix, alignProfiles } from '../../src/lib/dataset/matrix'
import { pickHeuristicAnchors } from '../../src/lib/sampling/heuristic'
import { runPaperRatioResidualTransfer } from '../../src/lib/predict/paperRatioResidual'
import {
  extractOBAEmission, computeOBAFactorPerPatch, subtractOBA, addOBA,
} from '../../src/lib/predict/obaSeparator'
import { paperWPFromBrightestPatch } from '../../src/lib/predict/perLambdaAffine'
import { spectraToLab, deltaE00 } from '../../src/lib/colormath'
import { canonicalPrintMode } from '../../src/utils/printMode'
import { dOptimalAnchors } from '../../src/lib/experiments/kSweep'
import type { ProfileData } from '../../src/types'

const ROOT = path.resolve(process.cwd(), '..')
const PROFILES_ROOT = path.resolve(ROOT, 'data/profiles')
const OUT_JSON = path.resolve(process.cwd(), 'data/cae-input/h19_ksweep_dopt.json')
const MIN_MATCH = 100
const UV_BAND_COUNT = 4
const RANK = 5
const K_GRID = [6, 7, 8, 9, 10, 13]

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

async function loadProfile(filePath: string): Promise<(ProfileData & { wavelengths: number[] }) | null> {
  try {
    const buf = await fs.readFile(filePath)
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await parseIcmFile({ arrayBuffer: async () => ab } as any)
    if (!r.hasSpectral || !r.measurements.length) return null
    const name = path.basename(filePath).replace(/\.(icm|icc)$/i, '')
    let preset: string
    try { preset = canonicalPrintMode(name) } catch { return null }
    return {
      metadata: {
        full_name: name, brand: name.startsWith('BC') ? 'BC' : 'MOAB',
        series: name, printer: 'P9000', ink: 'mk', substrate: name,
        parsed_at: new Date().toISOString(), printMode: preset,
      },
      raw: r.measurements, clean: r.measurements,
      has_spectral: true, patch_count: r.measurements.length,
      wavelengths: r.wavelengths ?? Array.from({ length: 36 }, (_, i) => 380 + i * 10),
    }
  } catch { return null }
}

interface KRow { k: number; greedy_pass: boolean; dopt_pass: boolean; greedy_med: number; dopt_med: number; greedy_p95: number; dopt_p95: number }

async function evalPair(
  profA: ProfileData & { wavelengths: number[] },
  profB: ProfileData & { wavelengths: number[] },
): Promise<KRow[] | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const al = alignProfiles(loadProfileMatrix(profA as any), loadProfileMatrix(profB as any))
  if (al.N < MIN_MATCH) return null
  const { N, X_A, X_B, D } = al
  const L = profA.wavelengths.length

  let paperRowIdx = 0
  for (let i = 0; i < N; i++) {
    if (D[i * 3] === 255 && D[i * 3 + 1] === 255 && D[i * 3 + 2] === 255) { paperRowIdx = i; break }
  }
  const paperSpecA = Array.from(X_A.subarray(paperRowIdx * L, paperRowIdx * L + L))
  const paperSpecB = Array.from(X_B.subarray(paperRowIdx * L, paperRowIdx * L + L))
  const emA = extractOBAEmission(paperSpecA)
  const emB = extractOBAEmission(paperSpecB)
  const fA = computeOBAFactorPerPatch(X_A, L, paperRowIdx)
  const fB = computeOBAFactorPerPatch(X_B, L, paperRowIdx)
  const X_A_clean = subtractOBA(X_A, L, fA, emA.emission)
  const X_B_clean = subtractOBA(X_B, L, fB, emB.emission)
  const paperWP = paperWPFromBrightestPatch(new Float64Array(paperSpecB), 1, L, 380)

  const tgt = { X: X_B, D, channels: 3 as const, N, L, wavelengths: al.wavelengths ?? [], sampleIds: al.sampleIds, droppedCount: 0 }
  const maxK = Math.max(...K_GRID)
  // All greedy anchors (up to maxK).
  const greedyAll = (pickHeuristicAnchors(tgt).meta?.chosenIdx as number[]).slice(0, maxK)
  // D-optimal at max k.
  const doptAll = dOptimalAnchors(X_A_clean, N, L, paperRowIdx, maxK)

  const runWithAnchors = (anchorIdx: number[]): { med: number; p95: number } => {
    const anchorSet = new Set(anchorIdx)
    const d1 = runPaperRatioResidualTransfer({
      X_A: X_A_clean, X_B: X_B_clean, D,
      sampleIds: al.sampleIds, anchorIdx, paperRowIdx, L, paperWP,
      refProfile: profA.metadata.full_name, targetProfile: profB.metadata.full_name,
      residualRank: RANK, uvBandCount: UV_BAND_COUNT,
    })
    const X_pred = addOBA(d1.X_pred, L, fB, emB.emission)
    const des: number[] = []
    for (let k = 0; k < N; k++) {
      if (anchorSet.has(k)) continue
      const pred = Array.from(X_pred.subarray(k * L, k * L + L))
      const meas = Array.from(X_B.subarray(k * L, k * L + L))
      const lp = spectraToLab(pred), lm = spectraToLab(meas)
      des.push(deltaE00(lp[0], lp[1], lp[2], lm[0], lm[1], lm[2]))
    }
    return { med: median(des), p95: percentile(des, 95) }
  }

  return K_GRID.map(k => {
    const g = runWithAnchors(greedyAll.slice(0, k))
    const d = runWithAnchors(doptAll.slice(0, k))
    return {
      k,
      greedy_med: g.med, greedy_p95: g.p95, greedy_pass: g.med <= 1.5 && g.p95 <= 3.0,
      dopt_med: d.med, dopt_p95: d.p95, dopt_pass: d.med <= 1.5 && d.p95 <= 3.0,
    }
  })
}

async function main() {
  const allFiles = await walk(PROFILES_ROOT)
  const profiles = (await Promise.all(allFiles.map(loadProfile))).filter(Boolean) as Array<ProfileData & { wavelengths: number[] }>
  const bcProfiles = profiles.filter(p => p.metadata.brand === 'BC')
  console.log(`BC profiles loaded: ${bcProfiles.length}`)

  // Accumulate per-k counts across pairs.
  const kCountsGreedy = new Map<number, { pass: number; total: number; meds: number[] }>()
  const kCountsDopt   = new Map<number, { pass: number; total: number; meds: number[] }>()
  for (const k of K_GRID) {
    kCountsGreedy.set(k, { pass: 0, total: 0, meds: [] })
    kCountsDopt.set(k, { pass: 0, total: 0, meds: [] })
  }

  let done = 0
  for (let i = 0; i < bcProfiles.length; i++) {
    for (let j = 0; j < bcProfiles.length; j++) {
      if (i === j) continue
      if (bcProfiles[i].metadata.printMode !== bcProfiles[j].metadata.printMode) continue
      if (bcProfiles[i].metadata.full_name.includes('AllureAq') ||
          bcProfiles[j].metadata.full_name.includes('AllureAq')) continue
      const rows = await evalPair(bcProfiles[i], bcProfiles[j])
      if (!rows) continue
      done++
      for (const row of rows) {
        const g = kCountsGreedy.get(row.k)!; g.total++; g.meds.push(row.greedy_med); if (row.greedy_pass) g.pass++
        const d = kCountsDopt.get(row.k)!;   d.total++; d.meds.push(row.dopt_med);   if (row.dopt_pass)   d.pass++
      }
      process.stdout.write(`\r${done} pairs`)
    }
  }
  console.log()

  console.log('\n── D-optimal k-sweep (same-mode BC pairs) ─────────────────')
  console.log(`  k  | greedy pass% | greedy med | dopt pass% | dopt med`)
  console.log(`  ---|-------------|------------|-----------|----------`)
  const tableRows: object[] = []
  for (const k of K_GRID) {
    const g = kCountsGreedy.get(k)!, d = kCountsDopt.get(k)!
    const gPct = (100 * g.pass / g.total).toFixed(1)
    const dPct = (100 * d.pass / d.total).toFixed(1)
    const gMed = median(g.meds).toFixed(3)
    const dMed = median(d.meds).toFixed(3)
    console.log(`  ${k.toString().padStart(2)} | ${gPct.padStart(11)}% | ${gMed.padStart(10)} | ${dPct.padStart(9)}% | ${dMed}`)
    tableRows.push({ k, greedy_pass_pct: +gPct, greedy_med: +gMed, dopt_pass_pct: +dPct, dopt_med: +dMed, n: g.total })
  }
  console.log()

  await fs.writeFile(OUT_JSON, JSON.stringify({ generated: new Date().toISOString(), nPairs: done, table: tableRows }, null, 2))
  console.log(`Wrote ${OUT_JSON}`)
}

main().catch(console.error)
