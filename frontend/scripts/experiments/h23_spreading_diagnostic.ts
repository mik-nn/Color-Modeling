// frontend/scripts/experiments/h23_spreading_diagnostic.ts
//
// H23 diagnostic: does dot-gain / spreading differ between failing and passing
// substrate pairs — and if so, is OBA mismatch or spreading the dominant driver?
//
// Two failure groups from h_diagnose_failing_pairs:
//   Group A — OBA-driven (DecorMatte): p95_lo high even at light tones
//   Group B — Spreading candidate (Silverada, VibranceMetallic): p95_lo OK,
//              high-ink tones fail → hypothesis: metallic surface absorbs ink
//              differently → different dot-gain curve
//
// Method:
//   For each profile:
//     1. Extract neutral-ramp patches (R=G=B, all levels).
//     2. Normalize reflectance to paper: R_norm(λ) = R_patch(λ) / R_paper(λ).
//     3. At λ=560 nm (OBA-insensitive): fit quadratic y = 1 + c1·a + c2·a²
//        where a = (255 - RGB) / 255 is ink level.
//   For each pair:
//     - Spreading delta: Euclidean distance of (c1,c2) vectors.
//     - OBA delta: |R_paper_A(380) - R_paper_B(380)|.
//   Cross-reference with pass/fail from h_diagnose_failing.json.
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h23_spreading_diagnostic.ts"

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).DOMParser = jsdom.window.DOMParser
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).XMLSerializer = jsdom.window.XMLSerializer

import { parseIcmFile } from '../../src/lib/parsers/icmParser'
import { canonicalPrintMode } from '../../src/utils/printMode'

const ROOT       = path.resolve(process.cwd(), '..')
const PROFILES_ROOT = path.resolve(ROOT, 'data/profiles')
const DIAG_JSON  = path.resolve(process.cwd(), 'data/cae-input/h_diagnose_failing.json')

const WL_START = 380
const WL_STEP  = 10
const L        = 36
const IDX_380  = 0                               // 380 nm
const IDX_560  = (560 - WL_START) / WL_STEP     // 18

// ─── helpers ────────────────────────────────────────────────────────────────

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

/** Least-squares fit of y = 1 + c1·x + c2·x²  (c0 forced to 1 because R_norm(paper)=1).
 *  Returns [c1, c2]. */
function fitQuadNoBias(xs: number[], ys: number[]): [number, number] {
  const n = xs.length
  if (n < 2) return [0, 0]
  // Design: each row [x, x²], response: y - 1
  let S11 = 0, S12 = 0, S22 = 0, T1 = 0, T2 = 0
  for (let i = 0; i < n; i++) {
    const x = xs[i], x2 = x * x, r = ys[i] - 1
    S11 += x * x; S12 += x * x2; S22 += x2 * x2
    T1  += x * r; T2  += x2 * r
  }
  const det = S11 * S22 - S12 * S12
  if (Math.abs(det) < 1e-18) return [0, 0]
  const c1 = (T1 * S22 - T2 * S12) / det
  const c2 = (T2 * S11 - T1 * S12) / det
  return [c1, c2]
}

interface ProfileSpreading {
  name: string
  preset: string
  r380: number         // paper R at 380 nm (OBA indicator)
  r440: number         // paper R at 440 nm
  r550: number         // paper R at 550 nm (reference)
  c1: number           // quadratic fit of neutral ramp at 560 nm
  c2: number
  rampN: number        // number of neutral ramp patches used
  inkLevels: number[]  // sampled a values (for report)
  rampY: number[]      // sampled R_norm(560) values
}

async function analyzeProfile(filePath: string): Promise<ProfileSpreading | null> {
  try {
    const buf = await fs.readFile(filePath)
    const ab  = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r   = await parseIcmFile({ arrayBuffer: async () => ab } as any)
    if (!r.hasSpectral || !r.measurements.length) return null

    const name = path.basename(filePath).replace(/\.(icm|icc)$/i, '')
    let preset: string
    try { preset = canonicalPrintMode(name) } catch { return null }

    // Paper patch
    const paperPatch = r.measurements.find(
      m => m.RGB_R === 255 && m.RGB_G === 255 && m.RGB_B === 255 && m.spectra,
    )
    if (!paperPatch?.spectra || paperPatch.spectra.length < L) return null
    const paper = paperPatch.spectra

    // Neutral ramp: R=G=B, exclude paper (255,255,255)
    const neutral = r.measurements
      .filter(m => m.RGB_R === m.RGB_G && m.RGB_G === m.RGB_B
                && m.RGB_R < 255 && m.spectra && m.spectra.length >= L)
      .sort((a, b) => a.RGB_R - b.RGB_R) // dark first (high ink)

    if (neutral.length < 3) return null

    const inkLevels: number[] = []
    const rampY: number[] = []

    for (const m of neutral) {
      const a = (255 - m.RGB_R) / 255
      const rnorm = paper[IDX_560] > 1e-4 ? m.spectra![IDX_560] / paper[IDX_560] : 1
      inkLevels.push(a)
      rampY.push(rnorm)
    }

    const [c1, c2] = fitQuadNoBias(inkLevels, rampY)

    return {
      name, preset,
      r380: paper[IDX_380],
      r440: paper[(440 - WL_START) / WL_STEP],
      r550: paper[(550 - WL_START) / WL_STEP],
      c1, c2,
      rampN: neutral.length,
      inkLevels, rampY,
    }
  } catch { return null }
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  // Load known pass/fail from previous run
  const diagRaw = JSON.parse(await fs.readFile(DIAG_JSON, 'utf8'))
  const failSet = new Set<string>(
    diagRaw.failing.map((r: { ref: string; tgt: string }) => `${r.ref}↔${r.tgt}`)
  )
  const pairPass = new Map<string, boolean>()
  for (const r of diagRaw.failing)  pairPass.set(`${r.ref}↔${r.tgt}`, false)
  for (const r of diagRaw.passing)  pairPass.set(`${r.ref}↔${r.tgt}`, true)

  // Load all BC profiles
  const files = (await walk(PROFILES_ROOT)).sort()
  const profiles: ProfileSpreading[] = []
  for (const f of files) {
    if (!path.basename(f).startsWith('BC_')) continue
    const p = await analyzeProfile(f)
    if (p) profiles.push(p)
  }
  console.log(`Loaded ${profiles.length} BC profiles\n`)

  // Index by full name
  const byName = new Map(profiles.map(p => [p.name, p]))

  // ── Per-profile ramp summary ─────────────────────────────────────────────
  console.log('=== Spreading curve fit per profile (neutral ramp → 560 nm) ===')
  console.log('profile'.padEnd(55) + 'preset'.padEnd(14) + 'N'.padStart(4) +
              'r380'.padStart(7) + 'r440'.padStart(7) + 'c1'.padStart(9) + 'c2'.padStart(9))
  for (const p of profiles.sort((a, b) => a.preset.localeCompare(b.preset) || a.name.localeCompare(b.name))) {
    console.log(
      p.name.padEnd(55) + p.preset.padEnd(14) +
      p.rampN.toString().padStart(4) +
      p.r380.toFixed(3).padStart(7) +
      p.r440.toFixed(3).padStart(7) +
      p.c1.toFixed(4).padStart(9) +
      p.c2.toFixed(4).padStart(9)
    )
  }

  // ── Pair analysis: spreading delta + OBA delta vs pass/fail ─────────────
  console.log('\n=== Pair analysis: failing pairs spreading diagnostic ===')
  console.log('ref → tgt | Δc1  Δc2  ΔSpread  ΔOBA  | inkLo_p95 | verdict')

  // Focus on known failing pairs
  const failingDetails = diagRaw.failing as Array<{
    ref: string; tgt: string; mode: string
    p95_lo: number; p95_mid: number; p95_hi: number; med: number; p95: number
  }>

  for (const pair of failingDetails) {
    const pA = byName.get(pair.ref)
    const pB = byName.get(pair.tgt)
    if (!pA || !pB) { console.log(`  [missing] ${pair.ref} / ${pair.tgt}`); continue }

    const dc1   = pB.c1 - pA.c1
    const dc2   = pB.c2 - pA.c2
    const dSpread = Math.sqrt(dc1 * dc1 + dc2 * dc2)
    const dOBA  = Math.abs(pA.r380 - pB.r380)

    const refS = pair.ref.replace('BC_','').replace('_P9000_mk_','|').replace('_P9000_pk_','|').replace('_P9000_','|')
    const tgtS = pair.tgt.replace('BC_','').replace('_P9000_mk_','|').replace('_P9000_pk_','|').replace('_P9000_','|')
    console.log(
      `  ${refS.padEnd(35)} → ${tgtS.padEnd(35)}` +
      `  Δc1=${dc1.toFixed(3).padStart(7)} Δc2=${dc2.toFixed(3).padStart(7)}` +
      `  dSpread=${dSpread.toFixed(3).padStart(6)}  dOBA=${dOBA.toFixed(3).padStart(6)}` +
      `  p95_lo=${isNaN(pair.p95_lo) ? '  n/a' : pair.p95_lo.toFixed(2).padStart(5)}` +
      `  med=${pair.med.toFixed(2)}`
    )
  }

  // ── Statistical summary: failing vs passing distributions ───────────────
  const spreadingFail: number[] = [], obaFail: number[] = []
  const spreadingPass: number[] = [], obaPass: number[] = []

  const allPairs = [...diagRaw.failing, ...diagRaw.passing]
  for (const pair of allPairs) {
    const pA = byName.get(pair.ref)
    const pB = byName.get(pair.tgt)
    if (!pA || !pB) continue
    const dc1 = pB.c1 - pA.c1
    const dc2 = pB.c2 - pA.c2
    const dSpread = Math.sqrt(dc1 * dc1 + dc2 * dc2)
    const dOBA = Math.abs(pA.r380 - pB.r380)
    const isFail = failSet.has(`${pair.ref}↔${pair.tgt}`)
    if (isFail) { spreadingFail.push(dSpread); obaFail.push(dOBA) }
    else         { spreadingPass.push(dSpread); obaPass.push(dOBA) }
  }

  function med(xs: number[]) {
    if (!xs.length) return NaN
    const s = [...xs].sort((a, b) => a - b)
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2
  }
  function p75(xs: number[]) {
    if (!xs.length) return NaN
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.round(0.75 * (s.length - 1))]
  }

  console.log('\n=== Statistical summary ===')
  console.log('                     FAILING                  PASSING')
  console.log('                   med    P75             med    P75')
  console.log(`Spreading Δ (c1,c2)  ${med(spreadingFail).toFixed(4).padStart(7)}  ${p75(spreadingFail).toFixed(4).padStart(7)}         ${med(spreadingPass).toFixed(4).padStart(7)}  ${p75(spreadingPass).toFixed(4).padStart(7)}`)
  console.log(`OBA Δ R(380)         ${med(obaFail).toFixed(4).padStart(7)}  ${p75(obaFail).toFixed(4).padStart(7)}         ${med(obaPass).toFixed(4).padStart(7)}  ${p75(obaPass).toFixed(4).padStart(7)}`)

  // ── Specific substrate spotlight: Silverada vs normal CanvasSatin ───────
  console.log('\n=== Spotlight: CanvasSatin neutral ramp curves at 560 nm ===')
  const cs = profiles.filter(p => p.preset === 'CanvasSatin')
  for (const p of cs) {
    console.log(`\n  ${p.name}  (r380=${p.r380.toFixed(3)}, c1=${p.c1.toFixed(4)}, c2=${p.c2.toFixed(4)})`)
    const steps = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
    const predicted = steps.map(a => (1 + p.c1 * a + p.c2 * a * a).toFixed(3))
    console.log('    a:    ' + steps.map(a => a.toFixed(1).padStart(6)).join(''))
    console.log('    Rnorm:' + predicted.map(v => v.padStart(6)).join(''))
  }

  // ── Spotlight: CanvasMatte (OBA group) ──────────────────────────────────
  console.log('\n=== Spotlight: CanvasMatte neutral ramp curves at 560 nm ===')
  const cm = profiles.filter(p => p.preset === 'CanvasMatte')
  for (const p of cm) {
    console.log(`  ${p.name}  (r380=${p.r380.toFixed(3)}, r440=${p.r440.toFixed(3)}, c1=${p.c1.toFixed(4)}, c2=${p.c2.toFixed(4)})`)
  }

  // ── H23a: ROC / AUC on non-metallic pairs ───────────────────────────────
  //
  // Metallic substrates excluded (different measurement geometry):
  //   Silverada, VibranceMetallic — neutral ramp curves identical to mode peers
  //   yet fail → separate mechanism, out of H23 scope.
  //
  // For every non-metallic pair: compute ΔSpread, label = fail/pass.
  // Sort descending by ΔSpread → sweep threshold → TPR, FPR → AUC (trapezoid).

  const METALLIC_RE = /Silverada|VibranceMetallic/i

  interface RocPoint { dSpread: number; isFail: boolean; ref: string; tgt: string }
  const rocPoints: RocPoint[] = []

  for (const pair of allPairs) {
    if (METALLIC_RE.test(pair.ref) || METALLIC_RE.test(pair.tgt)) continue
    const pA = byName.get(pair.ref)
    const pB = byName.get(pair.tgt)
    if (!pA || !pB) continue
    const dc1 = pB.c1 - pA.c1
    const dc2 = pB.c2 - pA.c2
    const dSpread = Math.sqrt(dc1 * dc1 + dc2 * dc2)
    const isFail  = failSet.has(`${pair.ref}↔${pair.tgt}`)
    rocPoints.push({ dSpread, isFail, ref: pair.ref, tgt: pair.tgt })
  }

  const totalFail = rocPoints.filter(p => p.isFail).length
  const totalPass = rocPoints.filter(p => !p.isFail).length
  console.log(`\n=== H23a ROC/AUC (non-metallic pairs only) ===`)
  console.log(`  Non-metallic pairs: ${rocPoints.length}  (fail=${totalFail}, pass=${totalPass})`)

  // Sort descending (high ΔSpread = predicted positive)
  rocPoints.sort((a, b) => b.dSpread - a.dSpread)

  // Sweep threshold
  let tp = 0, fp = 0
  let prevTPR = 0, prevFPR = 0
  let auc = 0
  const rocTable: Array<{ thr: number; tpr: number; fpr: number; tp: number; fp: number }> = []

  for (const pt of rocPoints) {
    if (pt.isFail) tp++; else fp++
    const tpr = totalFail > 0 ? tp / totalFail : 0
    const fpr = totalPass > 0 ? fp / totalPass : 0
    auc += (fpr - prevFPR) * (tpr + prevTPR) / 2
    prevTPR = tpr; prevFPR = fpr
    rocTable.push({ thr: pt.dSpread, tpr, fpr, tp, fp })
  }
  // Close trapezoid to (1,1)
  auc += (1 - prevFPR) * (1 + prevTPR) / 2

  console.log(`  AUC = ${auc.toFixed(4)}  (gate: > 0.75)`)
  console.log(`  H23a: ${auc > 0.75 ? 'PASS ✓' : 'FAIL ✗'}`)

  // Optimal threshold: max Youden J = TPR - FPR
  let bestJ = -1, bestThr = 0, bestTP = 0, bestFP = 0, bestTPR = 0, bestFPR = 0
  for (const row of rocTable) {
    const J = row.tpr - row.fpr
    if (J > bestJ) {
      bestJ = J; bestThr = row.thr
      bestTP = row.tp; bestFP = row.fp
      bestTPR = row.tpr; bestFPR = row.fpr
    }
  }
  const bestTN = totalPass - bestFP
  const bestFN = totalFail - bestTP
  console.log(`\n  Optimal threshold (Youden J=${bestJ.toFixed(3)}): ΔSpread > ${bestThr.toFixed(4)}`)
  console.log(`    TPR (sensitivity) = ${bestTPR.toFixed(3)}   FPR = ${bestFPR.toFixed(3)}`)
  console.log(`    TP=${bestTP}  FP=${bestFP}  TN=${bestTN}  FN=${bestFN}`)
  console.log(`    Precision = ${(bestTP/(bestTP+bestFP)).toFixed(3)}`)

  // Table: ROC sample points at key thresholds
  console.log('\n  ROC sample (sorted by ΔSpread desc):')
  console.log('  ΔSpread  fail?  cumTP  cumFP   TPR    FPR   pair')
  for (const pt of rocPoints) {
    const row = rocTable.find(r => r.thr === pt.dSpread)!
    const flag = pt.isFail ? 'FAIL' : 'pass'
    const refS = pt.ref.replace('BC_','').replace(/_P9000_.+/,'')
    const tgtS = pt.tgt.replace('BC_','').replace(/_P9000_.+/,'')
    console.log(
      `  ${pt.dSpread.toFixed(4).padStart(8)}  ${flag.padEnd(5)}` +
      `  ${row.tp.toString().padStart(5)}  ${row.fp.toString().padStart(5)}` +
      `  ${row.tpr.toFixed(3).padStart(6)}  ${row.fpr.toFixed(3).padStart(6)}` +
      `  ${refS} → ${tgtS}`
    )
  }

  // ── Non-metallic statistical re-summary ─────────────────────────────────
  const nmFail = rocPoints.filter(p => p.isFail).map(p => p.dSpread)
  const nmPass = rocPoints.filter(p => !p.isFail).map(p => p.dSpread)
  console.log('\n  Non-metallic ΔSpread distribution:')
  console.log(`    Failing: med=${med(nmFail).toFixed(4)}  P75=${p75(nmFail).toFixed(4)}  max=${Math.max(...nmFail).toFixed(4)}`)
  console.log(`    Passing: med=${med(nmPass).toFixed(4)}  P75=${p75(nmPass).toFixed(4)}  max=${Math.max(...nmPass).toFixed(4)}`)
}

main().catch(console.error)
