// frontend/scripts/experiments/modeCompare.ts
//
// Print-mode comparison + statistics (H11). Loads every profile under
// data/profiles/, groups by canonical Epson media preset, and for each preset:
//   - emits a per-profile table (set, substrate, ink, #patches, paper Lab, OBA);
//   - resamples every profile's RGB→R(λ) onto a common RGB lattice via k-NN IDW
//     and computes within-mode pairwise ΔE00 (median / P95 / max) on that grid;
//   - reports the interpolation noise floor (held-out RMS) for context;
//   - for the 3 overlapping presets, computes cross-set BC↔MOAB ΔE00.
//
// Outputs docs/mode-comparison.md, a JSON dump, and a ready-to-paste
// EXPERIMENTS.md row.
//
// Run: cd frontend && npx tsx scripts/experiments/modeCompare.ts

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
import {
  canonicalPrintMode,
  EpsonPreset,
  ALL_PRESETS,
  OVERLAPPING_PRESETS,
  presetFolder,
} from '../../src/utils/printMode'
import {
  buildInterpolator,
  regularGrid,
  boundingBox,
  intersectBox,
  inBox,
  Interpolator,
  InterpPoint,
} from '../../src/lib/interp/rgbInterp'
import { buildPcaInterpolator } from '../../src/lib/interp/pcaInterp'
import { buildWlsInterpolator } from '../../src/lib/interp/wlsInterp'
import { spectraToLab, deltaE00 } from '../../src/lib/colormath'
import { detectOBA } from '../../src/lib/predict/oba'
import { extractOBAEmission } from '../../src/lib/predict/obaSeparator'

const ROOT = path.resolve(process.cwd(), '..')
const PROFILES_ROOT = path.resolve(ROOT, 'data/profiles')
const OUT_MD = path.resolve(ROOT, 'docs/mode-comparison.md')
const OUT_JSON = path.resolve(process.cwd(), 'data/cae-input/mode-comparison.json')

const GRID_LEVELS = Number(process.env.MODE_GRID_LEVELS ?? 11)
const KNN = Number(process.env.MODE_KNN ?? 20)
const POWER = Number(process.env.MODE_POWER ?? 2)
// Interpolation method: 'wls' (local-linear weighted LS, default), 'idw' (per-band
// k-NN inverse-distance weighting), or 'pca' (PCA-score interpolation).
const INTERP = (process.env.MODE_INTERP ?? 'wls').toLowerCase()
const PCA_NCOMP = Number(process.env.MODE_PCA_NCOMP ?? 8)
const PCA_VAR = Number(process.env.MODE_PCA_VAR ?? 0.995)
// Substrate normalisation before comparison (H11 = "device response once paper+OBA
// accounted for"). 'none' = raw spectra. 'oba' = remove OBA fluorescence (D7).
// 'device' = OBA-clean + paper-relative ratio re-applied to a common reference paper
// → compares ink/device response with the substrate factored out.
const NORM = (process.env.MODE_NORM ?? 'device').toLowerCase()
const RATIO_CAP = Number(process.env.MODE_RATIO_CAP ?? 4)

function makeInterp(points: InterpPoint[]): Interpolator {
  if (INTERP === 'pca') {
    return buildPcaInterpolator(points, { k: KNN, power: POWER, nComp: PCA_NCOMP, varThreshold: PCA_VAR })
  }
  if (INTERP === 'wls') {
    return buildWlsInterpolator(points, { k: Math.max(KNN, 16), power: POWER })
  }
  return buildInterpolator(points, { k: KNN, power: POWER })
}

interface Profile {
  name: string
  set: 'BC' | 'MOAB'
  preset: EpsonPreset
  ink: 'mk' | 'pk' | 'unknown'
  substrate: string
  nPatches: number
  paperLab: [number, number, number]
  oba: number
  paperSpec: number[]
  points: InterpPoint[]
  interp: Interpolator
}

// ── small numeric helpers ───────────────────────────────────────────────────
function median(xs: number[]): number {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))
  return s[idx]
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
}
function pearson(a: number[], b: number[]): number {
  const n = a.length
  if (n === 0 || n !== b.length) return NaN
  const ma = mean(a)
  const mb = mean(b)
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma
    const y = b[i] - mb
    num += x * y
    da += x * x
    db += y * y
  }
  const den = Math.sqrt(da * db)
  return den > 0 ? num / den : NaN
}

// Seeded LCG for a deterministic held-out split.
function makeRng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

function inkMode(filename: string): 'mk' | 'pk' | 'unknown' {
  if (/_mk_|_MK_/i.test(filename)) return 'mk'
  if (/_pk_|_PK_/i.test(filename)) return 'pk'
  return 'unknown'
}

async function walkProfiles(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walkProfiles(full)))
    else if (/\.(icm|icc)$/i.test(e.name)) out.push(full)
  }
  return out
}

async function loadProfile(filePath: string): Promise<Profile | null> {
  const buf = await fs.readFile(filePath)
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeFile = { arrayBuffer: async () => arrayBuffer } as any
  const result = await parseIcmFile(fakeFile)
  if (!result.hasSpectral) return null

  const base = path.basename(filePath)
  const meta = parseProfileFilename(base)
  const preset = canonicalPrintMode(meta)

  const paper = result.measurements.find(
    (m) => m.RGB_R === 255 && m.RGB_G === 255 && m.RGB_B === 255 && m.spectra,
  )
  if (!paper?.spectra) return null

  const points: InterpPoint[] = []
  for (const m of result.measurements) {
    if (!m.spectra) continue
    if (m.RGB_R === undefined || m.RGB_G === undefined || m.RGB_B === undefined) continue
    if (m.spectra.length !== paper.spectra.length) continue
    points.push({ rgb: [m.RGB_R, m.RGB_G, m.RGB_B], spectrum: m.spectra })
  }
  if (points.length < KNN + 1) return null

  return {
    name: base.replace(/\.(icm|icc)$/i, ''),
    set: meta.brand === 'MOAB' ? 'MOAB' : 'BC',
    preset,
    ink: inkMode(base),
    substrate: meta.substrate || meta.series || '?',
    nPatches: points.length,
    paperLab: spectraToLab(paper.spectra),
    oba: detectOBA(paper.spectra).score,
    paperSpec: paper.spectra,
    points,
    interp: makeInterp(points),
  }
}

// ΔE00 between two profiles on their common RGB lattice.
function pairDeltaE(a: Profile, b: Profile): number[] {
  const box = intersectBox(boundingBox(a.points), boundingBox(b.points))
  if (!box) return []
  const grid = regularGrid(GRID_LEVELS).filter((p) => inBox(p, box))
  const out: number[] = []
  for (const g of grid) {
    const la = spectraToLab(a.interp.query(g))
    const lb = spectraToLab(b.interp.query(g))
    out.push(deltaE00(la[0], la[1], la[2], lb[0], lb[1], lb[2]))
  }
  return out
}

// Interpolation noise floor for one profile: hold out 10% of patches, rebuild
// the interpolator on the rest, predict the held-out patches. Reports reflectance
// RMS AND the ΔE00 between predicted and measured held-out spectra — the latter is
// directly comparable to the cross-set ΔE numbers, so it tells us how much of the
// cross-set gap is interpolation error vs real substrate difference.
function noiseFloor(p: Profile): { rms: number; deMedian: number; deP95: number } {
  const rng = makeRng(42)
  const idx = p.points.map((_, i) => i)
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[idx[i], idx[j]] = [idx[j], idx[i]]
  }
  const nHold = Math.min(150, Math.floor(p.points.length * 0.1))
  if (nHold < 1) return { rms: NaN, deMedian: NaN, deP95: NaN }
  const holdSet = new Set(idx.slice(0, nHold))
  const train = p.points.filter((_, i) => !holdSet.has(i))
  const interp = makeInterp(train)
  let sq = 0
  let n = 0
  const de: number[] = []
  for (const i of holdSet) {
    const pred = interp.query(p.points[i].rgb)
    const truth = p.points[i].spectrum
    for (let b = 0; b < truth.length; b++) {
      const e = pred[b] - truth[b]
      sq += e * e
      n++
    }
    const lp = spectraToLab(pred)
    const lt = spectraToLab(truth)
    de.push(deltaE00(lp[0], lp[1], lp[2], lt[0], lt[1], lt[2]))
  }
  return { rms: Math.sqrt(sq / n), deMedian: median(de), deP95: percentile(de, 95) }
}

// Spectral Pearson r between two same-chart profiles (matched by rounded RGB).
function spectralR(a: Profile, b: Profile): { r: number; n: number } {
  const key = (rgb: number[]) => `${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])}`
  const mapB = new Map<string, number[]>()
  for (const p of b.points) mapB.set(key(p.rgb), p.spectrum)
  const xs: number[] = []
  const ys: number[] = []
  for (const p of a.points) {
    const m = mapB.get(key(p.rgb))
    if (!m) continue
    for (let i = 0; i < p.spectrum.length; i++) {
      xs.push(p.spectrum[i])
      ys.push(m[i])
    }
  }
  return { r: pearson(xs, ys), n: xs.length / (a.points[0]?.spectrum.length ?? 36) }
}

function pairsOf<T>(xs: T[]): [T, T][] {
  const out: [T, T][] = []
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) out.push([xs[i], xs[j]])
  return out
}

function fmt(x: number, d = 2): string {
  return Number.isFinite(x) ? x.toFixed(d) : 'n/a'
}

const I380 = 0 // 380 nm band index (startWL=380, step=10)

// OBA-cleaned paper: subtract the extrapolated fluorescent emission from the paper.
function cleanedPaper(paperSpec: number[]): number[] {
  const em = extractOBAEmission(paperSpec).emission
  return paperSpec.map((v, i) => Math.max(0, v - em[i]))
}

// Transform a profile's patches to remove the substrate per NORM:
//   'oba'    → subtract OBA fluorescence (per-patch factor from R(380)/paper(380)).
//   'device' → OBA-clean + paper-relative ratio, re-applied to a common reference
//              paper, so two profiles are compared as if printed on the same paper.
function normalizeProfile(p: Profile, refPaperClean: number[]): InterpPoint[] {
  const em = extractOBAEmission(p.paperSpec).emission
  const paperClean = p.paperSpec.map((v, i) => Math.max(0, v - em[i]))
  const paper380 = p.paperSpec[I380]
  return p.points.map((pt) => {
    const factor =
      paper380 > 1e-6 ? Math.min(1, Math.max(0, pt.spectrum[I380] / paper380)) : 0
    const clean = pt.spectrum.map((v, i) => Math.max(0, v - factor * em[i]))
    if (NORM === 'oba') return { rgb: pt.rgb, spectrum: clean }
    const dev = clean.map((v, i) => {
      const pc = paperClean[i]
      const t = pc > 1e-4 ? Math.min(RATIO_CAP, Math.max(0, v / pc)) : 0
      return Math.min(1, t * refPaperClean[i])
    })
    return { rgb: pt.rgb, spectrum: dev }
  })
}

async function main() {
  const files = (await walkProfiles(PROFILES_ROOT)).sort()
  console.log(`Discovered ${files.length} .icm/.icc files`)

  const profiles: Profile[] = []
  for (const f of files) {
    try {
      const p = await loadProfile(f)
      if (p) profiles.push(p)
      else console.warn(`[skip] ${path.basename(f)} — no spectral / no paper anchor`)
    } catch (e) {
      console.error(`[error] ${path.basename(f)}:`, e instanceof Error ? e.message : e)
    }
  }
  console.log(`Loaded ${profiles.length} profiles with spectra + paper anchor`)

  // Substrate normalisation pass (H11): factor out paper white + OBA so the
  // comparison reflects device response, not substrate colour.
  if (NORM !== 'none' && profiles.length > 0) {
    const L = profiles[0].paperSpec.length
    const ref = new Array<number>(L).fill(0)
    for (const p of profiles) {
      const pc = cleanedPaper(p.paperSpec)
      for (let i = 0; i < L; i++) ref[i] += pc[i]
    }
    for (let i = 0; i < L; i++) ref[i] /= profiles.length
    for (const p of profiles) {
      p.points = normalizeProfile(p, ref)
      p.interp = makeInterp(p.points)
    }
    console.log(`Applied substrate normalisation: ${NORM}`)
  }

  const byPreset = new Map<EpsonPreset, Profile[]>()
  for (const p of profiles) {
    if (!byPreset.has(p.preset)) byPreset.set(p.preset, [])
    byPreset.get(p.preset)!.push(p)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jsonOut: any = {
    generated_at: new Date().toISOString(),
    interp: INTERP,
    norm: NORM,
    grid_levels: GRID_LEVELS,
    knn: KNN,
    power: POWER,
    pca_ncomp: INTERP === 'pca' ? PCA_NCOMP : null,
    pca_var: INTERP === 'pca' ? PCA_VAR : null,
    presets: {},
  }

  let md = ''
  md += `# Print-mode comparison (H11)\n\n`
  md += `> Generated by \`frontend/scripts/experiments/modeCompare.ts\`. Canonical mode =\n`
  const interpLabel =
    INTERP === 'pca'
      ? `PCA-score interp (nComp≤${PCA_NCOMP}, var≥${PCA_VAR}, k=${KNN}, power=${POWER})`
      : INTERP === 'wls'
        ? `local-linear WLS (k=${Math.max(KNN, 16)}, power=${POWER})`
        : `per-band k-NN IDW (k=${KNN}, power=${POWER})`
  const normLabel =
    NORM === 'device'
      ? `device response (OBA-clean + paper-relative to common reference paper, ratio cap ${RATIO_CAP})`
      : NORM === 'oba'
        ? 'OBA fluorescence removed (D7), substrate white retained'
        : 'none (raw spectra)'
  md += `> Epson media preset. ΔE00 is CIEDE2000 on the common ${GRID_LEVELS}×${GRID_LEVELS}×${GRID_LEVELS} RGB\n`
  md += `> lattice. Interpolation: ${interpLabel}. Substrate normalisation: ${normLabel}.\n`
  md += `> Read ΔE00 above each profile's noise floor.\n\n`

  // ── per-preset summary table ───────────────────────────────────────────────
  md += `## Summary by preset\n\n`
  md += `| Preset | BC | MOAB | within-mode ΔE00 median | P95 | max | mean noise floor (refl. RMS) |\n`
  md += `|---|---:|---:|---:|---:|---:|---:|\n`

  // Cache the per-profile interpolation noise floor (computed once, reused below).
  const floorOf = new Map<Profile, ReturnType<typeof noiseFloor>>()
  for (const p of profiles) floorOf.set(p, noiseFloor(p))

  const presetStats: Record<
    string,
    { bc: number; moab: number; median: number; p95: number; max: number; floor: number }
  > = {}

  for (const preset of ALL_PRESETS) {
    const group = byPreset.get(preset) ?? []
    const bc = group.filter((g) => g.set === 'BC')
    const moab = group.filter((g) => g.set === 'MOAB')
    const allDe: number[] = []
    for (const [a, b] of pairsOf(group)) allDe.push(...pairDeltaE(a, b))
    const floors = group.map((g) => floorOf.get(g)!.rms).filter(Number.isFinite)
    const st = {
      bc: bc.length,
      moab: moab.length,
      median: median(allDe),
      p95: percentile(allDe, 95),
      max: allDe.length ? Math.max(...allDe) : NaN,
      floor: mean(floors),
    }
    presetStats[preset] = st
    md += `| ${preset} | ${st.bc} | ${st.moab} | ${fmt(st.median)} | ${fmt(st.p95)} | ${fmt(st.max)} | ${fmt(st.floor, 4)} |\n`
  }
  md += `\n`

  // ── Step 0 diagnostic: interpolation noise floor split by source set ─────────
  const floorAgg = (ps: Profile[]) => {
    const f = ps.map((p) => floorOf.get(p)!).filter((x) => Number.isFinite(x.rms))
    return {
      n: f.length,
      rms: mean(f.map((x) => x.rms)),
      deMed: mean(f.map((x) => x.deMedian)),
      deP95: mean(f.map((x) => x.deP95)),
    }
  }
  md += `## Interpolation noise floor by set (Step 0 diagnostic)\n\n`
  md += `> Hold out 10% of each profile's patches, predict from the rest. interp ΔE00(pred,truth)\n`
  md += `> is directly comparable to the cross-set numbers. If BC ≫ MOAB, the BC 905-patch chart's\n`
  md += `> interpolation is a real contributor to the cross-set gap (not just substrate difference).\n\n`
  md += `| Set | profiles | refl RMS | interp ΔE00 median | interp ΔE00 P95 |\n`
  md += `|---|---:|---:|---:|---:|\n`
  const bcAll = profiles.filter((p) => p.set === 'BC')
  const moabAll = profiles.filter((p) => p.set === 'MOAB')
  const bcAgg = floorAgg(bcAll)
  const moabAgg = floorAgg(moabAll)
  md += `| BC (905-patch) | ${bcAgg.n} | ${fmt(bcAgg.rms, 4)} | ${fmt(bcAgg.deMed)} | ${fmt(bcAgg.deP95)} |\n`
  md += `| MOAB (~2033 lattice) | ${moabAgg.n} | ${fmt(moabAgg.rms, 4)} | ${fmt(moabAgg.deMed)} | ${fmt(moabAgg.deP95)} |\n\n`
  md += `Per overlapping preset (interp ΔE00 median, BC vs MOAB):\n\n`
  md += `| Preset | BC interp ΔE00 | MOAB interp ΔE00 | cross-set ΔE00 (from H11) |\n`
  md += `|---|---:|---:|---:|\n`
  for (const preset of OVERLAPPING_PRESETS) {
    const group = byPreset.get(preset) ?? []
    const b = floorAgg(group.filter((g) => g.set === 'BC'))
    const m = floorAgg(group.filter((g) => g.set === 'MOAB'))
    md += `| ${preset} | ${fmt(b.deMed)} | ${fmt(m.deMed)} | (see H11 table) |\n`
  }
  md += `\n`

  // ── cross-set (overlapping presets) ────────────────────────────────────────
  md += `## Cross-set BC ↔ MOAB (overlapping presets) — H11 test\n\n`
  md += `| Preset | BC×MOAB pairs | cross-set ΔE00 median | P95 | within-BC median | within-MOAB median |\n`
  md += `|---|---:|---:|---:|---:|---:|\n`

  const crossStats: Record<string, { pairs: number; median: number; p95: number; wbc: number; wmoab: number }> = {}
  // Per-pair details for the cross-set section, surfacing which BC×MOAB pair drags
  // P95 up (typically a metallic or otherwise off-preset substrate).
  const crossPairs: Record<string, Array<{ a: string; b: string; median: number; p95: number; max: number }>> = {}
  for (const preset of OVERLAPPING_PRESETS) {
    const group = byPreset.get(preset) ?? []
    const bc = group.filter((g) => g.set === 'BC')
    const moab = group.filter((g) => g.set === 'MOAB')
    const cross: number[] = []
    const perPair: Array<{ a: string; b: string; median: number; p95: number; max: number }> = []
    for (const a of bc) {
      for (const b of moab) {
        const de = pairDeltaE(a, b)
        cross.push(...de)
        if (de.length) {
          perPair.push({
            a: a.name,
            b: b.name,
            median: median(de),
            p95: percentile(de, 95),
            max: Math.max(...de),
          })
        }
      }
    }
    crossPairs[preset] = perPair.sort((x, y) => y.p95 - x.p95)
    const wbc: number[] = []
    for (const [a, b] of pairsOf(bc)) wbc.push(...pairDeltaE(a, b))
    const wmoab: number[] = []
    for (const [a, b] of pairsOf(moab)) wmoab.push(...pairDeltaE(a, b))
    const st = {
      pairs: bc.length * moab.length,
      median: median(cross),
      p95: percentile(cross, 95),
      wbc: median(wbc),
      wmoab: median(wmoab),
    }
    crossStats[preset] = st
    md += `| ${preset} | ${st.pairs} | ${fmt(st.median)} | ${fmt(st.p95)} | ${fmt(st.wbc)} | ${fmt(st.wmoab)} |\n`
  }
  md += `\n`

  // Per-pair cross-set breakdown — identifies the worst-P95 pair (typically a
  // substrate that nominally shares the Epson preset but differs physically,
  // e.g. a metallic in PremiumGlossy).
  md += `### Cross-set worst pairs (sorted by P95 ΔE00)\n\n`
  for (const preset of OVERLAPPING_PRESETS) {
    const list = crossPairs[preset] ?? []
    if (!list.length) continue
    md += `**${preset}**\n\n`
    md += `| BC profile | MOAB profile | median | P95 | max |\n`
    md += `|---|---|---:|---:|---:|\n`
    for (const p of list) {
      md += `| ${p.a} | ${p.b} | ${fmt(p.median)} | ${fmt(p.p95)} | ${fmt(p.max)} |\n`
    }
    md += `\n`
  }

  // ── per-preset profile tables ──────────────────────────────────────────────
  md += `## Profiles by preset\n\n`
  for (const preset of ALL_PRESETS) {
    const group = (byPreset.get(preset) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))
    if (group.length === 0) continue
    md += `### ${preset} (${presetFolder(preset)}/)\n\n`
    md += `| Profile | Set | Substrate | Ink | #patches | paper L* | a* | b* | OBA (R440/R550) |\n`
    md += `|---|---|---|---|---:|---:|---:|---:|---:|\n`
    for (const p of group) {
      md += `| ${p.name} | ${p.set} | ${p.substrate} | ${p.ink} | ${p.nPatches} | ${fmt(p.paperLab[0])} | ${fmt(p.paperLab[1])} | ${fmt(p.paperLab[2])} | ${fmt(p.oba, 3)} |\n`
    }
    md += `\n`

    // within-set spectral correlation (same chart only)
    const bc = group.filter((g) => g.set === 'BC')
    const moab = group.filter((g) => g.set === 'MOAB')
    const rBC = pairsOf(bc).map(([a, b]) => spectralR(a, b)).filter((x) => x.n >= 20)
    const rMO = pairsOf(moab).map(([a, b]) => spectralR(a, b)).filter((x) => x.n >= 20)
    if (rBC.length) md += `- within-BC spectral r (matched patches): mean ${fmt(mean(rBC.map((x) => x.r)), 4)} over ${rBC.length} pairs\n`
    if (rMO.length) md += `- within-MOAB spectral r (matched patches): mean ${fmt(mean(rMO.map((x) => x.r)), 4)} over ${rMO.length} pairs\n`
    if (rBC.length || rMO.length) md += `\n`

    jsonOut.presets[preset] = {
      profiles: group.map((p) => ({
        name: p.name,
        set: p.set,
        substrate: p.substrate,
        ink: p.ink,
        nPatches: p.nPatches,
        paperLab: p.paperLab,
        oba: p.oba,
      })),
      within: presetStats[preset],
      cross: crossStats[preset] ?? null,
    }
  }

  await fs.writeFile(OUT_MD, md)
  await fs.mkdir(path.dirname(OUT_JSON), { recursive: true })
  await fs.writeFile(OUT_JSON, JSON.stringify(jsonOut, null, 2))

  console.log(`\nWrote ${path.relative(ROOT, OUT_MD)} and ${path.relative(ROOT, OUT_JSON)}`)

  // ── EXPERIMENTS.md row suggestion ──────────────────────────────────────────
  const cm = crossStats['CanvasMatte']
  const pl = crossStats['PremiumLuster']
  const pg = crossStats['PremiumGlossy']
  console.log('\n--- suggested EXPERIMENTS.md row ---')
  console.log(
    `| ${new Date().toISOString().slice(0, 10)} | Print-mode taxonomy + cross-vendor comparison (H11) | ` +
      `46 P9000 profiles (27 BC + 18 MOAB +1 cxf) reorganised into 10 Epson-preset folders; ` +
      `cross-set BC↔MOAB compared on a common ${GRID_LEVELS}³ RGB lattice (k-NN IDW). | (pending) | ` +
      `Cross-set median ΔE00 — Canvas Matte ${fmt(cm?.median)} (within-BC ${fmt(cm?.wbc)}), ` +
      `Premium Luster ${fmt(pl?.median)} (within-MOAB ${fmt(pl?.wmoab)}), ` +
      `Premium Glossy ${fmt(pg?.median)}. | (fill conclusion) | (fill next step) |`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
