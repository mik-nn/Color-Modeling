// H32 — Attack the 12 structural failers.
//
// The 11.5% ceiling (fail @ S1 k=13) survived coverage placement (H31b) and
// threshold/clamped per-λ spreading (H24, gates not met). H32 throws new levers
// at the 12, per-pair, to learn which mechanism (if any) responds:
//   B    = D1 baseline (rank=5, no spreading)
//   S    = D1 + ORACLE per-λ spreading, UNCLAMPED, no threshold (max spreading knowledge)
//   R8   = D1 rank=8 residual (more DOF to absorb structural mismatch)
//   S+R8 = both
//
// Hypothesis: pure-spreading pairs (1930↔ArtPeelBlckt, ΔE_ab=1.1) respond to S;
// base-shape pairs (DecorMatte group, VibranceLuster↔RiverStone) do not — and
// the ceiling is confirmed structural / un-correctable from neutral data.
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h32_structural_attack.ts"

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
import { paperWPFromBrightestPatch } from '../../src/lib/predict/perLambdaAffine'
import {
  extractOBAEmission, computeOBAFactorPerPatch, subtractOBA, addOBA,
} from '../../src/lib/predict/obaSeparator'
import { spectraToLab, deltaE00 } from '../../src/lib/colormath'
import { canonicalPrintMode } from '../../src/utils/printMode'
import type { ProfileData } from '../../src/types'

const PROFILES_ROOT = path.resolve(process.cwd(), '..', 'data/profiles')
const L = 36, D1_UV = 4, K = 13
const METALLIC_RE = /Silverada|VibranceMetallic/i

const median = (xs: number[]) => { if (!xs.length) return NaN; const s=[...xs].sort((a,b)=>a-b),m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2 }
const p95 = (xs: number[]) => { if (!xs.length) return NaN; const s=[...xs].sort((a,b)=>a-b); return s[Math.min(s.length-1,Math.round(0.95*(s.length-1)))] }

function fitQuadNoBias(xs: number[], ys: number[]): [number, number] {
  const n = xs.length; if (n < 2) return [0, 0]
  let S11=0,S12=0,S22=0,T1=0,T2=0
  for (let i=0;i<n;i++){ const x=xs[i],x2=x*x,r=ys[i]-1; S11+=x*x; S12+=x*x2; S22+=x2*x2; T1+=x*r; T2+=x2*r }
  const det=S11*S22-S12*S12; if (Math.abs(det)<1e-18) return [0,0]
  return [(T1*S22-T2*S12)/det,(T2*S11-T1*S12)/det]
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
    if(xs.length>=2){const[_c1,_c2]=fitQuadNoBias(xs,ys); c1[l]=_c1; c2[l]=_c2} }
  return {c1,c2}
}
function preCorrect(X_A: Float64Array, D: Float64Array, N: number, c1A:Float64Array,c2A:Float64Array,c1B:Float64Array,c2B:Float64Array, clampLo:number, clampHi:number): Float64Array {
  const out=new Float64Array(X_A)
  for(let i=0;i<N;i++){ const a=(765-D[i*3]-D[i*3+1]-D[i*3+2])/765; if(a<0.01)continue; const a2=a*a
    for(let l=0;l<L;l++){ const fA=1+c1A[l]*a+c2A[l]*a2, fB=1+c1B[l]*a+c2B[l]*a2; if(Math.abs(fA)<0.01)continue
      out[i*L+l]*=Math.max(clampLo,Math.min(clampHi,fB/fA)) } }
  return out
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r=await parseIcmFile({arrayBuffer:async()=>ab} as any)
    if(!r.hasSpectral||!r.measurements.length)return null
    const name=path.basename(fp).replace(/\.(icm|icc)$/i,'')
    let preset:string; try{preset=canonicalPrintMode(name)}catch{return null}
    return {metadata:{full_name:name,brand:'BC',series:name,printer:'P9000',ink:'mk',substrate:name,parsed_at:new Date().toISOString(),printMode:preset},
      raw:r.measurements,clean:r.measurements,has_spectral:true,patch_count:r.measurements.length,
      wavelengths:r.wavelengths??Array.from({length:36},(_,i)=>380+i*10)}
  } catch { return null }
}
const short = (n: string) => n.replace(/^BC_/, '').replace(/_P9000_.+/, '')

const TARGETS: Array<[string,string]> = [
  ['VibranceLuster','RiverStoneSatinRag'],['RiverStoneSatinRag','VibranceLuster'],
  ['1930','ArtPeelBlckt'],['ArtPeelBlckt','1930'],
  ['DecorMatte','ChromataWhite'],['ChromataWhite','DecorMatte'],['DecorMatte','800M'],['800M','DecorMatte'],
  ['DecorMatte','Lyve'],['Lyve','DecorMatte'],['DecorMatte','BelgianLinen'],['BelgianLinen','DecorMatte'],
]

interface Cond { med:number; p95:number; pass:boolean }
function runCond(X_A: Float64Array, X_B_clean: Float64Array, X_B_orig: Float64Array, D: Float64Array,
  sampleIds: string[], anchorIdx: number[], paperRowIdx: number, paperWP: Float64Array,
  fB: Float64Array, emB: Float64Array, rank: number, N: number): Cond {
  const d1 = runPaperRatioResidualTransfer({ X_A, X_B: X_B_clean, D, sampleIds, anchorIdx, paperRowIdx, L, paperWP,
    refProfile:'A', targetProfile:'B', residualRank: rank, knnK: 4, uvBandCount: D1_UV })
  const pred = addOBA(d1.X_pred, L, fB, emB)
  const anchorSet = new Set(anchorIdx); const des:number[]=[]
  for(let i=0;i<N;i++){ if(anchorSet.has(i))continue
    const lp=spectraToLab(Array.from(pred.subarray(i*L,i*L+L))), lm=spectraToLab(Array.from(X_B_orig.subarray(i*L,i*L+L)))
    des.push(deltaE00(lp[0],lp[1],lp[2],lm[0],lm[1],lm[2])) }
  return { med:median(des), p95:p95(des), pass:median(des)<=1.5&&p95(des)<=3.0 }
}

async function main() {
  const files=(await walk(PROFILES_ROOT)).sort()
  const profiles=(await Promise.all(files.filter(f=>path.basename(f).startsWith('BC_')).map(loadProfile))).filter(Boolean) as LP[]
  const byShort=new Map<string,LP[]>()
  for(const p of profiles){ const s=short(p.metadata.full_name); if(!byShort.has(s))byShort.set(s,[]); byShort.get(s)!.push(p) }

  console.log('=== H32: attacking the 12 structural failers (k=13) ===')
  console.log('  B=baseline rank5 | S=+unclamped oracle per-λ spreading | R8=rank8 | SR8=both\n')
  console.log(`  ${'pair'.padEnd(36)} ${'B'.padEnd(18)} ${'S'.padEnd(18)} ${'R8'.padEnd(18)} ${'S+R8'}`)

  let anyFixed=0
  for(const [aS,bS] of TARGETS){
    const pAs=byShort.get(aS), pBs=byShort.get(bS); if(!pAs||!pBs)continue
    // find same-mode pair
    let pA:LP|undefined,pB:LP|undefined
    for(const a of pAs)for(const b of pBs)if(a.metadata.printMode===b.metadata.printMode){pA=a;pB=b}
    if(!pA||!pB)continue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const al=alignProfiles(loadProfileMatrix(pA as any),loadProfileMatrix(pB as any)); if(al.N<100)continue
    const {N,X_A,X_B,D,sampleIds}=al
    let paperRowIdx=0; for(let i=0;i<N;i++)if(D[i*3]===255&&D[i*3+1]===255&&D[i*3+2]===255){paperRowIdx=i;break}
    const emA=extractOBAEmission(Array.from(X_A.subarray(paperRowIdx*L,paperRowIdx*L+L)))
    const emB=extractOBAEmission(Array.from(X_B.subarray(paperRowIdx*L,paperRowIdx*L+L)))
    const fA=computeOBAFactorPerPatch(X_A,L,paperRowIdx), fB=computeOBAFactorPerPatch(X_B,L,paperRowIdx)
    const XA_c=subtractOBA(X_A,L,fA,emA.emission), XB_c=subtractOBA(X_B,L,fB,emB.emission)
    const paperWP=paperWPFromBrightestPatch(new Float64Array(X_B.subarray(paperRowIdx*L,paperRowIdx*L+L)),1,L,380)
    const tgt={X:X_B,D,channels:3 as const,N,L,wavelengths:al.wavelengths??[],sampleIds,droppedCount:0}
    const anchorIdx=(pickHeuristicAnchors(tgt).meta?.chosenIdx as number[]).slice(0,K)

    // oracle unclamped per-λ spreading on clean A
    const nA=neutralIndices(D,N), nB=neutralIndices(D,N).filter(i=>i!==paperRowIdx)
    const fitA=fitSpreadPerLambda(XA_c,D,nA,paperRowIdx), fitB=fitSpreadPerLambda(XB_c,D,nB,paperRowIdx)
    const XA_spread=preCorrect(XA_c,D,N,fitA.c1,fitA.c2,fitB.c1,fitB.c2,0.2,5.0)

    const B   = runCond(XA_c,     XB_c, X_B, D, sampleIds, anchorIdx, paperRowIdx, paperWP, fB, emB.emission, 5, N)
    const S   = runCond(XA_spread,XB_c, X_B, D, sampleIds, anchorIdx, paperRowIdx, paperWP, fB, emB.emission, 5, N)
    const R8  = runCond(XA_c,     XB_c, X_B, D, sampleIds, anchorIdx, paperRowIdx, paperWP, fB, emB.emission, 8, N)
    const SR8 = runCond(XA_spread,XB_c, X_B, D, sampleIds, anchorIdx, paperRowIdx, paperWP, fB, emB.emission, 8, N)
    if(S.pass||R8.pass||SR8.pass) anyFixed++
    const fmt=(c:Cond)=>`${c.med.toFixed(2)}/${c.p95.toFixed(2)}${c.pass?'✓':' '}`
    console.log(`  ${(aS+'→'+bS).padEnd(36)} ${fmt(B).padEnd(18)} ${fmt(S).padEnd(18)} ${fmt(R8).padEnd(18)} ${fmt(SR8)}`)
  }
  console.log(`\n  Pairs fixed by ANY lever (S/R8/SR8): ${anyFixed}/12`)
  console.log('  (cell = med/p95, ✓ = pass gate med≤1.5 & p95≤3.0)')
}
main().catch(e => { console.error(e); process.exit(1) })
