// optimizer.test.ts
import { describe, it, expect } from 'vitest';
import { nelderMead } from './optimizer';

describe('nelderMead', () => {
  it('minimizes 1D quadratic x^2 → x≈0', () => {
    const r = nelderMead(x => x[0] ** 2, [3]);
    expect(r.x[0]).toBeCloseTo(0, 3);
    expect(r.fval).toBeCloseTo(0, 6);
  });

  it('minimizes 2D Rosenbrock → (1,1)', () => {
    // f(x,y) = (1-x)^2 + 100*(y-x^2)^2
    const rosenbrock = (x: number[]) =>
      (1 - x[0]) ** 2 + 100 * (x[1] - x[0] ** 2) ** 2;
    const r = nelderMead(rosenbrock, [0, 0], { maxIter: 5000, ftol: 1e-10 });
    expect(r.x[0]).toBeCloseTo(1, 2);
    expect(r.x[1]).toBeCloseTo(1, 2);
  });

  it('minimizes 3D sphere → (0,0,0)', () => {
    const r = nelderMead(x => x[0] ** 2 + x[1] ** 2 + x[2] ** 2, [1, -2, 3]);
    expect(r.fval).toBeCloseTo(0, 4);
  });

  it('converges flag set correctly', () => {
    // Should converge with generous maxIter
    const r = nelderMead(x => x[0] ** 2, [1], { maxIter: 1000 });
    expect(r.converged).toBe(true);
    // Should not converge with maxIter=1
    const r2 = nelderMead(x => x[0] ** 2 + x[1] ** 2, [10, 10], { maxIter: 1 });
    expect(r2.converged).toBe(false);
  });

  it('nEval > 0', () => {
    const r = nelderMead(x => x[0] ** 2, [5]);
    expect(r.nEval).toBeGreaterThan(0);
  });
});
