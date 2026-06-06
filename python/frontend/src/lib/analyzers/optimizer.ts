// src/lib/analyzers/optimizer.ts
/**
 * Nelder-Mead simplex optimizer for unconstrained minimization.
 * Pure TypeScript implementation, no dependencies.
 * 
 * @module lib/analyzers/optimizer
 * @see https://en.wikipedia.org/wiki/Nelder%E2%80%93Mead_method
 */

export interface NelderMeadOptions {
  /** Maximum iterations (default: 200). */
  max_iter?: number
  /** Convergence tolerance on function value (default: 1e-6). */
  tol?: number
  /** Initial simplex size multiplier (default: 0.05). Applied to each coordinate. */
  initial_simplex_size?: number
}

export interface NelderMeadResult {
  /** Best point found (array of parameters). */
  bestPoint: number[]
  /** Function value at best point. */
  bestValue: number
  /** Number of iterations performed. */
  iterations: number
  /** Whether convergence criterion was met. */
  converged: boolean
}

/**
 * Minimizes a scalar function f(x) using the Nelder-Mead simplex algorithm.
 * 
 * @param f - Objective function to minimize. Takes array of parameters, returns scalar.
 * @param x0 - Initial guess (array of parameters).
 * @param options - Optimization options (max_iter, tol, initial_simplex_size).
 * @returns Optimization result with best point, value, and convergence status.
 * 
 * @example
 * ```typescript
 * const f = (x: number[]) => (x[0] - 1) ** 2 + (x[1] - 2) ** 2
 * const result = nelderMead(f, [0, 0], { max_iter: 100, tol: 1e-6 })
 * // result.bestPoint ≈ [1, 2], result.bestValue ≈ 0
 * ```
 */
export function nelderMead(
  f: (x: number[]) => number,
  x0: number[],
  options: NelderMeadOptions = {},
): NelderMeadResult {
  const {
    max_iter = 200,
    tol = 1e-6,
    initial_simplex_size = 0.05,
  } = options

  const n = x0.length
  if (n === 0) {
    throw new Error('nelderMead: initial guess must have at least one dimension')
  }

  // Initialize simplex: x0 plus n points offset along each axis
  const simplex: number[][] = [Array.from(x0)]
  for (let i = 0; i < n; i++) {
    const point = Array.from(x0)
    point[i] += initial_simplex_size * (Math.abs(point[i]) || 1)
    simplex.push(point)
  }

  // Evaluate function at all simplex vertices
  const fValues: number[] = simplex.map((point) => f(point))

  // Nelder-Mead coefficients
  const alpha = 1.0 // Reflection
  const gamma = 2.0 // Expansion
  const rho = 0.5 // Contraction
  const sigma = 0.5 // Shrink

  let iterations = 0
  let converged = false

  for (let iter = 0; iter < max_iter; iter++) {
    iterations = iter + 1

    // Sort simplex by function value (ascending)
    const order = fValues.map((v, i) => i).sort((a, b) => fValues[a] - fValues[b])
    for (let i = 0; i < n + 1; i++) {
      if (i > order[i]) {
        // Swap
        ;[simplex[i], simplex[order[i]]] = [simplex[order[i]], simplex[i]]
        ;[fValues[i], fValues[order[i]]] = [fValues[order[i]], fValues[i]]
      }
    }

    // Check convergence: range of function values
    const fRange = fValues[n] - fValues[0]
    if (fRange < tol) {
      converged = true
      break
    }

    // Compute centroid of all points except worst
    const centroid = new Array(n).fill(0)
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        centroid[j] += simplex[i][j]
      }
    }
    for (let j = 0; j < n; j++) {
      centroid[j] /= n
    }

    // Reflection
    const xReflect = new Array(n)
    for (let j = 0; j < n; j++) {
      xReflect[j] = centroid[j] + alpha * (centroid[j] - simplex[n][j])
    }
    const fReflect = f(xReflect)

    if (fValues[0] <= fReflect && fReflect < fValues[n - 1]) {
      // Accept reflection
      simplex[n] = xReflect
      fValues[n] = fReflect
      continue
    }

    // Expansion
    if (fReflect < fValues[0]) {
      const xExpand = new Array(n)
      for (let j = 0; j < n; j++) {
        xExpand[j] = centroid[j] + gamma * (xReflect[j] - centroid[j])
      }
      const fExpand = f(xExpand)

      if (fExpand < fReflect) {
        // Accept expansion
        simplex[n] = xExpand
        fValues[n] = fExpand
      } else {
        // Accept reflection
        simplex[n] = xReflect
        fValues[n] = fReflect
      }
      continue
    }

    // Contraction
    const xContract = new Array(n)
    for (let j = 0; j < n; j++) {
      xContract[j] = centroid[j] + rho * (simplex[n][j] - centroid[j])
    }
    const fContract = f(xContract)

    if (fContract < fValues[n]) {
      // Accept contraction
      simplex[n] = xContract
      fValues[n] = fContract
      continue
    }

    // Shrink: move all points toward best point
    for (let i = 1; i <= n; i++) {
      for (let j = 0; j < n; j++) {
        simplex[i][j] = simplex[0][j] + sigma * (simplex[i][j] - simplex[0][j])
      }
      fValues[i] = f(simplex[i])
    }
  }

  return {
    bestPoint: simplex[0],
    bestValue: fValues[0],
    iterations,
    converged,
  }
}