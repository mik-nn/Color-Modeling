// src/lib/analyzers/optimizer.test.ts
import { describe, it, expect } from 'vitest'
import { nelderMead} from './optimizer'

describe('nelderMead', () => {
  it('minimizes Rosenbrock function', () => {
    // Rosenbrock: f(x,y) = (a-x)^2 + b(y-x^2)^2, minimum at (a, a^2)
    const rosenbrock = (x: number[]) => {
      const [a, b] = [1, 100]
      return (a - x[0]) ** 2 + b * (x[1] - x[0] ** 2) ** 2
    }

    const result = nelderMead(rosenbrock, [0, 0], {
      max_iter: 500,
      tol: 1e-8,
      initial_simplex_size: 0.1,
    })

    expect(result.converged).toBe(true)
    expect(result.bestPoint[0]).toBeCloseTo(1, 4)
    expect(result.bestPoint[1]).toBeCloseTo(1, 4)
    expect(result.bestValue).toBeLessThan(1e-6)
  })

  it('minimizes quadratic function', () => {
    const quadratic = (x: number[]) => (x[0] - 3) ** 2 + (x[1] + 2) ** 2 + 5

    const result = nelderMead(quadratic, [0, 0], {
      max_iter: 200,
      tol: 1e-8,
    })

    expect(result.bestPoint[0]).toBeCloseTo(3, 5)
    expect(result.bestPoint[1]).toBeCloseTo(-2, 5)
    expect(result.bestValue).toBeCloseTo(5, 5)
  })

  it('handles 1D optimization', () => {
    const parabola = (x: number[]) => (x[0] - 5) ** 2 + 10

    const result = nelderMead(parabola, [0], {
      max_iter: 100,
      tol: 1e-8,
    })

    expect(result.bestPoint[0]).toBeCloseTo(5, 6)
    expect(result.bestValue).toBeCloseTo(10, 6)
  })

  it('respects max_iter limit', () => {
    const slowFunc = (x: number[]) => {
      let sum = 0
      for (let i = 0; i < x.length; i++) {
        sum += (x[i] - i) ** 2
      }
      return sum
    }

    const result = nelderMead(slowFunc, [0, 0, 0, 0], {
      max_iter: 10,
      tol: 1e-10, // Very strict to force non-convergence
    })

    expect(result.iterations).toBe(10)
    expect(result.converged).toBe(false)
  })

  it('throws on empty initial guess', () => {
    expect(() => nelderMead((x) => x[0], [])).toThrow(
      'nelderMead: initial guess must have at least one dimension',
    )
  })

  it('finds minimum of Beale function', () => {
    // Beale: f(x,y) = (1.5-x+xy)^2 + (2.25-x+xy^2)^2 + (2.625-x+xy^3)^2
    // Minimum at (3, 0.5) with f = 0
    const beale = (x: number[]) => {
      const [xi, yi] = x
      return (
        (1.5 - xi + xi * yi) ** 2 +
        (2.25 - xi + xi * yi ** 2) ** 2 +
        (2.625 - xi + xi * yi ** 3) ** 2
      )
    }

    const result = nelderMead(beale, [0, 0], {
      max_iter: 500,
      tol: 1e-8,
      initial_simplex_size: 0.1,
    })

    expect(result.converged).toBe(true)
    expect(result.bestPoint[0]).toBeCloseTo(3, 3)
    expect(result.bestPoint[1]).toBeCloseTo(0.5, 3)
    expect(result.bestValue).toBeLessThan(1e-5)
  })
})