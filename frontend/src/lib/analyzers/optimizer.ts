// frontend/src/lib/analyzers/optimizer.ts
/**
 * Nelder-Mead simplex optimizer for unconstrained minimization.
 * Pure TypeScript implementation, no dependencies.
 * 
 * @module lib/analyzers/optimizer
 */

export interface NelderMeadOptions {
  max_iter?: number
  tol?: number
  initial_simplex_size?: number
}

export interface NelderMeadResult {
  bestPoint: number[]
  bestValue: number
  iterations: number
  converged: boolean
}

export function nelderMead(
  f: (x: number[]) => number,
  x0: number[],
  options: NelderMeadOptions = {},
): NelderMeadResult {
  const { max_iter = 200, tol = 1e-6, initial_simplex_size = 0.05 } = options
  const n = x0.length
  if (n === 0) throw new Error('nelderMead: initial guess must have at least one dimension')

  const simplex: number[][] = [Array.from(x0)]
  for (let i = 0; i < n; i++) {
    const point = Array.from(x0)
    point[i] += initial_simplex_size * (Math.abs(point[i]) || 1)
    simplex.push(point)
  }

  const fValues: number[] = simplex.map((point) => f(point))
  const alpha = 1.0, gamma = 2.0, rho = 0.5, sigma = 0.5
  let iterations = 0, converged = false

  for (let iter = 0; iter < max_iter; iter++) {
    iterations = iter + 1
    const order = fValues.map((_v, i) => i).sort((a, b) => fValues[a] - fValues[b])
    const sortedSimplex = order.map(i => simplex[i])
    const sortedFValues = order.map(i => fValues[i])
    for (let i = 0; i <= n; i++) {
      simplex[i] = sortedSimplex[i]
      fValues[i] = sortedFValues[i]
    }

    let simplexSpread = 0
    for (let i = 1; i <= n; i++) {
      let pointSpread = 0
      for (let j = 0; j < n; j++) {
        pointSpread += (simplex[i][j] - simplex[0][j]) ** 2
      }
      simplexSpread += Math.sqrt(pointSpread)
    }
    if ((fValues[n] - fValues[0] < tol) && (simplexSpread / n < tol)) {
      converged = true
      break
    }

    const centroid = new Array(n).fill(0)
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i][j]
    for (let j = 0; j < n; j++) centroid[j] /= n

    const xReflect = centroid.map((c, j) => c + alpha * (c - simplex[n][j]))
    const fReflect = f(xReflect)

    if (fValues[0] <= fReflect && fReflect < fValues[n - 1]) {
      simplex[n] = xReflect; fValues[n] = fReflect; continue
    }

    if (fReflect < fValues[0]) {
      const xExpand = centroid.map((c, j) => c + gamma * (xReflect[j] - c))
      const fExpand = f(xExpand)
      if (fExpand < fReflect) { simplex[n] = xExpand; fValues[n] = fExpand }
      else { simplex[n] = xReflect; fValues[n] = fReflect }
      continue
    }

    const xContract = centroid.map((c, j) => c + rho * (simplex[n][j] - c))
    const fContract = f(xContract)
    if (fContract < fValues[n]) { simplex[n] = xContract; fValues[n] = fContract; continue }

    for (let i = 1; i <= n; i++) {
      for (let j = 0; j < n; j++) simplex[i][j] = simplex[0][j] + sigma * (simplex[i][j] - simplex[0][j])
      fValues[i] = f(simplex[i])
    }
  }

  return { bestPoint: simplex[0], bestValue: fValues[0], iterations, converged }
}