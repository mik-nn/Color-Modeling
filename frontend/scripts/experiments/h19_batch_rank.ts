// frontend/scripts/experiments/h19_batch_rank.ts
//
// H19c — Does residualRank 5→8 raise same-mode H4 pass rate from 80.6%?
//
// Iterates all same-mode BC P9000 pairs (98 pairs after filtering AllureAq).
// Runs D1+S1(k=13)+D7 at rank=5 and rank=8. Reports H4 pass rate for each.
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h19_batch_rank.ts"

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
import type { ProfileData } from '../../src/types'

const ROOT = path.resolve(process.cwd(), '..')
const PROFILES_ROOT = path.resolve(ROOT, 'data/profiles')
const OUT_JSON = path.resolve(process.cwd(), 'data/cae-input/h19_batch_rank.json')
const MIN_MATCH = 100
const UV_BAND_COUNT = 4

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

async function loadProfile(filePath: string): Promise<(ProfileData & { wavelengths: number[]; filePath: string }) | null> {
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
      filePath,
    }
  } catch { return null }
}

interface PairResult {
  ref: string; tgt: string; mode: string; n: number
  r5_median: number; r5_p95: number; r5_pass: boolean
  r8_median: number; r8_p95: number; r8_pass: boolean
}

async function evalPair(
  profA: ProfileData & { wavelengths: number[] },
  profB: ProfileData & { wavelengths: number[] },
): Promise<PairResult | null> {
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
  const anchorIdx = (pickHeuristicAnchors(tgt).meta?.chosenIdx as number[]).slice(0, 13)
  const anchorSet = new Set(anchorIdx)
  const refName = profA.metadata.full_name, tgtName = profB.metadata.full_name

  const runRank = (rank: number): { med: number; p95: number } => {
    const d1 = runPaperRatioResidualTransfer({
      X_A: X_A_clean, X_B: X_B_clean, D,
      sampleIds: al.sampleIds, anchorIdx, paperRowIdx, L, paperWP,
      refProfile: refName, targetProfile: tgtName,
      residualRank: rank, uvBandCount: UV_BAND_COUNT,
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

  const r5 = runRank(5), r8 = runRank(8)
  return {
    ref: refName, tgt: tgtName, mode: profA.metadata.printMode ?? '',
    n: al.N,
    r5_median: r5.med, r5_p95: r5.p95, r5_pass: r5.med <= 1.5 && r5.p95 <= 3.0,
    r8_median: r8.med, r8_p95: r8.p95, r8_pass: r8.med <= 1.5 && r8.p95 <= 3.0,
  }
}

async function main() {
  const allFiles = await walk(PROFILES_ROOT)
  console.log(`Found ${allFiles.length} profile files`)
  const profiles = (await Promise.all(allFiles.map(loadProfile))).filter(Boolean) as Array<ProfileData & { wavelengths: number[]; filePath: string }>
  const bcProfiles = profiles.filter(p => p.metadata.brand === 'BC')
  console.log(`BC profiles: ${bcProfiles.length}`)

  const results: PairResult[] = []
  let done = 0

  for (let i = 0; i < bcProfiles.length; i++) {
    for (let j = 0; j < bcProfiles.length; j++) {
      if (i === j) continue
      if (bcProfiles[i].metadata.printMode !== bcProfiles[j].metadata.printMode) continue
      // Skip AllureAq (1550-patch chart — mismatched grid).
      if (bcProfiles[i].metadata.full_name.includes('AllureAq') ||
          bcProfiles[j].metadata.full_name.includes('AllureAq')) continue
      const r = await evalPair(bcProfiles[i], bcProfiles[j])
      done++
      if (r) { results.push(r) }
      process.stdout.write(`\r${done} pairs evaluated (${results.length} valid)`)
    }
  }
  console.log()

  const r5Pass = results.filter(r => r.r5_pass).length
  const r8Pass = results.filter(r => r.r8_pass).length
  const n = results.length
  console.log(`\n── H19c Results ─────────────────────────────────────────`)
  console.log(`  Same-mode pairs evaluated: ${n}`)
  console.log(`  rank=5: pass=${r5Pass}/${n} (${(100 * r5Pass / n).toFixed(1)}%)  med-of-meds=${median(results.map(r => r.r5_median)).toFixed(3)}  P95-of-meds=${percentile(results.map(r => r.r5_median), 95).toFixed(3)}`)
  console.log(`  rank=8: pass=${r8Pass}/${n} (${(100 * r8Pass / n).toFixed(1)}%)  med-of-meds=${median(results.map(r => r.r8_median)).toFixed(3)}  P95-of-meds=${percentile(results.map(r => r.r8_median), 95).toFixed(3)}`)
  console.log(`  H19c: ${100 * r8Pass / n >= 85 ? 'PASS (≥85%)' : r8Pass >= r5Pass ? 'IMPROVEMENT but <85%' : 'REGRESSION'}`)

  await fs.writeFile(OUT_JSON, JSON.stringify({ generated: new Date().toISOString(), n, results }, null, 2))
  console.log(`\nWrote ${OUT_JSON}`)
}

main().catch(console.error)
