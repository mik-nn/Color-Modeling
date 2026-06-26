// src/lib/analyzers/gamutVolume.ts
//
// Convex-hull volume of a 3D point cloud, plus a per-hue-bin chroma boundary.
// Used to quantify how much of a profile's Lab gamut body survives an ink limit
// (H45). Pure functions, no project dependencies — points are plain [x, y, z]
// triples (for gamut work: [L*, a*, b*]).
//
// The hull is built with an incremental (quickhull-style) algorithm: seed a
// non-degenerate tetrahedron, then add each remaining point by deleting the
// faces it can "see" and stitching new faces across the horizon. Volume is the
// divergence-theorem sum of signed tetrahedra over the outward-oriented faces.

type V3 = readonly [number, number, number]

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a: V3): number => Math.hypot(a[0], a[1], a[2])

interface Face {
  a: number
  b: number
  c: number
}

/** Unit-normal signed distance of point x in front of an outward CCW face. */
function signedDistance(pts: V3[], f: Face, x: V3): number {
  const pa = pts[f.a]
  const n = cross(sub(pts[f.b], pa), sub(pts[f.c], pa))
  const len = norm(n)
  if (len === 0) return 0
  return dot(n, sub(x, pa)) / len
}

/** Seed indices of a non-degenerate tetrahedron, or null if the cloud is flat. */
function seedTetra(pts: V3[]): [number, number, number, number] | null {
  const n = pts.length
  const eps = 1e-9

  // i0: any point. i1: farthest from i0.
  let i1 = -1
  let best = eps
  for (let i = 1; i < n; i++) {
    const d = norm(sub(pts[i], pts[0]))
    if (d > best) {
      best = d
      i1 = i
    }
  }
  if (i1 < 0) return null

  // i2: farthest from the line p0–pi1.
  const lineDir = sub(pts[i1], pts[0])
  let i2 = -1
  best = eps
  for (let i = 1; i < n; i++) {
    if (i === i1) continue
    const area = norm(cross(sub(pts[i], pts[0]), lineDir))
    if (area > best) {
      best = area
      i2 = i
    }
  }
  if (i2 < 0) return null

  // i3: farthest from the plane p0–pi1–pi2.
  const planeN = cross(sub(pts[i1], pts[0]), sub(pts[i2], pts[0]))
  let i3 = -1
  best = eps
  for (let i = 1; i < n; i++) {
    if (i === i1 || i === i2) continue
    const vol = Math.abs(dot(sub(pts[i], pts[0]), planeN))
    if (vol > best) {
      best = vol
      i3 = i
    }
  }
  if (i3 < 0) return null

  return [0, i1, i2, i3]
}

/**
 * Convex-hull volume of a set of 3D points. Returns 0 for < 4 points or for a
 * degenerate (collinear / coplanar) cloud.
 */
export function gamutHullVolume(points: readonly (readonly number[])[]): number {
  if (points.length < 4) return 0
  const pts: V3[] = points.map((p) => [p[0], p[1], p[2]] as V3)

  const seed = seedTetra(pts)
  if (!seed) return 0
  const [s0, s1, s2, s3] = seed

  // Build the seed tetra with every face oriented outward (normal points away
  // from the opposite, 4th vertex).
  const faces: Face[] = []
  const addOriented = (a: number, b: number, c: number, opp: number) => {
    const n = cross(sub(pts[b], pts[a]), sub(pts[c], pts[a]))
    faces.push(dot(n, sub(pts[opp], pts[a])) > 0 ? { a, b: c, c: b } : { a, b, c })
  }
  addOriented(s0, s1, s2, s3)
  addOriented(s0, s1, s3, s2)
  addOriented(s0, s2, s3, s1)
  addOriented(s1, s2, s3, s0)

  const seedSet = new Set([s0, s1, s2, s3])
  const eps = 1e-7

  for (let p = 0; p < pts.length; p++) {
    if (seedSet.has(p)) continue
    const x = pts[p]

    const visible: Face[] = []
    const kept: Face[] = []
    for (const f of faces) {
      if (signedDistance(pts, f, x) > eps) visible.push(f)
      else kept.push(f)
    }
    if (visible.length === 0) continue // point already inside the hull

    // Horizon = directed edges of visible faces whose twin is not visible.
    const visibleEdges = new Set<string>()
    for (const f of visible) {
      visibleEdges.add(`${f.a},${f.b}`)
      visibleEdges.add(`${f.b},${f.c}`)
      visibleEdges.add(`${f.c},${f.a}`)
    }
    const horizon: Array<[number, number]> = []
    const consider = (u: number, v: number) => {
      if (!visibleEdges.has(`${v},${u}`)) horizon.push([u, v])
    }
    for (const f of visible) {
      consider(f.a, f.b)
      consider(f.b, f.c)
      consider(f.c, f.a)
    }

    // New faces: keep the horizon edge direction so orientation stays outward.
    for (const [u, v] of horizon) kept.push({ a: u, b: v, c: p })
    faces.length = 0
    faces.push(...kept)
  }

  // Divergence theorem: V = (1/6) Σ pa · (pb × pc) over outward faces.
  let sixV = 0
  for (const f of faces) {
    sixV += dot(pts[f.a], cross(pts[f.b], pts[f.c]))
  }
  return Math.abs(sixV) / 6
}

/**
 * Largest chroma C*ab per hue bin (default 10° → 36 bins). Input points are
 * Lab triples [L, a, b]; empty bins are 0. This is the chromatic gamut boundary,
 * the physically meaningful complement to total hull volume.
 */
export function maxChromaPerHueBin(
  labPoints: readonly (readonly number[])[],
  binDeg = 10,
): number[] {
  const nBins = Math.round(360 / binDeg)
  const out = new Array<number>(nBins).fill(0)
  for (const p of labPoints) {
    const a = p[1]
    const b = p[2]
    const chroma = Math.hypot(a, b)
    let hue = (Math.atan2(b, a) * 180) / Math.PI
    if (hue < 0) hue += 360
    let bin = Math.floor(hue / binDeg)
    if (bin >= nBins) bin = nBins - 1
    if (chroma > out[bin]) out[bin] = chroma
  }
  return out
}
