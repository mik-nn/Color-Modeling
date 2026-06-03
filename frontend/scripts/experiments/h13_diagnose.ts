// frontend/scripts/experiments/h13_diagnose.ts
//
// Diagnose where H13b / H13c P95 errors live on OBA-disparate pairs.
//
//   1. Correlate per-pair P95 with `obaMismatch`.
//   2. For the worst-P95 pairs, compute per-band ΔE distribution to find which
//      wavelengths still carry the bulk of the residual.
//   3. Identify which patch device-coordinates (e.g. dark inks where R(380) ≈ 0)
//      dominate the worst-5% of ΔE on those pairs.
//   4. Propose a minimal M0+M2 measurement protocol that targets those patches.
//
// Run: cd frontend && npx tsx scripts/experiments/h13_diagnose.ts

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).DOMParser = jsdom.window.DOMParser

import { parseIcmFile } from '../../src/lib/parsers/icmParser'
import { detectOBA, obaMismatch } from '../../src/lib/predict/oba'
import { runPaperRatioResidualTransfer } from '../../src/lib/predict/paperRatioResidual'
import { paperWPFromBrightestPatch } from '../../src/lib/predict/perLambdaAffine'
import { spectraToLab, deltaE00 } from '../../src/lib/colormath'
import { pickHeuristicAnchors } from '../../src/lib/sampling/heuristic'
import { canonicalPrintMode } from '../../src/utils/printMode'

const ROOT = path.resolve(process.cwd(), '..')
const PROFILES_ROOT = path.resolve(ROOT, 'data/profiles')
const JSON_IN = path.resolve(process.cwd(), 'data/cae-input/h13_m0m2.json')
const TOP_N = 6 // top-N worst-P95 pairs to dissect

const SKIP_PROFILES = new Set(['BC_AllureAq_P9000_MK_EMP'])

interface PatchData {
  sampleId: string
  rgb: [number, number, number]
  m0: number[]
  m2: number[] | null
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
      m2: m.spectra_m2 && m.spectra_m2.length === m.spectra.length ? m.spectra_m2 : null,
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

async function main() {
  // ── 1. Pull existing h13 batch JSON ────────────────────────────────────────
  const batch = JSON.parse(await fs.readFile(JSON_IN, 'utf8')) as {
    rows: Array<{
      ref: string
      target: string
      preset: string
      obaMismatch: number
      base_median: number
      base_p95: number
      h13b_median: number
      h13b_p95: number
      h13c_median: number
      h13c_p95: number
    }>
  }
  console.log(`Loaded ${batch.rows.length} pairs from h13_m0m2.json`)

  // ── 2. Correlate P95 with OBA mismatch ─────────────────────────────────────
  const rows = batch.rows
  const mismatches = rows.map((r) => r.obaMismatch)
  const baseP95s = rows.map((r) => r.base_p95)
  const h13bP95s = rows.map((r) => r.h13b_p95)
  function pearson(xs: number[], ys: number[]) {
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length
    const my = ys.reduce((a, b) => a + b, 0) / ys.length
    let num = 0, dx = 0, dy = 0
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - mx) * (ys[i] - my)
      dx += (xs[i] - mx) ** 2
      dy += (ys[i] - my) ** 2
    }
    return num / Math.sqrt(dx * dy)
  }
  console.log(`\nPearson r(obaMismatch, base P95)  = ${pearson(mismatches, baseP95s).toFixed(3)}`)
  console.log(`Pearson r(obaMismatch, H13b P95)  = ${pearson(mismatches, h13bP95s).toFixed(3)}`)

  // Bucket by mismatch.
  const lowB = rows.filter((r) => r.obaMismatch < 0.05)
  const midB = rows.filter((r) => r.obaMismatch >= 0.05 && r.obaMismatch < 0.10)
  const highB = rows.filter((r) => r.obaMismatch >= 0.10 && r.obaMismatch < 0.15)
  const extremeB = rows.filter((r) => r.obaMismatch >= 0.15)
  function summary(rs: typeof rows, label: string) {
    if (rs.length === 0) {
      console.log(`  ${label.padEnd(28)} n=0`)
      return
    }
    const bm = median(rs.map((r) => r.base_median))
    const bp = median(rs.map((r) => r.base_p95))
    const hm = median(rs.map((r) => r.h13b_median))
    const hp = median(rs.map((r) => r.h13b_p95))
    const cm = median(rs.map((r) => r.h13c_median))
    const cp = median(rs.map((r) => r.h13c_p95))
    console.log(`  ${label.padEnd(28)} n=${rs.length.toString().padStart(3)}  base ${bm.toFixed(2)}/${bp.toFixed(2)}  H13b ${hm.toFixed(2)}/${hp.toFixed(2)}  H13c ${cm.toFixed(2)}/${cp.toFixed(2)}  (med/P95)`)
  }
  console.log('\nBy OBA-mismatch bucket:')
  summary(lowB, 'mismatch < 0.05')
  summary(midB, '0.05 ≤ mismatch < 0.10')
  summary(highB, '0.10 ≤ mismatch < 0.15')
  summary(extremeB, 'mismatch ≥ 0.15')

  // ── 3. Re-run worst-P95 pairs with per-band ΔE diagnostics ─────────────────
  // Pick top-N worst-P95 pairs by baseline P95.
  const worst = [...rows].sort((a, b) => b.base_p95 - a.base_p95).slice(0, TOP_N)
  console.log(`\nTop-${TOP_N} worst-P95 pairs (baseline):`)
  for (const r of worst) console.log(`  P95=${r.base_p95.toFixed(2)}  med=${r.base_median.toFixed(2)}  Δoba=${r.obaMismatch.toFixed(2)}  ${r.preset.slice(0, 14)} ${r.ref.slice(0, 22)} → ${r.target.slice(0, 22)}`)

  // Load profiles needed.
  const files = await walk(PROFILES_ROOT)
  const profMap = new Map<string, ProfileBundle>()
  for (const f of files) {
    const p = await loadProfile(f)
    if (p) profMap.set(p.name, p)
  }

  console.log('\n=== Per-band ΔE breakdown of worst-P95 pairs (baseline D7) ===')
  console.log(`${'pair'.padEnd(60)} ${'band wl(nm)'.padStart(11)}  worst-5%-mean ΔE`)
  for (const pair of worst) {
    const A = profMap.get(pair.ref)
    const B = profMap.get(pair.target)
    if (!A || !B) continue
    // Build aligned matrices.
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
    for (let i = 0; i < N; i++) {
      for (let l = 0; l < L; l++) {
        X_A[i * L + l] = aRows[i].m0[l]
        X_B[i * L + l] = bRows[i].m0[l]
      }
      D[i * 3] = bRows[i].rgb[0]
      D[i * 3 + 1] = bRows[i].rgb[1]
      D[i * 3 + 2] = bRows[i].rgb[2]
    }
    const Baligned = {
      X: X_B,
      D,
      channels: 3 as const,
      N,
      L,
      wavelengths: Array.from({ length: L }, (_, k) => 380 + k * 10),
      sampleIds: shared,
      droppedCount: 0,
    }
    const anchors = pickHeuristicAnchors(Baligned)
    const anchorIdx = anchors.meta?.chosenIdx as number[]
    const paperRowIdx = anchorIdx[0]
    const paperSpecB = new Float64Array(L)
    for (let l = 0; l < L; l++) paperSpecB[l] = X_B[paperRowIdx * L + l]
    const paperWP = paperWPFromBrightestPatch(paperSpecB, 1, L, 380)
    // Run plain D1 (≈ baseline; we already know D7 ≈ plain).
    const result = runPaperRatioResidualTransfer({
      X_A,
      X_B,
      D,
      sampleIds: shared,
      anchorIdx,
      paperRowIdx,
      L,
      paperWP,
      refProfile: A.name,
      targetProfile: B.name,
      residualRank: 5,
      uvBandCount: 4,
    })
    const X_pred = result.X_pred
    const anchorSet = new Set(anchorIdx)
    // Per-band squared error means, plus per-patch ΔE for worst-5% identification.
    const sqErrSum = new Float64Array(L)
    const sqErrN = new Int32Array(L)
    const patchDe: { i: number; de: number; rgb: [number, number, number] }[] = []
    for (let i = 0; i < N; i++) {
      if (anchorSet.has(i)) continue
      let pred = new Array<number>(L)
      let truth = new Array<number>(L)
      for (let l = 0; l < L; l++) {
        const p = X_pred[i * L + l]
        const t = X_B[i * L + l]
        pred[l] = p
        truth[l] = t
        sqErrSum[l] += (p - t) ** 2
        sqErrN[l]++
      }
      const lp = spectraToLab(pred)
      const lt = spectraToLab(truth)
      patchDe.push({ i, de: deltaE00(lp[0], lp[1], lp[2], lt[0], lt[1], lt[2]), rgb: [D[i * 3], D[i * 3 + 1], D[i * 3 + 2]] })
    }
    // Per-band RMS, sort desc.
    const bandRms = Array.from({ length: L }, (_, l) => ({
      band: l,
      wl: 380 + l * 10,
      rms: Math.sqrt(sqErrSum[l] / sqErrN[l]),
    })).sort((a, b) => b.rms - a.rms)
    console.log(`\n  ${pair.ref.slice(0, 36)} → ${pair.target.slice(0, 36)}`)
    console.log(`    top-5 worst bands (per-patch reflectance RMS):`)
    for (const b of bandRms.slice(0, 5)) console.log(`      λ=${b.wl} nm  RMS=${b.rms.toFixed(4)}`)
    // Worst-5% patches.
    patchDe.sort((a, b) => b.de - a.de)
    const worstPct = Math.max(1, Math.floor(patchDe.length * 0.05))
    const worstPatches = patchDe.slice(0, worstPct)
    const meanWorst = worstPatches.reduce((a, b) => a + b.de, 0) / worstPatches.length
    console.log(`    worst-5%-mean ΔE = ${meanWorst.toFixed(2)}  (${worstPatches.length} patches)`)
    // RGB distribution of worst patches.
    const rgbSum = [0, 0, 0]
    for (const w of worstPatches) {
      rgbSum[0] += w.rgb[0]
      rgbSum[1] += w.rgb[1]
      rgbSum[2] += w.rgb[2]
    }
    const rgbMean = rgbSum.map((v) => Math.round(v / worstPatches.length))
    console.log(`    worst-patches mean RGB ≈ (${rgbMean[0]}, ${rgbMean[1]}, ${rgbMean[2]})`)
    // Show first 3 worst patches' RGB.
    console.log(`    examples: ${worstPatches.slice(0, 3).map((w) => `RGB(${w.rgb.map((v) => v.toString().padStart(3)).join(',')})=${w.de.toFixed(2)}`).join('  ')}`)
  }

  // ── 4. Propose minimal protocol ─────────────────────────────────────────────
  console.log('\n=== Diagnostic summary ===')
  console.log('  - P95 ↔ OBA-mismatch correlation reported above.')
  console.log('  - Per-band RMS peaks tell us which wavelengths carry the residual.')
  console.log('  - Worst-5%-patch RGB tells us which ink-coverage regions break.')
  console.log('  - These three drive the minimal-measurement protocol proposal (next step).')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
