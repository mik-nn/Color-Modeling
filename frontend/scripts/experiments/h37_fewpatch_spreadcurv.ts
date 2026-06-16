// H37 — Few-patch spreadCurv robustness.
//
// H36 fit spreadCurv on the full neutral ramp (~36 R≈G≈B patches). For a
// deployable protocol we want it from a handful of neutrals — ideally the same
// 3 the coverage-6 chart already measures (white, mid-gray, black). Question:
// how few neutral patches can spreadCurv use before its failure-prediction
// (AUC) and reference-selection power collapse?
//
// The 104-pair D1 transfer eval is INDEPENDENT of spreadCurv, so eval once and
// cache (med/p95/pass); then recompute spreadCurv per budget and re-derive AUC
// + reference-selection.
//
// Budgets: 3, 4, 5, 6, 8 neutral patches (nearest evenly-spaced coverage
// levels) vs full ramp.
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h37_fewpatch_spreadcurv.ts"

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
;(globalThis as any).DOMParser = jsdom.window.DOMParser
;(globalThis as any).XMLSerializer = jsdom.window.XMLSerializer

import { parseIcmFile } from '../../src/lib/parsers/icmParser'
import { loadProfileMatrix, alignProfiles } from '../../src/lib/dataset/matrix'
import { pickHeuristicAnchors } from '../../src/lib/sampling/heuristic'
import { runPaperRatioResidualTransfer } from '../../src/lib/predict/paperRatioResidual'
import { paperWPFromBrightestPatch } from '../../src/lib/predict/perLambdaAffine'
import {
  extractOBAEmission, computeOBAFactorPerPatch, subtractOBA, addOBA,
} from '../../src/lib/predict/obaSeparator'
import { spectraToLab, deltaE00 } from '../../src/lib/colormath'
import { canonicalPrintMode } from '../../src/utils/printMode'
import type { ProfileData } from '../../src/types'

const PROFILES_ROOT = path.resolve(process.cwd(), '..', 'data/profiles')
const L = 36, RANK = 5, UV = 4, K = 13
const METALLIC_RE = /Silverada|VibranceMetallic/i

const mean = (xs: number[]) => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : NaN
const median = (xs: number[]) => { if(!xs.length)return NaN; const s=[...xs].sort((a,b)=>a-b),m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2 }
const p95 = (xs: number[]) => { if(!xs.length)return NaN; const s=[...xs].sort((a,b)=>a-b); return s[Math.min(s.length-1,Math.round(0.95*(s.length-1)))] }
function fitQuadNoBias(xs: number[], ys: number[]): [number, number] {
  const n=xs.length; if(n<3)return[0,0]
  let S11=0,S12=0,S22=0,T1=0,T2=0
  for(let i=0;i<n;i++){const x=xs[i],x2=x*x,r=ys[i]-1; S11+=x*x;S12+=x*x2;S22+=x2*x2;T1+=x*r;T2+=x2*r}
  const det=S11*S22-S12*S12; if(Math.abs(det)<1e-18)return[0,0]
  return[(T1*S22-T2*S12)/det,(T2*S11-T1*S12)/det]
}
function auc(failScores: number[], passScores: number[]): number {
  let wins=0,ties=0
  for(const f of failScores)for(const p of passScores){ if(f>p)wins++; else if(f===p)ties++ }
  return (wins+0.5*ties)/(failScores.length*passScores.length)
}

async function walk(dir: string): Promise<string[]> {
  const out:string[]=[]; let e:import('node:fs').Dirent[]
  try{e=await fs.readdir(dir,{withFileTypes:true})}catch{return out}
  for(const d of e){const f=path.join(dir,d.name); if(d.isDirectory())out.push(...await walk(f)); else if(d.isFile()&&/\.(icm|icc)$/i.test(d.name))out.push(f)}
  return out
}
type LP = ProfileData & { wavelengths: number[] }
async function loadProfile(fp: string): Promise<LP | null> {
  try {
    const buf=await fs.readFile(fp); const ab=buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength)
    const r=await parseIcmFile({arrayBuffer:async()=>ab} as any)
    if(!r.hasSpectral||!r.measurements.length)return null
    const name=path.basename(fp).replace(/\.(icm|icc)$/i,'')
    let preset:string; try{preset=canonicalPrintMode(name)}catch{return null}
    return {metadata:{full_name:name,brand:'BC',series:name,printer:'P9000',ink:'mk',substrate:name,parsed_at:new Date().toISOString(),printMode:preset},
      raw:r.measurements,clean:r.measurements,has_spectral:true,patch_count:r.measurements.length,
      wavelengths:r.wavelengths??Array.from({length:36},(_,i)=>380+i*10)}
  } catch { return null }
}
const short = (n: string) => n.replace(/^BC_/, '').replace(/_P9000_.+/, '').replace(/_P9000$/, '')

// Collect all neutral (R≈G≈B) rows with their ink coverage a.
function neutralRows(X: Float64Array, D: Float64Array, N: number, paperRowIdx: number): { rows: number[]; ai: number[] } {
  const rows:number[]=[], ai:number[]=[]
  for(let i=0;i<N;i++){const r=D[i*3],g=D[i*3+1],b=D[i*3+2]; if(Math.abs(r-g)+Math.abs(g-b)>10)continue
    const a=(765-r-g-b)/765; if(a<0.01)continue; rows.push(i); ai.push(a)}
  return { rows, ai }
}

// Pick `budget` neutral rows nearest to evenly-spaced coverage levels in [aMin,1].
// budget=3 → {white(a~0 via paper, separate), low, mid, high}; here we always
// include the paper implicitly (R/Rpaper=1 at a=0 is the fit anchor) and pick
// `budget` inked neutral levels.
function pickNeutralSubset(rows: number[], ai: number[], budget: number): number[] {
  if (rows.length <= budget) return rows.slice()
  const aMin = Math.min(...ai), aMax = Math.max(...ai)
  const picked: number[] = []
  const taken = new Set<number>()
  for (let s = 0; s < budget; s++) {
    const target = aMin + (aMax - aMin) * (budget === 1 ? 0.5 : s / (budget - 1))
    let best = -1, bestD = Infinity
    for (let i = 0; i < rows.length; i++) {
      if (taken.has(i)) continue
      const d = Math.abs(ai[i] - target)
      if (d < bestD) { bestD = d; best = i }
    }
    if (best >= 0) { taken.add(best); picked.push(rows[best]) }
  }
  return picked
}

function spreadCurv560(X: Float64Array, ramp: number[], ai: number[], paperRowIdx: number): number {
  const pv = X[paperRowIdx*L + 18]; if (pv < 1e-5) return 0
  const xs = ai, ys = ramp.map(i => X[i*L+18]/pv)
  const [c1,c2] = fitQuadNoBias(xs, ys)
  return Math.hypot(c1, c2)
}

interface Prof { name: string; mode: string; X: Float64Array; D: Float64Array; N: number; paperRowIdx: number; rows: number[]; ai: number[] }
interface Ev { ref: string; tgt: string; med: number; p95: number; pass: boolean }

async function main() {
  const files=(await walk(PROFILES_ROOT)).sort()
  const profiles=(await Promise.all(files.filter(f=>path.basename(f).startsWith('BC_')).map(loadProfile))).filter(Boolean) as LP[]

  const P = new Map<string, Prof>()
  for (const p of profiles) {
    const m = loadProfileMatrix(p as any)
    let paperRowIdx=0; for(let i=0;i<m.N;i++)if(m.D[i*3]===255&&m.D[i*3+1]===255&&m.D[i*3+2]===255){paperRowIdx=i;break}
    const { rows, ai } = neutralRows(m.X, m.D, m.N, paperRowIdx)
    P.set(p.metadata.full_name, { name: short(p.metadata.full_name), mode: p.metadata.printMode!, X: m.X, D: m.D, N: m.N, paperRowIdx, rows, ai })
  }

  // ── eval all 104 pairs ONCE (cache med/p95/pass) ──────────────────────────
  const evals: Ev[] = []
  for (const a of profiles) for (const b of profiles) {
    if (a===b || a.metadata.printMode!==b.metadata.printMode) continue
    const nA=a.metadata.full_name, nB=b.metadata.full_name
    if (nA.includes('AllureAq')||nB.includes('AllureAq')) continue
    if (METALLIC_RE.test(nA)||METALLIC_RE.test(nB)) continue
    const al=alignProfiles(loadProfileMatrix(a as any),loadProfileMatrix(b as any)); if(al.N<100)continue
    const {N,X_A,X_B,D,sampleIds,wavelengths}=al
    let pr=0; for(let i=0;i<N;i++)if(D[i*3]===255&&D[i*3+1]===255&&D[i*3+2]===255){pr=i;break}
    const emA=extractOBAEmission(Array.from(X_A.subarray(pr*L,pr*L+L)))
    const emB=extractOBAEmission(Array.from(X_B.subarray(pr*L,pr*L+L)))
    const fA=computeOBAFactorPerPatch(X_A,L,pr), fB=computeOBAFactorPerPatch(X_B,L,pr)
    const XA_c=subtractOBA(X_A,L,fA,emA.emission), XB_c=subtractOBA(X_B,L,fB,emB.emission)
    const paperWP=paperWPFromBrightestPatch(new Float64Array(X_B.subarray(pr*L,pr*L+L)),1,L,380)
    const tgt={X:X_B,D,channels:3 as const,N,L,wavelengths:wavelengths??[],sampleIds,droppedCount:0}
    const anchorIdx=(pickHeuristicAnchors(tgt).meta?.chosenIdx as number[]).slice(0,K)
    const aset=new Set(anchorIdx)
    const d1=runPaperRatioResidualTransfer({X_A:XA_c,X_B:XB_c,D,sampleIds,anchorIdx,paperRowIdx:pr,L,paperWP,
      refProfile:'A',targetProfile:'B',residualRank:RANK,knnK:4,uvBandCount:UV})
    const pred=addOBA(d1.X_pred,L,fB,emB.emission); const des:number[]=[]
    for(let i=0;i<N;i++){ if(aset.has(i))continue
      const lp=spectraToLab(Array.from(pred.subarray(i*L,i*L+L))), lm=spectraToLab(Array.from(X_B.subarray(i*L,i*L+L)))
      des.push(deltaE00(lp[0],lp[1],lp[2],lm[0],lm[1],lm[2])) }
    const med=median(des),p=p95(des)
    evals.push({ ref: short(nA), tgt: short(nB), med, p95: p, pass: med<=1.5&&p<=3.0 })
  }
  const fail=evals.filter(e=>!e.pass), pass=evals.filter(e=>e.pass)
  console.log(`Pairs: ${evals.length} (fail ${fail.length}, pass ${pass.length})\n`)

  // map short name → Prof for spreadCurv recompute
  const byShort = new Map<string, Prof>()
  for (const pr of P.values()) byShort.set(pr.name, pr)

  console.log('=== spreadCurv@560 from N neutral patches: failure prediction + ref selection ===')
  console.log(`  ${'budget'.padEnd(10)} AUC     thr≥    catch     FA       refSel(near/far p95)   nearWins`)

  const budgets = [3, 4, 5, 6, 8, 999] // 999 = full ramp
  for (const budget of budgets) {
    // recompute spreadCurv per profile from this budget
    const curv = new Map<string, number>()
    for (const pr of byShort.values()) {
      const sub = pickNeutralSubset(pr.rows, pr.ai, budget)
      const subAi = sub.map(r => (765 - pr.D[r*3] - pr.D[r*3+1] - pr.D[r*3+2]) / 765)
      curv.set(pr.name, spreadCurv560(pr.X, sub, subAi, pr.paperRowIdx))
    }
    // Δcurv per pair
    const withDelta = evals.map(e => ({ ...e, dC: Math.abs((curv.get(e.ref)??0) - (curv.get(e.tgt)??0)) }))
    const fS = withDelta.filter(e=>!e.pass).map(e=>e.dC), pS = withDelta.filter(e=>e.pass).map(e=>e.dC)
    const A = auc(fS, pS)
    // best Youden threshold
    const allv=[...new Set(withDelta.map(e=>e.dC))].sort((a,b)=>a-b)
    let bestJ=-1,bestT=0,bestTP=0,bestFP=0
    for(const t of allv){
      const tp=withDelta.filter(e=>!e.pass&&e.dC>=t).length, fn=fail.length-tp
      const fp=withDelta.filter(e=>e.pass&&e.dC>=t).length, tn=pass.length-fp
      const J=(tp/(tp+fn))-(fp/(fp+tn))
      if(J>bestJ){bestJ=J;bestT=t;bestTP=tp;bestFP=fp}
    }
    // ref selection
    const byTgt=new Map<string,typeof withDelta>()
    for(const e of withDelta){ if(!byTgt.has(e.tgt))byTgt.set(e.tgt,[]); byTgt.get(e.tgt)!.push(e) }
    let nearWins=0,cnt=0,nNear:number[]=[],nFar:number[]=[]
    for(const [,es] of byTgt){ if(es.length<3)continue
      const sorted=[...es].sort((a,b)=>a.dC-b.dC)
      const near=sorted[0], far=sorted[sorted.length-1]
      nNear.push(near.p95); nFar.push(far.p95)
      if(near.p95<far.p95-0.05)nearWins++; cnt++ }
    const label = budget===999 ? 'full' : String(budget)
    console.log(`  ${label.padEnd(10)} ${A.toFixed(3)}   ${bestT.toFixed(3)}   ${bestTP}/${fail.length}      ${bestFP}/${pass.length}     ${mean(nNear).toFixed(2)}/${mean(nFar).toFixed(2)}              ${nearWins}/${cnt}`)
  }
  console.log('\n  (refSel = mean p95 of spreadCurv-nearest vs farthest reference; nearWins = targets where nearest beats farthest)')
}
main().catch(e => { console.error(e); process.exit(1) })
