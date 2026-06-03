// frontend/scripts/experiments/h14_ink_diagnostic.ts
//
// Deeper ink-physics diagnostic. We rejected H14 (red-band substrate-ink
// interaction) as a framing — too vague. This script collects hard evidence to
// distinguish four candidate causes of the 640-680 nm residual on
// DecorMatte ↔ {800M, ChromataWhite, Lyve, BelgianLinen}:
//
//   (A) Magenta/cyan ink fluorescence. If `M0 − M2 ≠ 0` at λ > 500 nm on
//       any patch, some ink also fluoresces (not just paper OBA).
//   (B) Gamut-edge hue overflow. If the worst-patch RGBs cluster near the
//       cube corners (saturated colours) → ink-loading saturation.
//   (C) Within-profile D1 ceiling. If a leave-one-out anchor prediction
//       INSIDE one profile already has > 0.5 ΔE residual at 660 nm, then
//       the cross-substrate residual is NOT a substrate issue at all —
//       it's D1's own representational error.
//   (D) Inter-channel dot-gain coupling. If two profiles agree on
//       1-ink patches but disagree on 2- and 3-ink overprints, the
//       difference is in the substrate-mediated dot-gain interaction.
//
// Output: per-band M0-M2 means per profile, anchor-LOO error spectra,
// worst-patch ink-channel breakdown.
//
// Run: cd frontend && npx tsx scripts/experiments/h14_ink_diagnostic.ts

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

const ROOT = path.resolve(process.cwd(), '..')
const PROFILES_ROOT = path.resolve(ROOT, 'data/profiles/CanvasMatte')

const TARGETS = [
  'BC_DecorMatte_P9000_mk_CanvasMatte.icm',
  'BC_800M_P9000_mk_CanvasMatte.icm',
  'BC_ChromataWhite_P9000_mk_CanvasMatte.icm',
  'BC_Lyve_P9000_mk_CanvasMatte.icm',
  'BC_BelgianLinen_P9000_mk_CanvasMatte.icm',
]

interface PatchData {
  sampleId: string
  rgb: [number, number, number]
  m0: number[]
  m2: number[] | null
}
interface ProfileBundle {
  name: string
  patches: PatchData[]
  byId: Map<string, PatchData>
}

async function loadProfile(filePath: string): Promise<ProfileBundle | null> {
  const name = path.basename(filePath).replace(/\.icm$/i, '')
  const buf = await fs.readFile(filePath)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await parseIcmFile({ arrayBuffer: async () => ab } as any)
  if (!r.hasSpectral) return null
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
  return { name, patches, byId }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function ramp1Patches(patches: PatchData[]): { c: PatchData[]; m: PatchData[]; y: PatchData[]; k: PatchData[] } {
  // 1-ink ramps in Epson RGB: cyan = R=0 G=255 B=255 ramp (R varying);
  // RGB encoding: subtract from 255. A "cyan only" patch has G=B=255 and R varies.
  const c = patches.filter((p) => p.rgb[1] === 255 && p.rgb[2] === 255)
  const m = patches.filter((p) => p.rgb[0] === 255 && p.rgb[2] === 255)
  const y = patches.filter((p) => p.rgb[0] === 255 && p.rgb[1] === 255)
  const k = patches.filter((p) => p.rgb[0] === p.rgb[1] && p.rgb[1] === p.rgb[2])
  return { c, m, y, k }
}

async function main() {
  const profiles: ProfileBundle[] = []
  for (const f of TARGETS) {
    const p = await loadProfile(path.join(PROFILES_ROOT, f))
    if (p) profiles.push(p)
  }
  const L = profiles[0]?.patches[0]?.m0.length ?? 36
  const wls = Array.from({ length: L }, (_, l) => 380 + l * 10)

  // ── (A) Magenta/cyan ink fluorescence check: M0-M2 per band, averaged over
  // patches with high magenta content (G low, R high) or high cyan (R low).
  console.log(`=== (A) Ink fluorescence probe: mean (M0 − M2) per band ===`)
  console.log(`        Significant non-zero at λ > 500 nm = some ink itself fluoresces.\n`)
  const reportBands = [380, 410, 440, 470, 500, 540, 580, 620, 660, 700]
  console.log(`profile / patch group`.padEnd(50) + reportBands.map((b) => `${b}nm`.padStart(8)).join(''))
  for (const prof of profiles) {
    const paper = prof.patches.find((p) => p.rgb[0] === 255 && p.rgb[1] === 255 && p.rgb[2] === 255)
    if (!paper || !paper.m2) continue
    const usable = prof.patches.filter((p) => p.m2 !== null)
    function emissionMean(filter: (p: PatchData) => boolean, label: string) {
      const sub = usable.filter(filter)
      if (sub.length === 0) return
      const e = new Array<number>(L).fill(0)
      for (const p of sub) {
        for (let l = 0; l < L; l++) e[l] += p.m0[l] - p.m2![l]
      }
      for (let l = 0; l < L; l++) e[l] /= sub.length
      const cells = reportBands.map((b) => {
        const idx = Math.round((b - 380) / 10)
        return e[idx].toFixed(4).padStart(8)
      })
      console.log(`${(prof.name.slice(0, 30) + ' [' + label + '] n=' + sub.length).padEnd(50)}${cells.join('')}`)
    }
    emissionMean((p) => p.rgb[0] === 255 && p.rgb[1] === 255 && p.rgb[2] === 255, 'paper')
    emissionMean((p) => p.rgb[1] <= 64 && p.rgb[0] >= 192, 'magenta-heavy')
    emissionMean((p) => p.rgb[0] <= 64 && p.rgb[1] >= 192, 'cyan-heavy')
    emissionMean((p) => p.rgb[2] <= 64 && p.rgb[0] >= 192 && p.rgb[1] >= 192, 'yellow-heavy')
    emissionMean((p) => p.rgb[0] <= 64 && p.rgb[1] <= 64 && p.rgb[2] >= 192, 'red-heavy (M+Y)')
    console.log('')
  }

  // ── (C) Within-profile anchor LOO: how well does D1 reproduce its own non-anchor
  // patches when trained on its own anchors? Answers: is 660 nm residual a model
  // ceiling on these substrates, or is it cross-substrate-specific?
  console.log(`\n=== (C) Within-profile D1 ceiling (anchors → all other patches, same profile) ===`)
  console.log(`        Median ΔE00, P95 ΔE00, per-λ RMS at 380 / 440 / 660 / 700 nm.\n`)
  for (const prof of profiles) {
    const patches = prof.patches.filter((p) => p.rgb[0] !== undefined)
    const N = patches.length
    const X = new Float64Array(N * L)
    const D = new Float64Array(N * 3)
    const sampleIds: string[] = []
    for (let i = 0; i < N; i++) {
      sampleIds.push(patches[i].sampleId)
      for (let l = 0; l < L; l++) X[i * L + l] = patches[i].m0[l]
      D[i * 3] = patches[i].rgb[0]
      D[i * 3 + 1] = patches[i].rgb[1]
      D[i * 3 + 2] = patches[i].rgb[2]
    }
    const Baligned = { X, D, channels: 3 as const, N, L, wavelengths: wls, sampleIds, droppedCount: 0 }
    const anchors = pickHeuristicAnchors(Baligned)
    const anchorIdx = anchors.meta?.chosenIdx as number[]
    const paperRowIdx = anchorIdx[0]
    const paperSpec = new Float64Array(L)
    for (let l = 0; l < L; l++) paperSpec[l] = X[paperRowIdx * L + l]
    const paperWP = paperWPFromBrightestPatch(paperSpec, 1, L, 380)
    // X_A = X (self), X_B = X — "transfer A → A" predicts each patch from itself.
    // This isolates D1's representational ceiling on this profile alone.
    const result = runPaperRatioResidualTransfer({
      X_A: X,
      X_B: X,
      D,
      sampleIds,
      anchorIdx,
      paperRowIdx,
      L,
      paperWP,
      refProfile: prof.name,
      targetProfile: prof.name,
      residualRank: 5,
      uvBandCount: 4,
    })
    const anchorSet = new Set(anchorIdx)
    const des: number[] = []
    const sqErr = new Float64Array(L)
    const cnt = new Int32Array(L)
    for (let i = 0; i < N; i++) {
      if (anchorSet.has(i)) continue
      const pred = new Array<number>(L)
      const truth = new Array<number>(L)
      for (let l = 0; l < L; l++) {
        pred[l] = result.X_pred[i * L + l]
        truth[l] = X[i * L + l]
        sqErr[l] += (pred[l] - truth[l]) ** 2
        cnt[l]++
      }
      const lp = spectraToLab(pred)
      const lt = spectraToLab(truth)
      des.push(deltaE00(lp[0], lp[1], lp[2], lt[0], lt[1], lt[2]))
    }
    const rmsAt = (wl: number) => {
      const idx = Math.round((wl - 380) / 10)
      return cnt[idx] > 0 ? Math.sqrt(sqErr[idx] / cnt[idx]) : 0
    }
    const sortedDe = [...des].sort((a, b) => a - b)
    const p95 = sortedDe[Math.floor(sortedDe.length * 0.95)]
    console.log(`  ${prof.name.padEnd(40)} med=${median(des).toFixed(2)}  P95=${p95.toFixed(2)}  ` +
      `RMS@380=${rmsAt(380).toFixed(4)}  @440=${rmsAt(440).toFixed(4)}  @660=${rmsAt(660).toFixed(4)}  @700=${rmsAt(700).toFixed(4)}`)
  }

  // ── (D) 1-ink ramp consistency. For each profile, dump the 660 nm reflectance
  // along the C / M / Y / K ramps. Two profiles that disagree only on 3-ink
  // overprints will agree on 1-ink ramps.
  console.log(`\n=== (D) 660 nm reflectance along single-ink ramps (Epson RGB encoding) ===`)
  for (const prof of profiles) {
    const r = ramp1Patches(prof.patches)
    console.log(`  ${prof.name}`)
    function dump(label: string, list: PatchData[], sortBy: 'r' | 'g' | 'b') {
      const sorted = [...list].sort((a, b) => a.rgb[sortBy === 'r' ? 0 : sortBy === 'g' ? 1 : 2] - b.rgb[sortBy === 'r' ? 0 : sortBy === 'g' ? 1 : 2])
      const cells = sorted.slice(0, 8).map((p) => {
        const v = p.m0[Math.round((660 - 380) / 10)]
        const idx = sortBy === 'r' ? p.rgb[0] : sortBy === 'g' ? p.rgb[1] : p.rgb[2]
        return `${idx}:${v.toFixed(3)}`
      })
      console.log(`    ${label.padEnd(8)} (n=${list.length}): ${cells.join(' ')}`)
    }
    dump('cyan', r.c, 'r')
    dump('magenta', r.m, 'g')
    dump('yellow', r.y, 'b')
    dump('neutral', r.k, 'r')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
