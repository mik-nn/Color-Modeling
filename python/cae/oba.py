"""Python port of frontend/src/lib/predict/obaSeparator.ts.

Used to pre-clean spectra for the D7 CAE variant. Algorithm:

  1. Fit a degree-2 polynomial to R_paper(λ) over the OBA-free band
     λ ∈ [460, 730] nm.
  2. Extrapolate the polynomial back into [380, 450] → substrate base.
  3. OBA emission(λ) = max(0, R_paper(λ) − base(λ)) on the OBA band.
  4. Per-patch factor = clamp(R_patch(380) / R_paper(380), 0, 1).
  5. R_clean = R_measured − factor · emission, applied to every patch.

Keep the TS and Python implementations in lockstep. If either changes,
update both.
"""

from __future__ import annotations

from typing import Sequence

import numpy as np

START_WL = 380
STEP_NM = 10
OBA_BAND = (380, 450)
BASE_BAND = (460, 730)


def fit_quadratic(xs: Sequence[float], ys: Sequence[float], center: float = 600.0):
    """Closed-form OLS quadratic fit on (xs, ys); evaluates on (x - center) / 100."""
    xs_arr = (np.asarray(xs, dtype=np.float64) - center) / 100.0
    ys_arr = np.asarray(ys, dtype=np.float64)
    X = np.stack([np.ones_like(xs_arr), xs_arr, xs_arr ** 2], axis=1)
    coeffs, *_ = np.linalg.lstsq(X, ys_arr, rcond=None)
    return coeffs, center


def eval_poly(coeffs, center, lam):
    x = (lam - center) / 100.0
    return coeffs[0] + coeffs[1] * x + coeffs[2] * x * x


def extract_oba_emission(paper_spec: np.ndarray, start_wl: int = START_WL, step: int = STEP_NM):
    """Returns the per-λ OBA emission vector (length L).

    Zero outside the OBA band; non-negative everywhere.
    """
    L = paper_spec.shape[0]
    lams = start_wl + step * np.arange(L)
    base_mask = (lams >= BASE_BAND[0]) & (lams <= BASE_BAND[1])
    oba_mask = (lams >= OBA_BAND[0]) & (lams <= OBA_BAND[1])
    coeffs, center = fit_quadratic(lams[base_mask], paper_spec[base_mask])
    base = np.array([eval_poly(coeffs, center, lam) for lam in lams])
    excess = np.where(oba_mask, paper_spec - base, 0.0)
    return np.maximum(0.0, excess)


def per_patch_factor(
    spectra: np.ndarray,
    paper_idx: int,
    probe_wl: int = START_WL,
    start_wl: int = START_WL,
    step: int = STEP_NM,
) -> np.ndarray:
    """UV-block proxy: factor[i] = clamp(R[i, 380]/R_paper(380), 0, 1)."""
    probe_idx = round((probe_wl - start_wl) / step)
    paper_r = spectra[paper_idx, probe_idx]
    if paper_r <= 1e-6:
        return np.ones(spectra.shape[0], dtype=np.float64)
    ratios = spectra[:, probe_idx] / paper_r
    return np.clip(ratios, 0.0, 1.0)


def subtract_oba(spectra: np.ndarray, factors: np.ndarray, emission: np.ndarray) -> np.ndarray:
    out = spectra - factors[:, None] * emission[None, :]
    return np.clip(out, 0.0, 1.0)


def add_oba(spectra_clean: np.ndarray, factors: np.ndarray, emission: np.ndarray) -> np.ndarray:
    out = spectra_clean + factors[:, None] * emission[None, :]
    return np.clip(out, 0.0, 1.0)
