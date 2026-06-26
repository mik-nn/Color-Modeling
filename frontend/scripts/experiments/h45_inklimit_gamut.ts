// H45 — Ink-limit gamut-volume tradeoff
//
// Tests whether an INTRINSIC ink limit (chroma-maximum t* per colorant ramp)
// removes the unpredictable gamut-edge overflow/holdout patches while barely
// shrinking the Lab gamut volume, and makes the residual ink behaviour
// predictable both by a within-profile forward model and by cross-substrate D1.
//
// The limit is derived from each profile's OWN ramp chroma curve — never from
// transfer error (H45d then checks whether it coincides with the failure tail).
//
// Stage 1 (ALL profiles, every ink system): detect ink limits + signFlipScore +
//   spreadCurv; gamut V_full vs V_lim (ΔV%); forward-model residual full vs lim.
//   Rank by signFlipScore → auto-select the problematic cohort.
// Stage 2 (problematic cohort, same-mode pairs, pre-filtered): D1 transfer with
//   the full test set vs the ≤-limit test set → Δpass-rate; over-limit recall of
//   the worst-5% patches.
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h45_inklimit_gamut.ts"

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).DOMParser = jsdom.window.DOMParser
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).XMLSerializer = jsdom.window.XMLSerializer

import { parseIcmFile } from '../../src/lib/parsers/icmParser'
import { loadProfileMatrix, alignProfiles, type ProfileMatrices } from '../../src/lib/dataset/matrix'
import { pickCoverageAnchors } from '../../src/lib/sampling/heuristic'
import { canonicalPrintMode } from '../../src/utils/printMode'
import { runPaperRatioResidualTransfer } from '../../src/lib/predict/paperRatioResidual'
import { paperWPFromBrightestPatch } from '../../src/lib/predict/perLambdaAffine'
import { extractOBAEmission, computeOBAFactorPerPatch, subtractOBA, addOBA } from '../../src/lib/predict/obaSeparator'
import { computeSpreadCurv, classifyPairCompatibility, type SpreadCurv } from '../../src/lib/predict/spreadCurv'
import { spectraToXYZ, spectraToLab, deltaE00 } from '../../src/lib/colormath'
import { toCMY, type DeviceValue, type ProfileData, type WhitePointXYZ } from '../../src/types'
import {
  detectInkLimits, isOverLimit, type InkLimits, type PatchSample, type RampName,
} from '../../src/lib/analyzers/inkLimitChroma'
import { gamutHullVolume, maxChromaPerHueBin } from '../../src/lib/analyzers/gamutVolume'
import { fitForwardRamp, type SpectralRampPoint } from '../../src/lib/analyzers/forwardRampModel'

const REPO = path.resolve(process.cwd(), '..')
const P9000_DIR = '/mnt/e/PET/LinkedInPosts/surecolor-p9000'
const L = 36, D1_RANK = 5, D1_UV = 4
const MAX_PAIRS = 60

const EXCLUDE_RE = /Silverada|VibranceMetallic|Metallic|AllureAq/i
const isExcluded = (name: string) => EXCLUDE_RE.test(name)

const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const p95 = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.round(0.95 * (s.length - 1)))] }
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

interface PrinterDef { id: string; label: string; dir: string }
const PRINTERS: PrinterDef[] = [
  { id: 'epson_p9000', label: 'Epson P9000', dir: P9000_DIR },
  { id: 'canon_g2470', label: 'Canon G2470', dir: path.join(REPO, 'data/profiles/Canon G2470') },
  { id: 'canon_g1430', label: 'Canon G1430', dir: path.join(REPO, 'data/profiles/G1430') },
  { id: 'epson_p9900', label: 'Epson P9900', dir: path.join(REPO, 'data/profiles/stylus-pro-9900') },
  { id: 'canon_ipf4100', label: 'Canon iPF4100', dir: path.join(REPO, 'data/profiles/ipf-pro-4100/extracted') },
  { id: 'canon_ipf8100', label: 'Canon iPF8100', dir: path.join(REPO, 'data/profiles/ipf8100') },
  { id: 'epson_sp7900', label: 'Epson SP7900 MOAB', dir: path.join(REPO, 'data/profiles/Epson Stylus Pro 7900 MOAB ICC Profiles') },
  { id: 'epson_sp9900', label: 'Epson SP9900 MOAB', dir: path.join(REPO, 'data/profiles/Epson Stylus Pro 9900 MOAB ICC Profiles') },
  { id: 'epson_p7000', label: 'Epson P7000 MOAB', dir: path.join(REPO, 'data/profiles/Epson SureColor P7000 MOAB ICC Profiles') },
]

type LP = ProfileData & { wavelengths: number[] }

async function walkIcm(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries: import('node:fs').Dirent[]
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const d of entries) {
    const fp = path.join(dir, d.name)
    if (d.isDirectory()) out.push(...await walkIcm(fp))
    else if (d.isFile() && /\.(icm|icc)$/i.test(d.name) && !d.name.includes(':Zone.Identifier')) out.push(fp)
  }
  return out
}

async function loadProfile(fp: string, printerId: string): Promise<LP | null> {
  try {
    const buf = await fs.readFile(fp)
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await parseIcmFile({ arrayBuffer: async () => ab } as any)
    if (!r.hasSpectral || r.patchCount < 50) return null
    const name = path.basename(fp).replace(/\.(icm|icc)$/i, '')
    let printMode = printerId
    if (name.startsWith('BC_')) { try { printMode = canonicalPrintMode(name) } catch { /* single-mode */ } }
    return {
      metadata: { full_name: name, brand: 'BC', series: name, printer: printerId, ink: '', substrate: name, parsed_at: new Date().toISOString(), printMode },
      raw: r.measurements, clean: r.measurements, has_spectral: true, patch_count: r.patchCount,
      wavelengths: r.wavelengths ?? Array.from({ length: 36 }, (_, i) => 380 + i * 10),
    }
  } catch { return null }
}

// ─── per-row CMY + Lab helpers (DeviceSpace-agnostic via toCMY) ──────────────

function deviceOfRow(pm: ProfileMatrices, i: number): DeviceValue {
  if (pm.channels === 3) {
    return { space: 'rgb', values: [pm.D[i * 3], pm.D[i * 3 + 1], pm.D[i * 3 + 2]] }
  }
  return { space: 'cmyk', values: [pm.D[i * 4], pm.D[i * 4 + 1], pm.D[i * 4 + 2], pm.D[i * 4 + 3]] }
}

function paperRowOf(pm: ProfileMatrices): number {
  let best = 0, bestInk = Infinity
  for (let i = 0; i < pm.N; i++) {
    const [c, m, y] = toCMY(deviceOfRow(pm, i))
    const ink = c + m + y
    if (ink < bestInk) { bestInk = ink; best = i }
  }
  return best
}

function rowSpectrum(pm: ProfileMatrices, i: number): number[] {
  return Array.from(pm.X.subarray(i * L, i * L + L))
}

const RAMP_CHANNELS: Record<RampName, number[]> = {
  C: [0], M: [1], Y: [2], R: [1, 2], G: [0, 2], B: [0, 1], N: [0, 1, 2],
}

// Spectral ramp for the forward model: nearest patch (in CMY) to level·direction.
function buildSpectralRamp(pm: ProfileMatrices, ramp: RampName, levels: number[]): SpectralRampPoint[] {
  const channels = RAMP_CHANNELS[ramp]
  const cmy = (i: number) => toCMY(deviceOfRow(pm, i))
  const chosen = new Map<number, SpectralRampPoint>()
  for (const level of levels) {
    let bestIdx = -1, bestD = Infinity
    for (let i = 0; i < pm.N; i++) {
      const c = cmy(i)
      let d = 0
      for (let ch = 0; ch < 3; ch++) { const t = channels.includes(ch) ? level : 0; const df = c[ch] - t; d += df * df }
      if (d < bestD) { bestD = d; bestIdx = i }
    }
    if (bestIdx >= 0 && !chosen.has(bestIdx)) {
      const c = cmy(bestIdx)
      const t = channels.reduce((s, ch) => s + c[ch], 0) / channels.length
      chosen.set(bestIdx, { t, spectrum: rowSpectrum(pm, bestIdx) })
    }
  }
  return [...chosen.values()].sort((a, b) => a.t - b.t)
}

const LEVELS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]

interface Stage1Row {
  printer: string
  name: string
  N: number
  flipCount: number
  signFlipScore: number
  spreadCurv: number | null
  vFull: number
  vLim: number
  dVpct: number
  chromaRetentionPct: number
  overLimitFrac: number
  fwdFullDE: number
  fwdLimDE: number
  fwdDrop: number
}

function analyzeProfile(printer: string, prof: LP): Stage1Row | null {
  let pm: ProfileMatrices
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  try { pm = loadProfileMatrix(prof as any) } catch { return null }
  if (pm.N < 50) return null

  const paperIdx = paperRowOf(pm)
  const paperWP: WhitePointXYZ = spectraToXYZ(rowSpectrum(pm, paperIdx), 380)

  const samples: PatchSample[] = []
  const labAll: number[][] = []
  for (let i = 0; i < pm.N; i++) {
    const lab = spectraToLab(rowSpectrum(pm, i), 380, paperWP)
    const cmy = toCMY(deviceOfRow(pm, i))
    samples.push({ cmy, lab })
    labAll.push(lab)
  }

  const limits: InkLimits = detectInkLimits(samples, { levels: LEVELS })

  // Gamut: full vs ink-limited (drop over-limit patches).
  const labLim: number[][] = []
  let overCount = 0
  for (let i = 0; i < samples.length; i++) {
    if (isOverLimit(samples[i].cmy, limits)) { overCount++; continue }
    labLim.push(labAll[i])
  }
  const vFull = gamutHullVolume(labAll)
  const vLim = gamutHullVolume(labLim)
  const dVpct = vFull > 0 ? (100 * (vFull - vLim)) / vFull : 0

  const cFull = maxChromaPerHueBin(labAll)
  const cLim = maxChromaPerHueBin(labLim)
  let retSum = 0, retN = 0
  for (let b = 0; b < cFull.length; b++) {
    if (cFull[b] > 1e-6) { retSum += Math.min(1, cLim[b] / cFull[b]); retN++ }
  }
  const chromaRetentionPct = retN ? (100 * retSum) / retN : 100

  // Within-profile forward model on the three primary ramps, full vs limited.
  const fullDEs: number[] = [], limDEs: number[] = []
  for (const r of ['C', 'M', 'Y'] as RampName[]) {
    const ramp = buildSpectralRamp(pm, r, LEVELS)
    if (ramp.length < 3) continue
    const full = fitForwardRamp(ramp)
    fullDEs.push(full.medianDE)
    const res = limits.perRamp[r]
    if (res?.signFlip) {
      const limited = ramp.filter((p) => p.t <= res.tStar + 1e-9)
      if (limited.length >= 3) limDEs.push(fitForwardRamp(limited).medianDE)
      else limDEs.push(full.medianDE)
    } else {
      limDEs.push(full.medianDE)
    }
  }

  let sc: SpreadCurv | null = null
  try { sc = computeSpreadCurv(pm) } catch { sc = null }

  return {
    printer, name: prof.metadata.full_name, N: pm.N,
    flipCount: limits.flipCount, signFlipScore: limits.signFlipScore,
    spreadCurv: sc?.s560 ?? null,
    vFull, vLim, dVpct, chromaRetentionPct,
    overLimitFrac: overCount / pm.N,
    fwdFullDE: mean(fullDEs), fwdLimDE: mean(limDEs), fwdDrop: mean(fullDEs) - mean(limDEs),
  }
}

// ─── Stage 2: D1 transfer, full test set vs ≤-limit test set ────────────────

interface PairResult {
  ref: string; tgt: string
  passFull: boolean; medFull: number; p95Full: number
  passLim: boolean; medLim: number; p95Lim: number
  worst5Recall: number
}

function buildPair(pA: LP, pB: LP) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const al = alignProfiles(loadProfileMatrix(pA as any), loadProfileMatrix(pB as any))
  if (al.N < 50) return null
  const { N, X_A, X_B, D, sampleIds } = al
  let paperRowIdx = 0
  for (let i = 0; i < N; i++) if (D[i * 3] === 255 && D[i * 3 + 1] === 255 && D[i * 3 + 2] === 255) { paperRowIdx = i; break }
  const emA = extractOBAEmission(Array.from(X_A.subarray(paperRowIdx * L, paperRowIdx * L + L)))
  const emB = extractOBAEmission(Array.from(X_B.subarray(paperRowIdx * L, paperRowIdx * L + L)))
  const fA = computeOBAFactorPerPatch(X_A, L, paperRowIdx)
  const fB = computeOBAFactorPerPatch(X_B, L, paperRowIdx)
  const X_A_clean = subtractOBA(X_A, L, fA, emA.emission)
  const X_B_clean = subtractOBA(X_B, L, fB, emB.emission)
  const paperWP = paperWPFromBrightestPatch(new Float64Array(X_B.subarray(paperRowIdx * L, paperRowIdx * L + L)), 1, L, 380)
  return { N, X_A_clean, X_B_clean, X_B_orig: X_B, D, fB, emB: emB.emission, paperRowIdx, sampleIds, paperWP }
}

function evalPair(b: NonNullable<ReturnType<typeof buildPair>>): PairResult | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pm: any = { N: b.N, D: b.D, channels: 3, L, wavelengths: [], sampleIds: b.sampleIds, X: b.X_B_clean }
  const cov = pickCoverageAnchors(pm)
  const anchorIdx = (cov.meta?.chosenIdx ?? []) as number[]
  if (anchorIdx.length < 2) return null
  const aset = new Set(anchorIdx)

  const d1 = runPaperRatioResidualTransfer({
    X_A: b.X_A_clean, X_B: b.X_B_clean, D: b.D, sampleIds: b.sampleIds,
    anchorIdx, paperRowIdx: b.paperRowIdx, L, paperWP: b.paperWP,
    refProfile: 'A', targetProfile: 'B', residualRank: D1_RANK, knnK: 4, uvBandCount: D1_UV,
  })
  const pred = addOBA(d1.X_pred, L, b.fB, b.emB)

  // Intrinsic ink limit from the TARGET profile's own (OBA-clean) gamut.
  const tgtSamples: PatchSample[] = []
  for (let i = 0; i < b.N; i++) {
    tgtSamples.push({ cmy: toCMY({ space: 'rgb', values: [b.D[i * 3], b.D[i * 3 + 1], b.D[i * 3 + 2]] }), lab: [0, 0, 0] })
  }
  // labels recomputed paper-relative for the limit detector
  const paperWPt = spectraToXYZ(Array.from(b.X_B_orig.subarray(b.paperRowIdx * L, b.paperRowIdx * L + L)), 380)
  for (let i = 0; i < b.N; i++) tgtSamples[i].lab = spectraToLab(Array.from(b.X_B_orig.subarray(i * L, i * L + L)), 380, paperWPt)
  const limits = detectInkLimits(tgtSamples, { levels: LEVELS })

  const allDE: { i: number; de: number }[] = []
  for (let i = 0; i < b.N; i++) {
    if (aset.has(i)) continue
    const lp = spectraToLab(Array.from(pred.subarray(i * L, i * L + L)))
    const lm = spectraToLab(Array.from(b.X_B_orig.subarray(i * L, i * L + L)))
    allDE.push({ i, de: deltaE00(lp[0], lp[1], lp[2], lm[0], lm[1], lm[2]) })
  }
  if (allDE.length < 20) return null

  const full = allDE.map((d) => d.de)
  const lim = allDE.filter((d) => !isOverLimit(tgtSamples[d.i].cmy, limits)).map((d) => d.de)

  // H45d: of the worst-5% patches, what fraction are over-limit?
  const sortedDesc = [...allDE].sort((a, b2) => b2.de - a.de)
  const topN = Math.max(1, Math.round(0.05 * sortedDesc.length))
  const worst = sortedDesc.slice(0, topN)
  const worst5Recall = worst.filter((d) => isOverLimit(tgtSamples[d.i].cmy, limits)).length / worst.length

  const medFull = median(full), p95Full = p95(full)
  const medLim = median(lim), p95Lim = p95(lim)
  return {
    ref: '', tgt: '',
    passFull: medFull <= 1.5 && p95Full <= 3.0, medFull, p95Full,
    passLim: medLim <= 1.5 && p95Lim <= 3.0, medLim, p95Lim,
    worst5Recall,
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══ H45 — Ink-limit gamut-volume tradeoff ═══\n')

  // Stage 1: all profiles.
  const stage1: Stage1Row[] = []
  const profilesByPrinter = new Map<string, LP[]>()
  for (const pd of PRINTERS) {
    const files = (await walkIcm(pd.dir)).sort().filter((f) => !isExcluded(path.basename(f)))
    const profs = (await Promise.all(files.map((f) => loadProfile(f, pd.id)))).filter(Boolean) as LP[]
    profilesByPrinter.set(pd.id, profs)
    for (const prof of profs) {
      const row = analyzeProfile(pd.label, prof)
      if (row) stage1.push(row)
    }
    console.log(`loaded ${pd.label.padEnd(22)} ${String(profs.length).padStart(3)} profiles`)
  }
  console.log(`\nStage 1: ${stage1.length} profiles analysed.`)

  // Correlation signFlipScore vs spreadCurv (sanity).
  const withSC = stage1.filter((r) => r.spreadCurv != null)
  const corr = pearson(withSC.map((r) => r.signFlipScore), withSC.map((r) => r.spreadCurv as number))
  console.log(`corr(signFlipScore, spreadCurv) = ${corr.toFixed(3)}  (n=${withSC.length})`)

  // Problematic cohort = top quartile by signFlipScore (and at least one flip).
  const flipped = stage1.filter((r) => r.flipCount > 0).sort((a, b) => b.signFlipScore - a.signFlipScore)
  const cohortCut = Math.max(1, Math.round(0.25 * stage1.length))
  const cohort = flipped.slice(0, cohortCut)
  const cohortNames = new Set(cohort.map((r) => r.name))
  console.log(`\nProblematic cohort: ${cohort.length} profiles (top-quartile signFlipScore, flipCount>0).`)

  console.log('\nTop-12 problematic profiles:')
  console.log('  signFlip  flips  ΔV%   chromaRet%  fwdFullDE  fwdLimDE  drop   name')
  for (const r of cohort.slice(0, 12)) {
    console.log(
      `  ${r.signFlipScore.toFixed(1).padStart(7)}  ${String(r.flipCount).padStart(5)}  ${r.dVpct.toFixed(1).padStart(4)}  ${r.chromaRetentionPct.toFixed(1).padStart(9)}  ${r.fwdFullDE.toFixed(2).padStart(8)}  ${r.fwdLimDE.toFixed(2).padStart(8)}  ${r.fwdDrop.toFixed(2).padStart(5)}  ${r.name}`,
    )
  }
  const decor = stage1.find((r) => /DecorMatte/i.test(r.name))
  console.log(`\nDecorMatte present: ${decor ? 'YES' : 'no'}${decor ? ` (signFlip ${decor.signFlipScore.toFixed(1)}, flips ${decor.flipCount}, ΔV% ${decor.dVpct.toFixed(1)}, in cohort ${cohortNames.has(decor.name)})` : ''}`)

  // H45a / H45b aggregates over the cohort.
  const dV = cohort.map((r) => r.dVpct)
  const fwdDrops = cohort.filter((r) => r.fwdDrop !== 0).map((r) => r.fwdDrop)
  console.log('\n── H45a (gamut) ──')
  console.log(`median ΔV% across cohort = ${median(dV).toFixed(2)}%  (pass ≤5, reject ≥15)  | mean ${mean(dV).toFixed(2)}%  p95 ${p95(dV).toFixed(2)}%`)
  console.log(`median chroma retention  = ${median(cohort.map((r) => r.chromaRetentionPct)).toFixed(2)}%`)
  console.log('\n── H45b (within-profile forward) ──')
  console.log(`forward LOO ΔE drop (flipping ramps) median = ${median(fwdDrops).toFixed(3)}  (pass ≥0.5)  | n=${fwdDrops.length}`)

  // Stage 2: D1 transfer on cohort same-mode pairs.
  console.log('\n── Stage 2: D1 transfer, full vs ≤-limit test set ──')
  const pairResults: PairResult[] = []
  for (const pd of PRINTERS) {
    const profs = (profilesByPrinter.get(pd.id) ?? []).filter((p) => cohortNames.has(p.metadata.full_name))
    if (profs.length < 2) continue
    const scMap = new Map<LP, SpreadCurv | null>()
    for (const p of profs) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      try { scMap.set(p, computeSpreadCurv(loadProfileMatrix(p as any))) } catch { scMap.set(p, null) }
    }
    const pairs: [LP, LP][] = []
    for (let i = 0; i < profs.length; i++) for (let j = 0; j < profs.length; j++) {
      if (i === j || profs[i].metadata.printMode !== profs[j].metadata.printMode) continue
      if (profs[i].patch_count !== profs[j].patch_count) continue
      const a = scMap.get(profs[i]), b = scMap.get(profs[j])
      if (a && b && classifyPairCompatibility(a, b).risk === 'warn') continue
      pairs.push([profs[i], profs[j]])
    }
    for (const [pA, pB] of pairs.slice(0, MAX_PAIRS)) {
      const built = buildPair(pA, pB)
      if (!built) continue
      const r = evalPair(built)
      if (!r) continue
      r.ref = pA.metadata.full_name; r.tgt = pB.metadata.full_name
      pairResults.push(r)
    }
  }

  if (pairResults.length) {
    const passFull = pairResults.filter((r) => r.passFull).length / pairResults.length
    const passLim = pairResults.filter((r) => r.passLim).length / pairResults.length
    console.log(`pairs evaluated: ${pairResults.length}`)
    console.log(`pass-rate FULL test set    = ${(100 * passFull).toFixed(1)}%`)
    console.log(`pass-rate ≤-limit test set = ${(100 * passLim).toFixed(1)}%`)
    console.log(`Δpass-rate = ${(100 * (passLim - passFull)).toFixed(1)} pp  (H45c pass ≥+10)`)
    console.log(`worst-5% over-limit recall (median) = ${median(pairResults.map((r) => r.worst5Recall)).toFixed(2)}  (H45d pass ≥0.60)`)
  } else {
    console.log('no same-mode cohort pairs available for Stage 2.')
  }

  const out = {
    generatedAt: new Date().toISOString(),
    corrSignFlipSpreadCurv: corr,
    cohortSize: cohort.length,
    h45a: { medianDVpct: median(dV), meanDVpct: mean(dV), p95DVpct: p95(dV), medianChromaRetentionPct: median(cohort.map((r) => r.chromaRetentionPct)) },
    h45b: { medianForwardDrop: median(fwdDrops), nFlippingRamps: fwdDrops.length },
    h45c: pairResults.length ? {
      pairs: pairResults.length,
      passFull: pairResults.filter((r) => r.passFull).length / pairResults.length,
      passLim: pairResults.filter((r) => r.passLim).length / pairResults.length,
    } : null,
    h45d: pairResults.length ? { medianWorst5Recall: median(pairResults.map((r) => r.worst5Recall)) } : null,
    stage1, cohort: cohort.map((r) => r.name), pairResults,
  }
  const outPath = path.join(REPO, 'data/h45_inklimit_gamut.json')
  await fs.writeFile(outPath, JSON.stringify(out, null, 2))
  console.log(`\nwrote ${outPath}`)
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length
  if (n < 2) return 0
  const mx = mean(xs), my = mean(ys)
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0
}

main().catch((e) => { console.error(e); process.exit(1) })
