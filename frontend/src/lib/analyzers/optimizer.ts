// optimizer.ts — Pure TypeScript Nelder-Mead simplex optimizer.
//
// Implements the classic Nelder–Mead downhill simplex method.
// No external dependencies; suitable for small parameter spaces (≤10 DOF).
//
// Standard reflection coefficients (Gao & Han 2012):
//   α=1 (reflect), γ=2 (expand), ρ=0.5 (contract), σ=0.5 (shrink)

export interface NelderMeadOptions {
  maxIter?: number;
  ftol?: number;   // convergence tolerance on function range
  xtol?: number;   // convergence tolerance on simplex diameter
  initialStep?: number | number[];  // initial perturbation per dimension
}

export interface NelderMeadResult {
  x: number[];
  fval: number;
  nIter: number;
  nEval: number;
  converged: boolean;
}

export function nelderMead(
  fn: (x: number[]) => number,
  x0: number[],
  options: NelderMeadOptions = {},
): NelderMeadResult {
  const n = x0.length;
  const maxIter = options.maxIter ?? 200 * n;
  const ftol = options.ftol ?? 1e-8;
  const xtol = options.xtol ?? 1e-8;

  // Build initial simplex: x0 plus n perturbed vertices
  const steps: number[] = Array.isArray(options.initialStep)
    ? options.initialStep
    : new Array(n).fill(options.initialStep ?? 0.05);

  const simplex: number[][] = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const v = x0.slice();
    v[i] = v[i] !== 0 ? v[i] * (1 + steps[i]) : steps[i];
    simplex.push(v);
  }

  const fvals = simplex.map(fn);
  let nEval = n + 1;

  // Index order array (reused each iteration to avoid allocation)
  const ord = Array.from({ length: n + 1 }, (_, i) => i);

  for (let iter = 0; iter < maxIter; iter++) {
    // Sort indices by function value
    ord.sort((a, b) => fvals[a] - fvals[b]);
    const iBest = ord[0];
    const iWorst = ord[n];
    const i2nd = ord[n - 1];

    // Convergence: both function range and simplex diameter must be small
    let maxDiam = 0;
    for (let d = 0; d < n; d++) {
      const bv = simplex[iBest][d];
      for (let i = 1; i <= n; i++) {
        const dv = Math.abs(simplex[ord[i]][d] - bv);
        if (dv > maxDiam) maxDiam = dv;
      }
    }
    if (fvals[iWorst] - fvals[iBest] < ftol && maxDiam < xtol) {
      return { x: simplex[iBest].slice(), fval: fvals[iBest], nIter: iter, nEval, converged: true };
    }

    // Centroid of all vertices except worst
    const xo = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let d = 0; d < n; d++) xo[d] += simplex[ord[i]][d];
    }
    for (let d = 0; d < n; d++) xo[d] /= n;

    const xw = simplex[iWorst];

    // Reflection: xr = xo + α*(xo − xw), α=1
    const xr = xo.map((c, d) => 2 * c - xw[d]);
    const fr = fn(xr); nEval++;

    if (fr < fvals[iBest]) {
      // Expansion: xe = xo + γ*(xr − xo), γ=2
      const xe = xo.map((c, d) => 3 * c - 2 * xw[d]);
      const fe = fn(xe); nEval++;
      if (fe < fr) {
        simplex[iWorst] = xe; fvals[iWorst] = fe;
      } else {
        simplex[iWorst] = xr; fvals[iWorst] = fr;
      }
    } else if (fr < fvals[i2nd]) {
      simplex[iWorst] = xr; fvals[iWorst] = fr;
    } else {
      // Contraction
      if (fr < fvals[iWorst]) {
        // Outside contraction: xc = xo + ρ*(xr − xo), ρ=0.5
        const xc = xo.map((c, d) => 1.5 * c - 0.5 * xw[d]);
        const fc = fn(xc); nEval++;
        if (fc <= fr) {
          simplex[iWorst] = xc; fvals[iWorst] = fc; continue;
        }
      } else {
        // Inside contraction: xc = xo − ρ*(xo − xw)
        const xc = xo.map((c, d) => 0.5 * c + 0.5 * xw[d]);
        const fc = fn(xc); nEval++;
        if (fc < fvals[iWorst]) {
          simplex[iWorst] = xc; fvals[iWorst] = fc; continue;
        }
      }
      // Shrink: all vertices toward best, σ=0.5
      const xBest = simplex[iBest];
      for (let i = 1; i <= n; i++) {
        const v = simplex[ord[i]];
        for (let d = 0; d < n; d++) v[d] = 0.5 * (xBest[d] + v[d]);
        fvals[ord[i]] = fn(v); nEval++;
      }
    }
  }

  ord.sort((a, b) => fvals[a] - fvals[b]);
  return {
    x: simplex[ord[0]].slice(),
    fval: fvals[ord[0]],
    nIter: maxIter,
    nEval,
    converged: false,
  };
}
