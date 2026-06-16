// H39 — Primary-aligned spreadCurv (user hypothesis, 2026-06-16).
//
// H36 spreadCurv uses the NEUTRAL ramp (R≈G≈B) — captures total-ink spreading
// but not per-ink/chromatic interaction. Failures concentrate in chromatic
// sectors (H33: yellow, red, C+M+Y), so a descriptor built on the device's
// actual PRIMARIES may predict failure better.
//
// User proposal: find the max-saturation point (≈ a primary), 2 more primaries
// at other hues, build curvature on the paper→primary vectors (and pick the 50%
// point on that vector, not a pure neutral). Compare to the neutral baseline.
//
// Descriptors per profile:
//   neutralCurv   = H36 ‖c1,c2‖@560 of the neutral ramp (baseline)
//   primaryCurv_k = ‖c1,c2‖ of the ramp toward primary k, at that primary's
//                   absorption band λ* (argmin R_primary/R_paper)
//   primVecΔ      = mean |sorted primaryCurv_A − sorted primaryCurv_B|
//   primMeanΔ     = |mean primaryCurv_A − mean primaryCurv_B|
//
// Test: AUC(Δdescriptor → fail) and reference-selection vs neutral 0.841.
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h39_primary_spreadcurv.ts"

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
function auc(fS: number[], pS: number[]): number {
  let w=0,t=0; for(const f of fS)for(const p of pS){if(f>p)w++; else if(f===p)t++} return (w+0.5*t)/(fS.length*pS.length)
}
function pearson(xs:number[],ys:number[]):number{const mx=mean(xs),my=mean(ys);let sxy=0,sx=0,sy=0;for(let i=0;i<xs.length;i++){const dx=xs[i]-mx,dy=ys[i]-my;sxy+=dx*dy;sx+=dx*dx;sy+=dy*dy}return sxy/Math.sqrt(sx*sy)}

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

interface Desc { neutral: number; primCurvs: number[]; primHues: number[] }

function computeDescriptors(X: Float64Array, D: Float64Array, N: number): Desc {
  let paperRowIdx=-1; for(let i=0;i<N;i++)if(D[i*3]===255&&D[i*3+1]===255&&D[i*3+2]===255){paperRowIdx=i;break}
  if(paperRowIdx<0){let best=-1;for(let i=0;i<N;i++){const s=D[i*3]+D[i*3+1]+D[i*3+2];if(s>best){best=s;paperRowIdx=i}}}

  // ── neutral curv @560 ──
  const nRows:number[]=[],nAi:number[]=[]
  for(let i=0;i<N;i++){const r=D[i*3],g=D[i*3+1],b=D[i*3+2]; if(Math.abs(r-g)+Math.abs(g-b)>10)continue
    const a=(765-r-g-b)/765; if(a<0.01)continue; nRows.push(i); nAi.push(a)}
  const pv560=X[paperRowIdx*L+18]
  const [nc1,nc2]=fitQuadNoBias(nAi,nRows.map(i=>X[i*L+18]/pv560))
  const neutral=Math.hypot(nc1,nc2)

  // ── Lab + chroma/hue per patch ──
  const lab:Array<{L:number;C:number;h:number;i:number}>=[]
  for(let i=0;i<N;i++){const l=spectraToLab(Array.from(X.subarray(i*L,i*L+L)))
    lab.push({L:l[0],C:Math.hypot(l[1],l[2]),h:Math.atan2(l[2],l[1])*180/Math.PI,i})}

  // ── find 3 primaries = max-chroma per hue cluster (exclude ±45° around taken) ──
  const taken:number[]=[]; const primCurvs:number[]=[],primHues:number[]=[]
  for(let p=0;p<3;p++){
    let best=-1,bestC=-1
    for(const e of lab){ if(e.C<=bestC)continue
      let near=false; for(const h of taken)if(Math.abs(((e.h-h+540)%360)-180)<45){near=true;break}
      if(near)continue; bestC=e.C; best=e.i }
    if(best<0)break
    const hub=lab.find(e=>e.i===best)!.h; taken.push(hub); primHues.push(hub)
    // primary device RGB and absorption band λ*
    const pr=D[best*3],pg=D[best*3+1],pb=D[best*3+2]
    let lstar=18,minR=Infinity; for(let l=0;l<L;l++){const rr=X[best*L+l]/Math.max(X[paperRowIdx*L+l],1e-4); if(rr<minR){minR=rr;lstar=l}}
    const pvL=X[paperRowIdx*L+lstar]; if(pvL<1e-5){primCurvs.push(0);continue}
    // ramp = patches aligned with white→primary vector (cos>0.93)
    const dx=pr-255,dy=pg-255,dz=pb-255; const dn=Math.hypot(dx,dy,dz)||1
    const xs:number[]=[],ys:number[]=[]
    for(let i=0;i<N;i++){const vx=D[i*3]-255,vy=D[i*3+1]-255,vz=D[i*3+2]-255; const vn=Math.hypot(vx,vy,vz)
      if(vn<1)continue; const cos=(vx*dx+vy*dy+vz*dz)/(vn*dn); if(cos<0.93)continue
      const a=vn/dn; if(a<0.01||a>1.3)continue; xs.push(a); ys.push(X[i*L+lstar]/pvL)}
    if(xs.length>=3){const[c1,c2]=fitQuadNoBias(xs,ys); primCurvs.push(Math.hypot(c1,c2))}
    else primCurvs.push(0)
  }
  while(primCurvs.length<3)primCurvs.push(0)
  return {neutral,primCurvs,primHues}
}

interface Ev { ref:string; tgt:string; med:number; p95:number; pass:boolean }

async function main() {
  const files=(await walk(PROFILES_ROOT)).sort()
  const profiles=(await Promise.all(files.filter(f=>path.basename(f).startsWith('BC_')).map(loadProfile))).filter(Boolean) as LP[]
  const desc=new Map<string,Desc>()
  for(const p of profiles){const m=loadProfileMatrix(p as any); desc.set(p.metadata.full_name, computeDescriptors(m.X,m.D,m.N))}

  // eval 104 pairs once
  const evals:Ev[]=[]
  for(const a of profiles)for(const b of profiles){ if(a===b||a.metadata.printMode!==b.metadata.printMode)continue
    const nA=a.metadata.full_name,nB=b.metadata.full_name
    if(nA.includes('AllureAq')||nB.includes('AllureAq'))continue
    if(METALLIC_RE.test(nA)||METALLIC_RE.test(nB))continue
    const al=alignProfiles(loadProfileMatrix(a as any),loadProfileMatrix(b as any)); if(al.N<100)continue
    const {N,X_A,X_B,D,sampleIds,wavelengths}=al
    let pr=0;for(let i=0;i<N;i++)if(D[i*3]===255&&D[i*3+1]===255&&D[i*3+2]===255){pr=i;break}
    const emA=extractOBAEmission(Array.from(X_A.subarray(pr*L,pr*L+L))),emB=extractOBAEmission(Array.from(X_B.subarray(pr*L,pr*L+L)))
    const fA=computeOBAFactorPerPatch(X_A,L,pr),fB=computeOBAFactorPerPatch(X_B,L,pr)
    const XA_c=subtractOBA(X_A,L,fA,emA.emission),XB_c=subtractOBA(X_B,L,fB,emB.emission)
    const paperWP=paperWPFromBrightestPatch(new Float64Array(X_B.subarray(pr*L,pr*L+L)),1,L,380)
    const tgt={X:X_B,D,channels:3 as const,N,L,wavelengths:wavelengths??[],sampleIds,droppedCount:0}
    const anchorIdx=(pickHeuristicAnchors(tgt).meta?.chosenIdx as number[]).slice(0,K); const aset=new Set(anchorIdx)
    const d1=runPaperRatioResidualTransfer({X_A:XA_c,X_B:XB_c,D,sampleIds,anchorIdx,paperRowIdx:pr,L,paperWP,refProfile:'A',targetProfile:'B',residualRank:RANK,knnK:4,uvBandCount:UV})
    const pred=addOBA(d1.X_pred,L,fB,emB.emission); const des:number[]=[]
    for(let i=0;i<N;i++){if(aset.has(i))continue; const lp=spectraToLab(Array.from(pred.subarray(i*L,i*L+L))),lm=spectraToLab(Array.from(X_B.subarray(i*L,i*L+L))); des.push(deltaE00(lp[0],lp[1],lp[2],lm[0],lm[1],lm[2]))}
    evals.push({ref:short(nA),tgt:short(nB),med:median(des),p95:p95(des),pass:median(des)<=1.5&&p95(des)<=3.0})
  }
  const fail=evals.filter(e=>!e.pass),pass=evals.filter(e=>e.pass)
  console.log(`Pairs: ${evals.length} (fail ${fail.length}, pass ${pass.length})\n`)

  const byShort=new Map<string,Desc>(); for(const p of profiles)byShort.set(short(p.metadata.full_name),desc.get(p.metadata.full_name)!)
  const sortedAbs=(a:number[])=>[...a].sort((x,y)=>x-y)
  const dFns: Record<string,(a:Desc,b:Desc)=>number> = {
    neutral:    (a,b)=>Math.abs(a.neutral-b.neutral),
    primMean:   (a,b)=>Math.abs(mean(a.primCurvs)-mean(b.primCurvs)),
    primVec:    (a,b)=>{const sa=sortedAbs(a.primCurvs),sb=sortedAbs(b.primCurvs);return mean(sa.map((v,i)=>Math.abs(v-sb[i])))},
    primMax:    (a,b)=>Math.abs(Math.max(...a.primCurvs)-Math.max(...b.primCurvs)),
    neutPlusVec:(a,b)=>Math.abs(a.neutral-b.neutral)+ (()=>{const sa=sortedAbs(a.primCurvs),sb=sortedAbs(b.primCurvs);return mean(sa.map((v,i)=>Math.abs(v-sb[i])))})(),
  }

  console.log('=== Descriptor comparison: failure prediction (AUC) + correlation ===')
  console.log(`  ${'descriptor'.padEnd(14)} AUC     r(Δ,p95)  thr≥    catch    FA       refSel(near/far)  nearWins`)
  for(const [name,fn] of Object.entries(dFns)){
    const wd=evals.map(e=>({...e,d:fn(byShort.get(e.ref)!,byShort.get(e.tgt)!)}))
    const fS=wd.filter(e=>!e.pass).map(e=>e.d),pS=wd.filter(e=>e.pass).map(e=>e.d)
    const A=auc(fS,pS), r=pearson(wd.map(e=>e.d),wd.map(e=>e.p95))
    const allv=[...new Set(wd.map(e=>e.d))].sort((a,b)=>a-b); let bJ=-1,bT=0,bTP=0,bFP=0
    for(const t of allv){const tp=wd.filter(e=>!e.pass&&e.d>=t).length,fn2=fail.length-tp,fp=wd.filter(e=>e.pass&&e.d>=t).length,tn=pass.length-fp;const J=(tp/(tp+fn2))-(fp/(fp+tn));if(J>bJ){bJ=J;bT=t;bTP=tp;bFP=fp}}
    const byTgt=new Map<string,typeof wd>(); for(const e of wd){if(!byTgt.has(e.tgt))byTgt.set(e.tgt,[]);byTgt.get(e.tgt)!.push(e)}
    let nw=0,cnt=0,nn:number[]=[],nf:number[]=[]
    for(const [,es] of byTgt){if(es.length<3)continue;const s=[...es].sort((a,b)=>a.d-b.d);nn.push(s[0].p95);nf.push(s[s.length-1].p95);if(s[0].p95<s[s.length-1].p95-0.05)nw++;cnt++}
    console.log(`  ${name.padEnd(14)} ${A.toFixed(3)}   ${r.toFixed(2).padStart(5)}     ${bT.toFixed(3)}   ${bTP}/${fail.length}     ${bFP}/${pass.length}     ${mean(nn).toFixed(2)}/${mean(nf).toFixed(2)}         ${nw}/${cnt}`)
  }

  // detected primaries per profile (hues) for interpretation
  console.log('\n=== Detected primaries (max-chroma per hue) + curvatures ===')
  console.log(`  ${'substrate'.padEnd(22)} neutral  prim-hues(deg)         prim-curvs`)
  for(const p of profiles.filter(p=>!METALLIC_RE.test(p.metadata.full_name)&&!p.metadata.full_name.includes('AllureAq'))){
    const d=desc.get(p.metadata.full_name)!
    console.log(`  ${short(p.metadata.full_name).padEnd(22)} ${d.neutral.toFixed(3)}    [${d.primHues.map(h=>h.toFixed(0).padStart(4)).join(',')}]      [${d.primCurvs.map(c=>c.toFixed(2)).join(', ')}]`)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
