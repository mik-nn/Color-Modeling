// H36 — spreadCurv as an interpretable substrate parameter.
//
// Hypothesis (user): substrates with similar neutral-ramp spreading curvature
// behave similarly under cross-substrate transfer. spreadCurv is a physically
// interpretable, FEW-PATCH-measurable descriptor (the neutral ramp = ~8 patches).
//
// Validate BEFORE building any model parameter:
//   (a) Does pairwise |ΔspreadCurv| correlate with pair p95 / median ΔE?
//   (b) ROC/AUC — can a threshold on |ΔspreadCurv| separate fail from pass?
//   (c) Reference selection — for each target, does the spreadCurv-NEAREST
//       candidate reference give lower p95 than the spreadCurv-FARTHEST?
//   (d) Substrate clustering by spreadCurv vs print mode.
//
// spreadCurv computed two ways:
//   scalar@560 = ‖c1,c2‖ of the neutral ramp y=R(560)/Rpaper(560)=1+c1·a+c2·a²
//   broadband  = mean_λ ‖c1_λ,c2_λ‖ over all 36 bands
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h36_spreadcurv_param.ts"

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

function pearson(xs: number[], ys: number[]): number {
  const mx=mean(xs),my=mean(ys); let sxy=0,sx=0,sy=0
  for(let i=0;i<xs.length;i++){const dx=xs[i]-mx,dy=ys[i]-my; sxy+=dx*dy;sx+=dx*dx;sy+=dy*dy}
  return sxy/Math.sqrt(sx*sy)
}
function fitQuadNoBias(xs: number[], ys: number[]): [number, number] {
  const n=xs.length; if(n<3)return[0,0]
  let S11=0,S12=0,S22=0,T1=0,T2=0
  for(let i=0;i<n;i++){const x=xs[i],x2=x*x,r=ys[i]-1; S11+=x*x;S12+=x*x2;S22+=x2*x2;T1+=x*r;T2+=x2*r}
  const det=S11*S22-S12*S12; if(Math.abs(det)<1e-18)return[0,0]
  return[(T1*S22-T2*S12)/det,(T2*S11-T1*S12)/det]
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

// spreadCurv: scalar@560 + broadband mean‖c1_λ,c2_λ‖
function spreadCurv(p: LP): { s560: number; bb: number } {
  const m=loadProfileMatrix(p as any); const {X,D,N}=m
  let paperRowIdx=0; for(let i=0;i<N;i++)if(D[i*3]===255&&D[i*3+1]===255&&D[i*3+2]===255){paperRowIdx=i;break}
  // neutral ramp rows
  const rows:number[]=[]; const ais:number[]=[]
  for(let i=0;i<N;i++){const r=D[i*3],g=D[i*3+1],b=D[i*3+2]; if(Math.abs(r-g)+Math.abs(g-b)>10)continue
    const a=(765-r-g-b)/765; if(a<0.01)continue; rows.push(i); ais.push(a)}
  // per-λ fit
  let bbSum=0,bbCnt=0,s560=0
  for(let l=0;l<L;l++){ const pv=X[paperRowIdx*L+l]; if(pv<1e-5)continue
    const ys=rows.map(i=>X[i*L+l]/pv)
    const [c1,c2]=fitQuadNoBias(ais,ys); const mag=Math.hypot(c1,c2)
    bbSum+=mag; bbCnt++
    if(l===18)s560=mag }
  return { s560, bb: bbCnt?bbSum/bbCnt:0 }
}

interface Ev { ref:string; tgt:string; mode:string; med:number; p95:number; pass:boolean; dCurv560:number; dCurvBB:number }
function evalPair(pA:LP, pB:LP, curvA:{s560:number;bb:number}, curvB:{s560:number;bb:number}): Ev | null {
  const al=alignProfiles(loadProfileMatrix(pA as any),loadProfileMatrix(pB as any)); if(al.N<100)return null
  const {N,X_A,X_B,D,sampleIds,wavelengths}=al
  let paperRowIdx=0; for(let i=0;i<N;i++)if(D[i*3]===255&&D[i*3+1]===255&&D[i*3+2]===255){paperRowIdx=i;break}
  const emA=extractOBAEmission(Array.from(X_A.subarray(paperRowIdx*L,paperRowIdx*L+L)))
  const emB=extractOBAEmission(Array.from(X_B.subarray(paperRowIdx*L,paperRowIdx*L+L)))
  const fA=computeOBAFactorPerPatch(X_A,L,paperRowIdx), fB=computeOBAFactorPerPatch(X_B,L,paperRowIdx)
  const XA_c=subtractOBA(X_A,L,fA,emA.emission), XB_c=subtractOBA(X_B,L,fB,emB.emission)
  const paperWP=paperWPFromBrightestPatch(new Float64Array(X_B.subarray(paperRowIdx*L,paperRowIdx*L+L)),1,L,380)
  const tgt={X:X_B,D,channels:3 as const,N,L,wavelengths:wavelengths??[],sampleIds,droppedCount:0}
  const anchorIdx=(pickHeuristicAnchors(tgt).meta?.chosenIdx as number[]).slice(0,K)
  const anchorSet=new Set(anchorIdx)
  const d1=runPaperRatioResidualTransfer({X_A:XA_c,X_B:XB_c,D,sampleIds,anchorIdx,paperRowIdx,L,paperWP,
    refProfile:'A',targetProfile:'B',residualRank:RANK,knnK:4,uvBandCount:UV})
  const pred=addOBA(d1.X_pred,L,fB,emB.emission)
  const des:number[]=[]
  for(let i=0;i<N;i++){ if(anchorSet.has(i))continue
    const lp=spectraToLab(Array.from(pred.subarray(i*L,i*L+L))), lm=spectraToLab(Array.from(X_B.subarray(i*L,i*L+L)))
    des.push(deltaE00(lp[0],lp[1],lp[2],lm[0],lm[1],lm[2])) }
  const med=median(des),p=p95(des)
  return {ref:short(pA.metadata.full_name),tgt:short(pB.metadata.full_name),mode:pA.metadata.printMode!,
    med,p95:p,pass:med<=1.5&&p<=3.0,dCurv560:Math.abs(curvA.s560-curvB.s560),dCurvBB:Math.abs(curvA.bb-curvB.bb)}
}

// AUC via Mann-Whitney: P(fail has higher score than pass)
function auc(failScores: number[], passScores: number[]): number {
  let wins=0,ties=0
  for(const f of failScores)for(const p of passScores){ if(f>p)wins++; else if(f===p)ties++ }
  return (wins+0.5*ties)/(failScores.length*passScores.length)
}

async function main() {
  const files=(await walk(PROFILES_ROOT)).sort()
  const profiles=(await Promise.all(files.filter(f=>path.basename(f).startsWith('BC_')).map(loadProfile))).filter(Boolean) as LP[]
  const curv=new Map<string,{s560:number;bb:number}>()
  for(const p of profiles)curv.set(p.metadata.full_name, spreadCurv(p))

  const evals:Ev[]=[]
  for(const a of profiles)for(const b of profiles){ if(a===b||a.metadata.printMode!==b.metadata.printMode)continue
    const nA=a.metadata.full_name,nB=b.metadata.full_name
    if(nA.includes('AllureAq')||nB.includes('AllureAq'))continue
    if(METALLIC_RE.test(nA)||METALLIC_RE.test(nB))continue
    const e=evalPair(a,b,curv.get(nA)!,curv.get(nB)!); if(e)evals.push(e) }
  const fail=evals.filter(e=>!e.pass), pass=evals.filter(e=>e.pass)
  console.log(`Pairs: ${evals.length} (fail ${fail.length}, pass ${pass.length})\n`)

  // ── (a) correlation ───────────────────────────────────────────────────────
  console.log('=== (a) |ΔspreadCurv| vs pair error (all 104 pairs) ===')
  console.log(`  r(|Δcurv560|, p95)   = ${pearson(evals.map(e=>e.dCurv560),evals.map(e=>e.p95)).toFixed(3)}`)
  console.log(`  r(|Δcurv560|, median)= ${pearson(evals.map(e=>e.dCurv560),evals.map(e=>e.med)).toFixed(3)}`)
  console.log(`  r(|ΔcurvBB|,  p95)   = ${pearson(evals.map(e=>e.dCurvBB),evals.map(e=>e.p95)).toFixed(3)}`)
  console.log(`  r(|ΔcurvBB|,  median)= ${pearson(evals.map(e=>e.dCurvBB),evals.map(e=>e.med)).toFixed(3)}`)
  console.log(`  mean |Δcurv560|: fail=${mean(fail.map(e=>e.dCurv560)).toFixed(3)}  pass=${mean(pass.map(e=>e.dCurv560)).toFixed(3)}`)
  console.log(`  mean |ΔcurvBB| : fail=${mean(fail.map(e=>e.dCurvBB)).toFixed(3)}  pass=${mean(pass.map(e=>e.dCurvBB)).toFixed(3)}`)

  // ── (b) ROC / AUC + best threshold ────────────────────────────────────────
  console.log('\n=== (b) Can |ΔspreadCurv| predict failure? (ROC) ===')
  for(const [label,key] of [['Δcurv560','dCurv560'],['ΔcurvBB','dCurvBB']] as const){
    const fs_=fail.map(e=>e[key]), ps_=pass.map(e=>e[key])
    const A=auc(fs_,ps_)
    // best threshold by Youden J
    const allv=[...new Set(evals.map(e=>e[key]))].sort((a,b)=>a-b)
    let bestJ=-1,bestT=0,bestTP=0,bestFP=0
    for(const t of allv){
      const tp=fail.filter(e=>e[key]>=t).length, fn=fail.length-tp
      const fp=pass.filter(e=>e[key]>=t).length, tn=pass.length-fp
      const tpr=tp/(tp+fn), fpr=fp/(fp+tn), J=tpr-fpr
      if(J>bestJ){bestJ=J;bestT=t;bestTP=tp;bestFP=fp}
    }
    console.log(`  ${label}: AUC=${A.toFixed(3)}  best-threshold≥${bestT.toFixed(3)} → catches ${bestTP}/${fail.length} fails, ${bestFP}/${pass.length} false-alarms (Youden J=${bestJ.toFixed(2)})`)
  }

  // ── (c) reference selection by spreadCurv proximity ───────────────────────
  console.log('\n=== (c) Reference selection: spreadCurv-nearest vs farthest ref ===')
  console.log('  For each target, among same-mode candidate refs, compare p95 of nearest vs farthest by |Δcurv560|')
  const byTgt=new Map<string,Ev[]>()
  for(const e of evals){ if(!byTgt.has(e.tgt))byTgt.set(e.tgt,[]); byTgt.get(e.tgt)!.push(e) }
  let nearWins=0,farWins=0,ties=0,nNear:number[]=[],nFar:number[]=[]
  for(const [tgt,es] of byTgt){ if(es.length<3)continue
    const sorted=[...es].sort((a,b)=>a.dCurv560-b.dCurv560)
    const near=sorted[0], far=sorted[sorted.length-1]
    nNear.push(near.p95); nFar.push(far.p95)
    if(near.p95<far.p95-0.05)nearWins++; else if(near.p95>far.p95+0.05)farWins++; else ties++
  }
  console.log(`  nearest-ref better: ${nearWins}  farthest better: ${farWins}  tie: ${ties}`)
  console.log(`  mean p95: nearest-curv ref=${mean(nNear).toFixed(2)}  farthest-curv ref=${mean(nFar).toFixed(2)}`)
  // pass-rate of nearest vs farthest
  let nearPass=0,farPass=0,cnt=0
  for(const [tgt,es] of byTgt){ if(es.length<3)continue
    const sorted=[...es].sort((a,b)=>a.dCurv560-b.dCurv560)
    if(sorted[0].pass)nearPass++; if(sorted[sorted.length-1].pass)farPass++; cnt++ }
  console.log(`  pass-rate: nearest-curv ref ${nearPass}/${cnt}  farthest-curv ref ${farPass}/${cnt}`)

  // ── (d) substrate clustering ──────────────────────────────────────────────
  console.log('\n=== (d) Substrates by spreadCurv (sorted), with print mode ===')
  const subs=[...new Set(profiles.map(p=>p.metadata.full_name))]
    .map(n=>({n:short(n),mode:profiles.find(p=>p.metadata.full_name===n)!.metadata.printMode!,c:curv.get(n)!}))
    .filter(s=>!METALLIC_RE.test(s.n)&&!s.n.includes('AllureAq'))
    .sort((a,b)=>a.c.s560-b.c.s560)
  console.log(`  ${'substrate'.padEnd(22)} ${'mode'.padEnd(14)} curv560   curvBB`)
  for(const s of subs)console.log(`  ${s.n.padEnd(22)} ${s.mode.padEnd(14)} ${s.c.s560.toFixed(3).padStart(6)}   ${s.c.bb.toFixed(3).padStart(6)}`)
}
main().catch(e => { console.error(e); process.exit(1) })
