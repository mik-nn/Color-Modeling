// H45c control — is the +7.5pp ink-limit transfer gain REAL or MECHANICAL?
//
// Original H45c restricted the D1 test set to the TARGET's ≤-limit patches, which
// trivially raises pass-rate (fewer hard patches to fail). Two fixes here:
//   1. Define the ink limit from the REFERENCE profile (deployment-realistic: ref
//      is fully known, target only via anchors) and apply it by device coordinate.
//   2. Matched-count RANDOM-exclusion control: exclude the same NUMBER of random
//      test patches (avg over seeds). If limit-exclusion beats random-exclusion,
//      the over-limit patches are disproportionately the failures (REAL). If they
//      tie, the gain was pure test-set shrink (MECHANICAL).
//
// Δreal = pass(limit-excluded) − pass(random-excluded). pass(random) − pass(full)
// = the mechanical component.
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h45c_control.ts"

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
import { detectInkLimits, isOverLimit, type InkLimits, type PatchSample } from '../../src/lib/analyzers/inkLimitChroma'

const REPO = path.resolve(process.cwd(), '..')
const P9000_DIR = '/mnt/e/PET/LinkedInPosts/surecolor-p9000'
const L = 36, D1_RANK = 5, D1_UV = 4
const MAX_PAIRS = 60, RAND_SEEDS = 30
const LEVELS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
const EXCLUDE_RE = /Silverada|VibranceMetallic|Metallic|AllureAq/i

const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const p95 = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.round(0.95 * (s.length - 1)))] }
const gate = (xs: number[]) => median(xs) <= 1.5 && p95(xs) <= 3.0

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
    if (name.startsWith('BC_')) { try { printMode = canonicalPrintMode(name) } catch { /* single */ } }
    return {
      metadata: { full_name: name, brand: 'BC', series: name, printer: printerId, ink: '', substrate: name, parsed_at: new Date().toISOString(), printMode },
      raw: r.measurements, clean: r.measurements, has_spectral: true, patch_count: r.patchCount,
      wavelengths: r.wavelengths ?? Array.from({ length: 36 }, (_, i) => 380 + i * 10),
    }
  } catch { return null }
}

function deviceOfRow(pm: ProfileMatrices, i: number): DeviceValue {
  if (pm.channels === 3) return { space: 'rgb', values: [pm.D[i * 3], pm.D[i * 3 + 1], pm.D[i * 3 + 2]] }
  return { space: 'cmyk', values: [pm.D[i * 4], pm.D[i * 4 + 1], pm.D[i * 4 + 2], pm.D[i * 4 + 3]] }
}
const rowSpectrum = (pm: ProfileMatrices, i: number) => Array.from(pm.X.subarray(i * L, i * L + L))

function paperRowOf(pm: ProfileMatrices): number {
  let best = 0, bestInk = Infinity
  for (let i = 0; i < pm.N; i++) { const [c, m, y] = toCMY(deviceOfRow(pm, i)); const ink = c + m + y; if (ink < bestInk) { bestInk = ink; best = i } }
  return best
}

// Intrinsic ink limit from a profile's OWN gamut (paper-relative Lab).
function limitsOfProfile(pm: ProfileMatrices): InkLimits {
  const paperIdx = paperRowOf(pm)
  const wp: WhitePointXYZ = spectraToXYZ(rowSpectrum(pm, paperIdx), 380)
  const samples: PatchSample[] = []
  for (let i = 0; i < pm.N; i++) samples.push({ cmy: toCMY(deviceOfRow(pm, i)), lab: spectraToLab(rowSpectrum(pm, i), 380, wp) })
  return detectInkLimits(samples, { levels: LEVELS })
}

function signFlipScore(pm: ProfileMatrices): number {
  try { return limitsOfProfile(pm).signFlipScore } catch { return 0 }
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

interface CtrlResult {
  passFull: boolean; passLimitRef: boolean; passLimitTgt: boolean; passRandMean: number
  nOver: number; nTest: number
}

function evalPair(b: NonNullable<ReturnType<typeof buildPair>>, refLimits: InkLimits, tgtLimits: InkLimits): CtrlResult | null {
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

  const test: { i: number; de: number; over: boolean; overT: boolean }[] = []
  for (let i = 0; i < b.N; i++) {
    if (aset.has(i)) continue
    const cmy = toCMY({ space: 'rgb', values: [b.D[i * 3], b.D[i * 3 + 1], b.D[i * 3 + 2]] })
    const lp = spectraToLab(Array.from(pred.subarray(i * L, i * L + L)))
    const lm = spectraToLab(Array.from(b.X_B_orig.subarray(i * L, i * L + L)))
    test.push({ i, de: deltaE00(lp[0], lp[1], lp[2], lm[0], lm[1], lm[2]), over: isOverLimit(cmy, refLimits), overT: isOverLimit(cmy, tgtLimits) })
  }
  if (test.length < 20) return null

  const full = test.map((t) => t.de)
  const limRef = test.filter((t) => !t.over).map((t) => t.de)
  const limTgt = test.filter((t) => !t.overT).map((t) => t.de)
  const nOver = test.length - limRef.length

  // Matched-count random-exclusion control (REF count), averaged over seeds.
  let passRand = 0
  if (nOver > 0 && nOver < test.length) {
    let rng = 12345
    const rand = () => { rng = (1664525 * rng + 1013904223) >>> 0; return rng / 0xffffffff }
    for (let s = 0; s < RAND_SEEDS; s++) {
      const idx = test.map((_, k) => k)
      for (let k = idx.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [idx[k], idx[j]] = [idx[j], idx[k]] }
      const keep = new Set(idx.slice(nOver)) // drop first nOver after shuffle
      const sub = test.filter((_, k) => keep.has(k)).map((t) => t.de)
      if (gate(sub)) passRand++
    }
    passRand /= RAND_SEEDS
  } else {
    passRand = gate(full) ? 1 : 0
  }

  return { passFull: gate(full), passLimitRef: gate(limRef), passLimitTgt: gate(limTgt), passRandMean: passRand, nOver, nTest: test.length }
}

async function main() {
  console.log('═══ H45c control — REAL vs MECHANICAL ink-limit transfer gain ═══\n')

  const profilesByPrinter = new Map<string, LP[]>()
  const scoreByName = new Map<string, number>()
  const allScores: number[] = []
  for (const pd of PRINTERS) {
    const files = (await walkIcm(pd.dir)).sort().filter((f) => !EXCLUDE_RE.test(path.basename(f)))
    const profs = (await Promise.all(files.map((f) => loadProfile(f, pd.id)))).filter(Boolean) as LP[]
    profilesByPrinter.set(pd.id, profs)
    for (const p of profs) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let sc = 0; try { sc = signFlipScore(loadProfileMatrix(p as any)) } catch { sc = 0 }
      scoreByName.set(p.metadata.full_name, sc); allScores.push(sc)
    }
  }
  const sortedScores = [...allScores].sort((a, b) => b - a)
  const cut = sortedScores[Math.max(0, Math.round(0.25 * sortedScores.length) - 1)] ?? 0
  const inCohort = (n: string) => (scoreByName.get(n) ?? 0) >= cut && (scoreByName.get(n) ?? 0) > 0
  console.log(`cohort cutoff signFlipScore ≥ ${cut.toFixed(2)} (top quartile)\n`)

  const results: CtrlResult[] = []
  for (const pd of PRINTERS) {
    const profs = (profilesByPrinter.get(pd.id) ?? []).filter((p) => inCohort(p.metadata.full_name))
    if (profs.length < 2) continue
    const scMap = new Map<LP, SpreadCurv | null>()
    for (const p of profs) { try { scMap.set(p, computeSpreadCurv(loadProfileMatrix(p as any))) } catch { scMap.set(p, null) } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const limMap = new Map<LP, InkLimits>()
    for (const p of profs) { try { limMap.set(p, limitsOfProfile(loadProfileMatrix(p as any))) } catch { /* skip */ } }

    const pairs: [LP, LP][] = []
    for (let i = 0; i < profs.length; i++) for (let j = 0; j < profs.length; j++) {
      if (i === j || profs[i].metadata.printMode !== profs[j].metadata.printMode) continue
      if (profs[i].patch_count !== profs[j].patch_count) continue
      const a = scMap.get(profs[i]), b = scMap.get(profs[j])
      if (a && b && classifyPairCompatibility(a, b).risk === 'warn') continue
      pairs.push([profs[i], profs[j]])
    }
    for (const [pA, pB] of pairs.slice(0, MAX_PAIRS)) {
      const refLim = limMap.get(pA), tgtLim = limMap.get(pB)
      if (!refLim || !tgtLim) continue
      const built = buildPair(pA, pB)
      if (!built) continue
      const r = evalPair(built, refLim, tgtLim)
      if (r) results.push(r)
    }
  }

  const n = results.length
  const frac = (f: (r: CtrlResult) => number) => results.reduce((s, r) => s + f(r), 0) / n
  const passFull = frac((r) => (r.passFull ? 1 : 0))
  const passLimRef = frac((r) => (r.passLimitRef ? 1 : 0))
  const passLimTgt = frac((r) => (r.passLimitTgt ? 1 : 0))
  const passRand = frac((r) => r.passRandMean)
  const meanOverFrac = frac((r) => r.nOver / r.nTest)

  const pp = (x: number) => (100 * x).toFixed(1)
  console.log(`pairs evaluated: ${n}`)
  console.log(`mean over-limit fraction of test set (REF limit): ${pp(meanOverFrac)}%\n`)
  console.log(`pass FULL (no exclusion)            = ${pp(passFull)}%`)
  console.log(`pass RANDOM-excluded (matched n)    = ${pp(passRand)}%   ← mechanical baseline`)
  console.log(`pass LIMIT-excluded (REF-defined)   = ${pp(passLimRef)}%`)
  console.log(`pass LIMIT-excluded (TGT-defined)   = ${pp(passLimTgt)}%   (original H45c framing)\n`)
  console.log(`Δ total  (limitRef − full)   = ${pp(passLimRef - passFull)} pp`)
  console.log(`Δ mechanical (random − full) = ${pp(passRand - passFull)} pp`)
  console.log(`Δ REAL (limitRef − random)   = ${pp(passLimRef - passRand)} pp   ← survives if > 0`)

  const verdict = passLimRef - passRand >= 0.05 ? 'REAL (≥+5pp over random)'
    : passLimRef - passRand >= 0.02 ? 'WEAK-REAL (+2..5pp)'
    : 'MECHANICAL (≤+2pp over random)'
  console.log(`\nVERDICT: ${verdict}`)

  const out = {
    generatedAt: new Date().toISOString(), pairs: n, meanOverFrac,
    passFull, passRandom: passRand, passLimitRef: passLimRef, passLimitTgt: passLimTgt,
    deltaTotal: passLimRef - passFull, deltaMechanical: passRand - passFull, deltaReal: passLimRef - passRand,
    verdict,
  }
  const outPath = path.join(REPO, 'data/h45c_control.json')
  await fs.writeFile(outPath, JSON.stringify(out, null, 2))
  console.log(`\nwrote ${outPath}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
