// frontend/scripts/experiments/h4_batch.ts
//
// H4 acceptance batch — D1 + S1 anchors (k=13) over every ordered same-chart pair
// of BC profiles (27 profiles → 702 directed pairs). Uses the current
// TransferView defaults: D1 residualRank=5, uvBandCount=4 (per-band UV clamp),
// D7 OBA-separation ON.
//
// Acceptance (H4): ≥ 80 % of pairs achieve median ΔE00 ≤ 1.5 AND P95 ≤ 3.0 on the
// held-out non-anchor patches.
//
// Output:
//   - stdout: aggregated summary + per-pair table headline
//   - data/cae-input/h4_batch.json (gitignored): full per-pair JSON
//   - suggested EXPERIMENTS.md row at the end
//
// Run: cd frontend && npx tsx scripts/experiments/h4_batch.ts

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
  extractOBAEmission,
  computeOBAFactorPerPatch,
  subtractOBA,
  addOBA,
} from '../../src/lib/predict/obaSeparator'
import { paperWPFromBrightestPatch } from '../../src/lib/predict/perLambdaAffine'
import { spectraToLab, deltaE00 } from '../../src/lib/colormath'
import { canonicalPrintMode, EpsonPreset } from '../../src/utils/printMode'
import { runCAETransfer, CAEWeights } from '../../src/lib/predict/cae'

import caeWeightsD7WCRW from '../../src/data/cae_weights_d7_WCRW.json'
import caeWeightsD7USFA from '../../src/data/cae_weights_d7_USFA.json'
import caeWeightsD7CanvasMatte from '../../src/data/cae_weights_d7_CanvasMatte.json'
import caeWeightsD7PremiumLuster from '../../src/data/cae_weights_d7_PremiumLuster.json'
import caeWeightsD7Full36 from '../../src/data/cae_weights_d7_full36.json'

const CAE_D7_BY_MODE: Partial<Record<EpsonPreset, CAEWeights>> = {
  WatercolorRadiantWhite: caeWeightsD7WCRW as unknown as CAEWeights,
  UltrasmoothFineArt: caeWeightsD7USFA as unknown as CAEWeights,
  CanvasMatte: caeWeightsD7CanvasMatte as unknown as CAEWeights,
  PremiumLuster: caeWeightsD7PremiumLuster as unknown as CAEWeights,
}
const CAE_D7_FULL36 = caeWeightsD7Full36 as unknown as CAEWeights

function pickCaeBundle(refPreset: string, tgtPreset: string): { weights: CAEWeights; mode: string; matched: boolean } {
  if (refPreset === tgtPreset && refPreset in CAE_D7_BY_MODE) {
    return { weights: CAE_D7_BY_MODE[refPreset as EpsonPreset]!, mode: refPreset, matched: true }
  }
  return { weights: CAE_D7_FULL36, mode: 'full36', matched: false }
}

const ROOT = path.resolve(process.cwd(), '..')
const PROFILES_ROOT = path.resolve(ROOT, 'data/profiles')
const OUT_JSON = path.resolve(process.cwd(), 'data/cae-input/h4_batch.json')
const MIN_MATCH = 100
const RANK = 5
const UV_BAND_COUNT = 4

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
    else if (/\.icm$/i.test(e.name) && /^BC_/.test(e.name)) out.push(full)
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

async function loadWrapped(filePath: string) {
  const buf = await fs.readFile(filePath)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await parseIcmFile({ arrayBuffer: async () => ab } as any)
  if (!r.hasSpectral) return null
  const name = path.basename(filePath).replace(/\.icm$/i, '')
  return {
    metadata: {
      full_name: name,
      brand: 'BC',
      series: name,
      printer: 'P9000',
      ink: 'mk',
      substrate: name,
      parsed_at: new Date().toISOString(),
    },
    raw: r.measurements,
    clean: r.measurements,
    has_spectral: true,
    patch_count: r.measurements.length,
    wavelengths: r.wavelengths,
  }
}

async function main() {
  const files = (await walk(PROFILES_ROOT)).sort()
  console.log(`Loading ${files.length} BC profiles…`)
  const matrices: { name: string; mx: ReturnType<typeof loadProfileMatrix> }[] = []
  for (const f of files) {
    try {
      const wrapped = await loadWrapped(f)
      if (!wrapped) continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mx = loadProfileMatrix(wrapped as any)
      matrices.push({ name: wrapped.metadata.full_name, mx })
    } catch (e) {
      console.error(`[skip] ${path.basename(f)}:`, e instanceof Error ? e.message : e)
    }
  }
  console.log(`Loaded ${matrices.length} profiles\n`)

  interface PairRow {
    ref: string
    target: string
    refPreset: string
    tgtPreset: string
    sameMode: boolean
    n: number
    median: number
    p95: number
    max: number
    clampedBands: number
    // CAE_D7 k=0 (paper-only) result for the same pair.
    cae_median: number
    cae_p95: number
    cae_mode: string
    cae_modeMatched: boolean
  }
  const rows: PairRow[] = []

  const totalPairs = matrices.length * (matrices.length - 1)
  let done = 0
  const t0 = Date.now()
  for (let i = 0; i < matrices.length; i++) {
    for (let j = 0; j < matrices.length; j++) {
      if (i === j) continue
      const A = matrices[i].mx
      const B = matrices[j].mx
      const al = alignProfiles(A, B)
      if (al.exactCount < MIN_MATCH) {
        done++
        continue
      }
      const N = al.N
      const L = A.L
      const X_A = al.X_A
      const X_B = al.X_B
      const D = al.D

      const tgtForAnchors = {
        X: X_B, D, channels: 3 as const, N, L,
        wavelengths: A.wavelengths, sampleIds: al.sampleIds, droppedCount: 0,
      }
      const anchors = pickHeuristicAnchors(tgtForAnchors)
      const anchorIdx = anchors.meta?.chosenIdx as number[]

      // Find paper white by exact RGB(255,255,255) device-value lookup.
      let paperRowIdx = anchorIdx[0] // fallback if chart has no pure-white patch
      for (let k = 0; k < N; k++) {
        if (D[k * 3] === 255 && D[k * 3 + 1] === 255 && D[k * 3 + 2] === 255) {
          paperRowIdx = k
          break
        }
      }

      // D7 OBA-clean both matrices.
      const paperSpecA = Array.from(X_A.subarray(paperRowIdx * L, paperRowIdx * L + L))
      const paperSpecB = Array.from(X_B.subarray(paperRowIdx * L, paperRowIdx * L + L))
      const emA = extractOBAEmission(paperSpecA)
      const emB = extractOBAEmission(paperSpecB)
      const fA = computeOBAFactorPerPatch(X_A, L, paperRowIdx)
      const fB = computeOBAFactorPerPatch(X_B, L, paperRowIdx)
      const X_A_clean = subtractOBA(X_A, L, fA, emA.emission)
      const X_B_clean = subtractOBA(X_B, L, fB, emB.emission)

      const paperWP = paperWPFromBrightestPatch(new Float64Array(paperSpecB), 1, L, A.wavelengths[0])

      const result = runPaperRatioResidualTransfer({
        X_A: X_A_clean,
        X_B: X_B_clean,
        D,
        sampleIds: al.sampleIds,
        anchorIdx,
        paperRowIdx,
        L,
        paperWP,
        refProfile: matrices[i].name,
        targetProfile: matrices[j].name,
        residualRank: RANK,
        uvBandCount: UV_BAND_COUNT,
      })
      // Add target's emission back.
      const X_pred_final = addOBA(result.X_pred, L, fB, emB.emission)

      // Evaluate non-anchor patches.
      const anchorSet = new Set(anchorIdx)
      const des: number[] = []
      for (let k = 0; k < N; k++) {
        if (anchorSet.has(k)) continue
        const a = Array.from(X_pred_final.subarray(k * L, k * L + L))
        const b = Array.from(X_B.subarray(k * L, k * L + L))
        const la = spectraToLab(a)
        const lb = spectraToLab(b)
        des.push(deltaE00(la[0], la[1], la[2], lb[0], lb[1], lb[2]))
      }
      let refPreset = '?'
      let tgtPreset = '?'
      try {
        refPreset = canonicalPrintMode(matrices[i].name)
        tgtPreset = canonicalPrintMode(matrices[j].name)
      } catch {
        // Unknown media — keep '?'.
      }

      // CAE_D7 k=0 run on the same aligned matrices. Per-mode bundle when both
      // profiles share an Epson preset, otherwise the 36-profile full pool.
      const caeBundle = pickCaeBundle(refPreset, tgtPreset)
      let cae_median = NaN
      let cae_p95 = NaN
      try {
        const cae = runCAETransfer({
          weights: caeBundle.weights,
          X_A,
          X_B,
          D,
          paper_A: paperSpecA,
          paper_B: paperSpecB,
          sampleIds: al.sampleIds,
          anchorIdx,
          paperRowIdx,
          L,
          paperWP,
          refProfile: matrices[i].name,
          targetProfile: matrices[j].name,
        })
        const caeDes: number[] = []
        for (let k = 0; k < N; k++) {
          if (anchorSet.has(k)) continue
          const a = Array.from(cae.X_pred.subarray(k * L, k * L + L))
          const b = Array.from(X_B.subarray(k * L, k * L + L))
          const la = spectraToLab(a)
          const lb = spectraToLab(b)
          caeDes.push(deltaE00(la[0], la[1], la[2], lb[0], lb[1], lb[2]))
        }
        cae_median = median(caeDes)
        cae_p95 = percentile(caeDes, 95)
      } catch {
        // CAE failure (rare) — leave NaN.
      }

      rows.push({
        ref: matrices[i].name,
        target: matrices[j].name,
        refPreset,
        tgtPreset,
        sameMode: refPreset === tgtPreset && refPreset !== '?',
        n: des.length,
        median: median(des),
        p95: percentile(des, 95),
        max: Math.max(...des),
        clampedBands: result.fit.clampedBands.length,
        cae_median,
        cae_p95,
        cae_mode: caeBundle.mode,
        cae_modeMatched: caeBundle.matched,
      })
      done++
      if (done % 50 === 0) {
        const dt = (Date.now() - t0) / 1000
        const eta = (dt / done) * (totalPairs - done)
        console.log(`  ${done}/${totalPairs}  ${dt.toFixed(0)}s elapsed, ~${eta.toFixed(0)}s left`)
      }
    }
  }

  const medians = rows.map((r) => r.median)
  const p95s = rows.map((r) => r.p95)
  const passMedian = rows.filter((r) => r.median <= 1.5).length
  const passP95 = rows.filter((r) => r.p95 <= 3.0).length
  const passBoth = rows.filter((r) => r.median <= 1.5 && r.p95 <= 3.0).length
  const summary = {
    pairs: rows.length,
    median_of_medians: median(medians),
    median_of_p95s: median(p95s),
    fraction_median_le_1_5: passMedian / rows.length,
    fraction_p95_le_3_0: passP95 / rows.length,
    fraction_h4_pass: passBoth / rows.length,
    rank: RANK,
    uvBandCount: UV_BAND_COUNT,
    d7: true,
    anchors: 'S1 k=13',
  }
  console.log('\n=== H4 batch summary (D1 + S1 + D7 + rank=5 + UV clamp) ===')
  console.log(`  pairs              : ${summary.pairs}`)
  console.log(`  median-of-medians  : ${summary.median_of_medians.toFixed(3)} ΔE00`)
  console.log(`  median-of-P95s     : ${summary.median_of_p95s.toFixed(3)} ΔE00`)
  console.log(`  fraction median≤1.5: ${(summary.fraction_median_le_1_5 * 100).toFixed(1)}%`)
  console.log(`  fraction P95≤3.0   : ${(summary.fraction_p95_le_3_0 * 100).toFixed(1)}%`)
  console.log(`  fraction H4 pass   : ${(summary.fraction_h4_pass * 100).toFixed(1)}%   (acceptance ≥ 80 %)`)

  // Same-mode vs cross-mode breakdown.
  const sameMode = rows.filter((r) => r.sameMode)
  const crossMode = rows.filter((r) => !r.sameMode)
  const passBothFn = (xs: PairRow[]) =>
    xs.length ? xs.filter((r) => r.median <= 1.5 && r.p95 <= 3.0).length / xs.length : 0
  console.log('\nSame-mode vs cross-mode breakdown:')
  console.log(
    `  same-mode  pairs=${sameMode.length}  med-of-meds=${
      sameMode.length ? median(sameMode.map((r) => r.median)).toFixed(3) : 'n/a'
    }  H4 pass=${(passBothFn(sameMode) * 100).toFixed(1)}%`,
  )
  console.log(
    `  cross-mode pairs=${crossMode.length}  med-of-meds=${
      crossMode.length ? median(crossMode.map((r) => r.median)).toFixed(3) : 'n/a'
    }  H4 pass=${(passBothFn(crossMode) * 100).toFixed(1)}%`,
  )

  // CAE_D7 k=0 breakdown (per-mode picker, paper-only prediction).
  const caeRows = rows.filter((r) => Number.isFinite(r.cae_median))
  const caePassMedian = caeRows.filter((r) => r.cae_median <= 1.5).length
  const caePassBoth = caeRows.filter((r) => r.cae_median <= 1.5 && r.cae_p95 <= 3.0).length
  const caeSame = caeRows.filter((r) => r.sameMode)
  const caeCross = caeRows.filter((r) => !r.sameMode)
  console.log('\nCAE_D7 k=0 (paper-only, per-mode picker when same preset):')
  console.log(
    `  all (n=${caeRows.length})       med-of-meds=${
      caeRows.length ? median(caeRows.map((r) => r.cae_median)).toFixed(3) : 'n/a'
    }  median≤1.5=${(caePassMedian / caeRows.length * 100).toFixed(1)}%  pass=${(caePassBoth / caeRows.length * 100).toFixed(1)}%`,
  )
  const caeSamePass = caeSame.length
    ? caeSame.filter((r) => r.cae_median <= 1.5 && r.cae_p95 <= 3.0).length / caeSame.length
    : 0
  console.log(
    `  same-mode (n=${caeSame.length})  med-of-meds=${
      caeSame.length ? median(caeSame.map((r) => r.cae_median)).toFixed(3) : 'n/a'
    }  pass=${(caeSamePass * 100).toFixed(1)}%`,
  )
  console.log(
    `  cross-mode (n=${caeCross.length}) med-of-meds=${
      caeCross.length ? median(caeCross.map((r) => r.cae_median)).toFixed(3) : 'n/a'
    }  pass=${((caeCross.length ? caeCross.filter((r) => r.cae_median <= 1.5 && r.cae_p95 <= 3.0).length / caeCross.length : 0) * 100).toFixed(1)}%`,
  )

  await fs.mkdir(path.dirname(OUT_JSON), { recursive: true })
  await fs.writeFile(
    OUT_JSON,
    JSON.stringify({ summary, rows: rows.sort((a, b) => b.median - a.median) }, null, 2),
  )
  console.log(`\nWrote ${path.relative(ROOT, OUT_JSON)}`)

  console.log('\nTop 5 worst pairs (highest median):')
  const worst = rows.sort((a, b) => b.median - a.median).slice(0, 5)
  for (const r of worst) {
    console.log(`  ${r.ref.padEnd(45)} → ${r.target.padEnd(45)}  med=${r.median.toFixed(2)}  P95=${r.p95.toFixed(2)}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
