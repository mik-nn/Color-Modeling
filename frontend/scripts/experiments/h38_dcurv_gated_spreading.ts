// H38 — Δcurv-gated spreading pre-correction.
//
// H32 showed oracle spreading fixes 0/12 failers (ceiling structural). But that
// asked "can spreading cross the gate?" The deployment question is different:
// applied to ALL pairs, realistic spreading HURTS easy pairs (overcorrection),
// so it can't be a default. Δcurv (H36/H37) lets us GATE it — apply spreading
// only when the pair is a spreading-outlier (Δcurv560 ≥ 0.137), leave
// well-matched pairs untouched. Does selective application lift the overall
// 104-pair pass rate where blanket application cannot?
//
// Conditions:
//   BASE = D1 baseline (no spreading)
//   GATE = D1 + REALISTIC per-λ spreading pre-correction, only if Δcurv ≥ thr
//   ALL  = D1 + spreading on every pair (shows the collateral damage gating avoids)
//
// Spreading is realistic (fitted from each profile's own neutral ramp, clamped
// [0.5,2.0]) — NOT the oracle of H32. Δcurv from 3-patch spreadCurv (H37 best).
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h38_dcurv_gated_spreading.ts"

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
const DCURV_THR = 0.137
const CLAMP_LO = 0.5, CLAMP_HI = 2.0

const median = (xs: number[]) => { if(!xs.length)return NaN; const s=[...xs].sort((a,b)=>a-b),m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2 }
const p95 = (xs: number[]) => { if(!xs.length)return NaN; const s=[...xs].sort((a,b)=>a-b); return s[Math.min(s.length-1,Math.round(0.95*(s.length-1)))] }
function fitQuadNoBias(xs: number[], ys: number[]): [number, number] {
  const n=xs.length; if(n<3)return[0,0]
  let S11=0,S12=0,S22=0,T1=0,T2=0
  for(let i=0;i<n;i++){const x=xs[i],x2=x*x,r=ys[i]-1; S11+=x*x;S12+=x*x2;S22+=x2*x2;T1+=x*r;T2+=x2*r}
  const det=S11*S22-S12*S12; if(Math.abs(det)<1e-18)return[0,0]
  return[(T1*S22-T2*S12)/det,(T2*S11-T1*S12)/det]
}
const neutralIndices = (D: Float64Array, N: number, tol=10): number[] => {
  const out:number[]=[]; for(let i=0;i<N;i++){const r=D[i*3],g=D[i*3+1],b=D[i*3+2]; if(Math.abs(r-g)+Math.abs(g-b)<=tol)out.push(i)} return out
}
function fitSpreadPerLambda(X: Float64Array, D: Float64Array, rows: number[], paperRowIdx: number): {c1:Float64Array;c2:Float64Array} {
  const c1=new Float64Array(L),c2=new Float64Array(L)
  const ais=rows.map(i=>(765-D[i*3]-D[i*3+1]-D[i*3+2])/765)
  for(let l=0;l<L;l++){ const pv=X[paperRowIdx*L+l]; if(pv<1e-5)continue
    const xs:number[]=[],ys:number[]=[]
    for(let k=0;k<rows.length;k++){const a=ais[k]; if(a<0.01)continue; xs.push(a); ys.push(X[rows[k]*L+l]/pv)}
    if(xs.length>=3){const[_c1,_c2]=fitQuadNoBias(xs,ys); c1[l]=_c1; c2[l]=_c2} }
  return {c1,c2}
}
function preCorrect(X_A: Float64Array, D: Float64Array, N: number, c1A:Float64Array,c2A:Float64Array,c1B:Float64Array,c2B:Float64Array): Float64Array {
  const out=new Float64Array(X_A)
  for(let i=0;i<N;i++){ const a=(765-D[i*3]-D[i*3+1]-D[i*3+2])/765; if(a<0.01)continue; const a2=a*a
    for(let l=0;l<L;l++){ const fA=1+c1A[l]*a+c2A[l]*a2, fB=1+c1B[l]*a+c2B[l]*a2; if(Math.abs(fA)<0.01)continue
      out[i*L+l]*=Math.max(CLAMP_LO,Math.min(CLAMP_HI,fB/fA)) } }
  return out
}
// 3-patch spreadCurv@560 (white/mid/black neutrals) — H37 best
function spreadCurv3(X: Float64Array, D: Float64Array, N: number, paperRowIdx: number): number {
  const rows:number[]=[],ai:number[]=[]
  for(let i=0;i<N;i++){const r=D[i*3],g=D[i*3+1],b=D[i*3+2]; if(Math.abs(r-g)+Math.abs(g-b)>10)continue
    const a=(765-r-g-b)/765; if(a<0.01)continue; rows.push(i); ai.push(a)}
  if(rows.length<3)return 0
  const aMin=Math.min(...ai),aMax=Math.max(...ai); const picked:number[]=[],taken=new Set<number>()
  for(let s=0;s<3;s++){const target=aMin+(aMax-aMin)*(s/2); let best=-1,bd=Infinity
    for(let i=0;i<rows.length;i++){if(taken.has(i))continue; const d=Math.abs(ai[i]-target); if(d<bd){bd=d;best=i}}
    if(best>=0){taken.add(best);picked.push(rows[best])}}
  const pv=X[paperRowIdx*L+18]; if(pv<1e-5)return 0
  const xs=picked.map(r=>(765-D[r*3]-D[r*3+1]-D[r*3+2])/765), ys=picked.map(r=>X[r*L+18]/pv)
  const[c1,c2]=fitQuadNoBias(xs,ys); return Math.hypot(c1,c2)
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

interface PairRes { ref:string; tgt:string; dC:number; base:boolean; gate:boolean; all:boolean }

function evalCond(XA_in: Float64Array, XB_c: Float64Array, X_B_orig: Float64Array, D: Float64Array,
  sampleIds: string[], anchorIdx: number[], pr: number, paperWP: Float64Array, fB: Float64Array, emB: Float64Array, N: number): boolean {
  const d1=runPaperRatioResidualTransfer({X_A:XA_in,X_B:XB_c,D,sampleIds,anchorIdx,paperRowIdx:pr,L,paperWP,
    refProfile:'A',targetProfile:'B',residualRank:RANK,knnK:4,uvBandCount:UV})
  const pred=addOBA(d1.X_pred,L,fB,emB); const aset=new Set(anchorIdx); const des:number[]=[]
  for(let i=0;i<N;i++){ if(aset.has(i))continue
    const lp=spectraToLab(Array.from(pred.subarray(i*L,i*L+L))), lm=spectraToLab(Array.from(X_B_orig.subarray(i*L,i*L+L)))
    des.push(deltaE00(lp[0],lp[1],lp[2],lm[0],lm[1],lm[2])) }
  return median(des)<=1.5 && p95(des)<=3.0
}

async function main() {
  const files=(await walk(PROFILES_ROOT)).sort()
  const profiles=(await Promise.all(files.filter(f=>path.basename(f).startsWith('BC_')).map(loadProfile))).filter(Boolean) as LP[]

  // 3-patch spreadCurv per profile
  const curv=new Map<string,number>()
  for(const p of profiles){ const m=loadProfileMatrix(p as any)
    let pr=0; for(let i=0;i<m.N;i++)if(m.D[i*3]===255&&m.D[i*3+1]===255&&m.D[i*3+2]===255){pr=i;break}
    curv.set(p.metadata.full_name, spreadCurv3(m.X,m.D,m.N,pr)) }

  const results: PairRes[]=[]
  for (const a of profiles) for (const b of profiles) {
    if (a===b || a.metadata.printMode!==b.metadata.printMode) continue
    const nA=a.metadata.full_name, nB=b.metadata.full_name
    if (nA.includes('AllureAq')||nB.includes('AllureAq')) continue
    if (METALLIC_RE.test(nA)||METALLIC_RE.test(nB)) continue
    const al=alignProfiles(loadProfileMatrix(a as any),loadProfileMatrix(b as any)); if(al.N<100)continue
    const {N,X_A,X_B,D,sampleIds}=al
    let pr=0; for(let i=0;i<N;i++)if(D[i*3]===255&&D[i*3+1]===255&&D[i*3+2]===255){pr=i;break}
    const emA=extractOBAEmission(Array.from(X_A.subarray(pr*L,pr*L+L)))
    const emB=extractOBAEmission(Array.from(X_B.subarray(pr*L,pr*L+L)))
    const fA=computeOBAFactorPerPatch(X_A,L,pr), fB=computeOBAFactorPerPatch(X_B,L,pr)
    const XA_c=subtractOBA(X_A,L,fA,emA.emission), XB_c=subtractOBA(X_B,L,fB,emB.emission)
    const paperWP=paperWPFromBrightestPatch(new Float64Array(X_B.subarray(pr*L,pr*L+L)),1,L,380)
    const tgt={X:X_B,D,channels:3 as const,N,L,wavelengths:al.wavelengths??[],sampleIds,droppedCount:0}
    const anchorIdx=(pickHeuristicAnchors(tgt).meta?.chosenIdx as number[]).slice(0,K)

    // realistic spreading: fit on neutral ramps, pre-correct A→B
    const nRows=neutralIndices(D,N), nRowsB=nRows.filter(i=>i!==pr)
    const fitA=fitSpreadPerLambda(XA_c,D,nRows,pr), fitB=fitSpreadPerLambda(XB_c,D,nRowsB,pr)
    const XA_spread=preCorrect(XA_c,D,N,fitA.c1,fitA.c2,fitB.c1,fitB.c2)

    const dC=Math.abs((curv.get(nA)??0)-(curv.get(nB)??0))
    const base=evalCond(XA_c,     XB_c, X_B, D, sampleIds, anchorIdx, pr, paperWP, fB, emB.emission, N)
    const all =evalCond(XA_spread,XB_c, X_B, D, sampleIds, anchorIdx, pr, paperWP, fB, emB.emission, N)
    const gate=dC>=DCURV_THR ? all : base
    results.push({ref:short(nA),tgt:short(nB),dC,base,gate,all})
  }

  const cnt=(k:'base'|'gate'|'all')=>results.filter(r=>r[k]).length
  console.log(`Pairs: ${results.length}\n`)
  console.log(`=== H38: Δcurv-gated spreading (thr=${DCURV_THR}, clamp[${CLAMP_LO},${CLAMP_HI}]) ===`)
  console.log(`  BASE pass: ${cnt('base')}/${results.length} (${(100*cnt('base')/results.length).toFixed(1)}%)`)
  console.log(`  GATE pass: ${cnt('gate')}/${results.length} (${(100*cnt('gate')/results.length).toFixed(1)}%)`)
  console.log(`  ALL  pass: ${cnt('all')}/${results.length} (${(100*cnt('all')/results.length).toFixed(1)}%)`)

  const gateFixed=results.filter(r=>!r.base&&r.gate), gateBroke=results.filter(r=>r.base&&!r.gate)
  const allFixed=results.filter(r=>!r.base&&r.all), allBroke=results.filter(r=>r.base&&!r.all)
  console.log(`\n  GATE: fixed ${gateFixed.length}, broke ${gateBroke.length}  (net ${gateFixed.length-gateBroke.length})`)
  console.log(`  ALL : fixed ${allFixed.length}, broke ${allBroke.length}  (net ${allFixed.length-allBroke.length})`)
  console.log(`\n  How many pairs even cross the gate (Δcurv≥${DCURV_THR}): ${results.filter(r=>r.dC>=DCURV_THR).length}`)
  if(gateFixed.length)console.log(`  GATE fixed pairs: ${gateFixed.map(r=>`${r.ref}→${r.tgt}(ΔC=${r.dC.toFixed(2)})`).join(', ')}`)
  if(gateBroke.length)console.log(`  GATE broke pairs: ${gateBroke.map(r=>`${r.ref}→${r.tgt}(ΔC=${r.dC.toFixed(2)})`).join(', ')}`)
  console.log(`\n  (gating shields ${results.filter(r=>r.dC<DCURV_THR).length} low-Δcurv pairs from spreading; ALL applies it blanket)`)
}
main().catch(e => { console.error(e); process.exit(1) })
