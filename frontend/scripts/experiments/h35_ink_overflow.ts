// H35 — Ink overflow hypothesis: do dark-patch failures come from ink limit mismatch?
//
// If the CanvasMatte print mode settings (total ink limit, linearization) are
// tuned for porous substrates (800M, ChromataWhite) but applied to less-porous
// DecorMatte, high-coverage patches overflow → nonlinear reflectance collapse
// that the model can't predict from neutral-ramp anchors.
//
// Diagnostics:
//   (A) Neutral-ramp response at 560nm: DecorMatte vs peers — shape + inflection
//   (B) Total-ink high-coverage patches: reflectance vs coverage, monotone?
//   (C) Per-channel ink limit test: at full single-channel (max ink on each channel)
//       compare reflectance DecorMatte vs peers — overflow shows up as collapse
//   (D) M0-M2 at HIGH coverage (ink>2.0) for DecorMatte vs peers — UV-absorber
//       effect on ink vs on paper: if ink absorbs UV, M0<M2 only on paper, not ink
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h35_ink_overflow.ts"

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
;(globalThis as any).DOMParser = jsdom.window.DOMParser
;(globalThis as any).XMLSerializer = jsdom.window.XMLSerializer

import { parseIcmFile } from '../../src/lib/parsers/icmParser'
import { spectraToLab } from '../../src/lib/colormath'
import type { Measurement } from '../../src/types'

const PROFILES_ROOT = path.resolve(process.cwd(), '..', 'data/profiles')
const L = 36
const WL = Array.from({ length: L }, (_, i) => 380 + i * 10)

async function loadProfile(subdir: string, namePart: string): Promise<Measurement[]> {
  const dir = path.join(PROFILES_ROOT, subdir)
  const files = await fs.readdir(dir)
  const fp = files.find(f => f.includes(namePart) && /\.(icm|icc)$/i.test(f))
  if (!fp) throw new Error(`not found: ${namePart} in ${subdir}`)
  const buf = await fs.readFile(path.join(dir, fp))
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const r = await parseIcmFile({arrayBuffer: async () => ab} as any)
  return r.measurements
}

function getRGB(m: Measurement): [number,number,number] | null {
  if (m.device && m.device.space === 'rgb') return m.device.values.slice(0,3) as [number,number,number]
  if (m.RGB_R !== undefined) return [m.RGB_R!, m.RGB_G!, m.RGB_B!]
  return null
}

function inkCov(rgb: [number,number,number]): number {
  return (765 - rgb[0] - rgb[1] - rgb[2]) / 765
}

// Polynomial fit y = 1 + c1*x + c2*x² (no constant term beyond 1)
function fitQuad(xs: number[], ys: number[]): { c1: number; c2: number; inflection: number | null } {
  if (xs.length < 3) return { c1: 0, c2: 0, inflection: null }
  let S11=0,S12=0,S22=0,T1=0,T2=0
  for (let i = 0; i < xs.length; i++) {
    const x=xs[i],x2=x*x,r=ys[i]-1; S11+=x*x; S12+=x*x2; S22+=x2*x2; T1+=x*r; T2+=x2*r
  }
  const det = S11*S22-S12*S12
  if (Math.abs(det)<1e-18) return { c1: 0, c2: 0, inflection: null }
  const c1=(T1*S22-T2*S12)/det, c2=(T2*S11-T1*S12)/det
  // inflection of y'=c1+2c2*x → x_inf = -c1/(2c2)
  const inf = Math.abs(c2) > 1e-6 ? -c1/(2*c2) : null
  return { c1, c2, inflection: inf }
}

// Check monotonicity of y vs x in sorted order
function isMonotone(xs: number[], ys: number[]): boolean {
  const sorted = xs.map((x,i)=>({x,y:ys[i]})).sort((a,b)=>a.x-b.x)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].y > sorted[i-1].y + 0.02) return false // non-monotone decrease
  }
  return true
}

async function main() {
  const CANVAS_SUBS = ['DecorMatte','800M','ChromataWhite','Lyve','BelgianLinen']
  const data: Map<string, Measurement[]> = new Map()
  for (const s of CANVAS_SUBS) {
    try { data.set(s, await loadProfile('CanvasMatte', s)) }
    catch { console.log(`skip: ${s}`) }
  }

  // ── (A) Neutral-ramp at 560nm (λ index 18) ───────────────────────────────
  console.log('=== (A) Neutral-ramp at 560nm: DecorMatte vs CanvasMatte peers ===')
  console.log('  R≈G≈B patches (tol ±10), y = R(560)/R_paper(560)')
  console.log(`  ${'substrate'.padEnd(16)} c1        c2        inflect   monotone  n`)

  const rampData: Record<string, {c1:number;c2:number;xs:number[];ys:number[]}> = {}
  for (const [name, ms] of data) {
    // paper white: max brightness
    const paper = ms.reduce((best,m) => {
      const rgb = getRGB(m); if (!rgb) return best
      const bright = rgb[0]+rgb[1]+rgb[2]
      return bright > (getRGB(best)?.[0]??0)+(getRGB(best)?.[1]??0)+(getRGB(best)?.[2]??0) ? m : best
    })
    const pv560 = paper.spectra?.[18] ?? 0
    if (pv560 < 0.01) { console.log(`  ${name}: no paper white`); continue }

    const xs: number[] = [], ys: number[] = []
    for (const m of ms) {
      const rgb = getRGB(m); if (!rgb) continue
      if (Math.abs(rgb[0]-rgb[1])+Math.abs(rgb[1]-rgb[2]) > 10) continue // non-neutral
      const a = inkCov(rgb); if (a < 0.01) continue
      if (!m.spectra || m.spectra.length < 19) continue
      xs.push(a); ys.push(m.spectra[18] / pv560)
    }
    const fit = fitQuad(xs, ys)
    rampData[name] = { c1: fit.c1, c2: fit.c2, xs, ys }
    const inf = fit.inflection !== null ? fit.inflection.toFixed(2) : 'none'
    const mono = isMonotone(xs, ys)
    console.log(`  ${name.padEnd(16)} ${fit.c1.toFixed(4).padEnd(10)}${fit.c2.toFixed(4).padEnd(10)}${inf.padEnd(10)}${mono?'YES':'NO !!'}   ${xs.length}`)
  }

  // ── (B) High-coverage reflectance collapse at 560nm ─────────────────────
  console.log('\n=== (B) High-coverage reflectance at 560nm (ink > 2.0 = all C+M+Y > 85/255) ===')
  console.log('  Paper-relative reflectance: DecorMatte vs peers')
  console.log(`  ${'substrate'.padEnd(16)} n_hi  mean_R560  min_R560  non-mono-count`)
  for (const [name, ms] of data) {
    const paper = ms.reduce((best,m) => {
      const rgb = getRGB(m); if (!rgb) return best
      const bright = rgb[0]+rgb[1]+rgb[2]
      return bright > ((getRGB(best)?.[0]??0)+(getRGB(best)?.[1]??0)+(getRGB(best)?.[2]??0)) ? m : best
    })
    const pv560 = paper.spectra?.[18] ?? 1
    const hiPatches = ms.filter(m => {
      const rgb = getRGB(m); if (!rgb||!m.spectra) return false
      return inkCov(rgb) > 2.0/3.0   // ink > 2.0 out of 3.0 max
    })
    const r560s = hiPatches.map(m => (m.spectra![18]??0)/pv560)
    const mean = r560s.length ? r560s.reduce((a,b)=>a+b,0)/r560s.length : NaN
    const min = r560s.length ? Math.min(...r560s) : NaN
    // count patches where adding more ink increases 560nm reflectance (overflow sign)
    const pairs = hiPatches.map(m => ({ink: inkCov(getRGB(m)!), r: (m.spectra![18]??0)/pv560}))
      .sort((a,b)=>a.ink-b.ink)
    let nonMono = 0
    for (let i = 1; i < pairs.length; i++) if (pairs[i].r > pairs[i-1].r + 0.03) nonMono++
    console.log(`  ${name.padEnd(16)} ${String(hiPatches.length).padEnd(6)}${mean.toFixed(4).padEnd(11)}${min.toFixed(4).padEnd(10)}${nonMono}`)
  }

  // ── (C) Per-channel ink limits: reflectance at max single-channel ink ───
  console.log('\n=== (C) Single-channel max-ink patches (one channel=0, others=255) ===')
  console.log('  R(560)/R_paper(560) — measures per-channel ink absorption depth')
  console.log(`  ${'substrate'.padEnd(16)} cyan(0,255,255)  mag(255,0,255)  yel(255,255,0)`)
  for (const [name, ms] of data) {
    const paper = ms.reduce((best,m) => {
      const rgb = getRGB(m); if (!rgb) return best
      return (rgb[0]+rgb[1]+rgb[2]) > ((getRGB(best)?.[0]??0)+(getRGB(best)?.[1]??0)+(getRGB(best)?.[2]??0)) ? m : best
    })
    const pv560 = paper.spectra?.[18] ?? 1
    const nearest = (target: [number,number,number]) => ms.reduce((best,m) => {
      const rgb = getRGB(m); if (!rgb) return best
      const d = Math.abs(rgb[0]-target[0])+Math.abs(rgb[1]-target[1])+Math.abs(rgb[2]-target[2])
      const db = Math.abs((getRGB(best)?.[0]??999)-target[0])+Math.abs((getRGB(best)?.[1]??999)-target[1])+Math.abs((getRGB(best)?.[2]??999)-target[2])
      return d < db ? m : best
    })
    const cyn = nearest([0,255,255]), mag = nearest([255,0,255]), yel = nearest([255,255,0])
    const r = (m: Measurement) => ((m.spectra?.[18]??0)/pv560).toFixed(4)
    console.log(`  ${name.padEnd(16)} ${r(cyn).padEnd(16)}${r(mag).padEnd(16)}${r(yel)}`)
  }

  // ── (D) M0-M2 per ink-coverage band: is UV-absorber effect ink-dependent? ─
  console.log('\n=== (D) M0-M2 at 380nm vs ink coverage (DecorMatte — UV-absorber anomaly) ===')
  console.log('  M0-M2 < 0: substrate absorbs UV (DecorMatte unique) vs > 0: OBA (peers)')
  const dm = data.get('DecorMatte')!
  const peer800 = data.get('800M')!
  function obaAt380(ms: Measurement[]): Array<{ink:number;delta:number}> {
    const paper = ms.reduce((best,m) => {
      const rgb = getRGB(m); if (!rgb) return best
      return (rgb[0]+rgb[1]+rgb[2]) > ((getRGB(best)?.[0]??0)+(getRGB(best)?.[1]??0)+(getRGB(best)?.[2]??0)) ? m : best
    })
    const pv = paper.spectra?.[0] ?? 1
    return ms.filter(m => getRGB(m) && m.spectra && m.spectra_m2 && m.spectra_m2.length === L)
      .map(m => ({
        ink: inkCov(getRGB(m)!),
        delta: (m.spectra![0] - m.spectra_m2![0]) / pv,  // (M0-M2)/paper = OBA effect, normalised
      }))
      .sort((a,b)=>a.ink-b.ink)
  }
  const dmDelta = obaAt380(dm), p8Delta = obaAt380(peer800)
  const bins = [0, 0.3, 0.6, 0.9, 1.2, 1.5, 2.0, 3.0]
  console.log(`  ink-bin    DecorMatte(M0-M2)/paper    800M(M0-M2)/paper    n_deco  n_800M`)
  for (let b = 0; b < bins.length-1; b++) {
    const lo = bins[b], hi = bins[b+1]
    const dmBin = dmDelta.filter(p=>p.ink>=lo&&p.ink<hi)
    const p8Bin = p8Delta.filter(p=>p.ink>=lo&&p.ink<hi)
    const meanDM = dmBin.length ? dmBin.reduce((s,p)=>s+p.delta,0)/dmBin.length : NaN
    const mean8 = p8Bin.length ? p8Bin.reduce((s,p)=>s+p.delta,0)/p8Bin.length : NaN
    console.log(`  [${lo.toFixed(1)},${hi.toFixed(1)})  ${meanDM.toFixed(4).padStart(20)}   ${mean8.toFixed(4).padStart(16)}   ${String(dmBin.length).padStart(7)} ${String(p8Bin.length).padStart(6)}`)
  }

  // ── (E) Lab values at very high coverage: does DecorMatte collapse? ──────
  console.log('\n=== (E) Lab at high coverage — gamut collapse? ===')
  console.log('  Patches ink>2.5 (very dark CMY): sorted by L*')
  const label = (name: string, ms: Measurement[]) => {
    const hi = ms.filter(m => { const rgb=getRGB(m); return rgb && inkCov(rgb)>0.8 && m.spectra })
    const labs = hi.map(m => {
      const lab = spectraToLab(Array.from(m.spectra!))
      return { L: lab[0], C: Math.hypot(lab[1],lab[2]), rgb: getRGB(m)!, ink: inkCov(getRGB(m)!) }
    }).sort((a,b)=>a.L-b.L)
    const minL = labs[0]?.L ?? NaN, maxC = Math.max(...labs.map(l=>l.C))
    const darkCount = labs.filter(l=>l.L < 10).length
    console.log(`  ${name}: min-L*=${minL.toFixed(1)}  max-chroma-hi=${maxC.toFixed(1)}  patches-L<10=${darkCount}/${labs.length}`)
  }
  for (const [name, ms] of data) label(name, ms)
}
main().catch(e => { console.error(e); process.exit(1) })
