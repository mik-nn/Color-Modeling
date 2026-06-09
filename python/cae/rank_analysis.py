"""
Rank analysis of per-pair spectral residuals.

For every directed pair (A, B) computes:
  D[g, λ] = R_B[g, λ] - R_A[g, λ]          (raw residual)
  T[g, λ] = R_B[g, λ] / R_A[g, λ]          (paper-relative ratio)
  D'       = D after OBA-whitening (variant d7)

SVD of each residual matrix → singular values → effective rank.

Results cached in weights/rank_analysis.npz.
Subsequent runs skip recomputation and go straight to reporting.

Usage:
    python rank_analysis.py              # use d7 (OBA-cleaned) variant
    python rank_analysis.py --variant raw
    python rank_analysis.py --force      # ignore cache, recompute
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
CACHE_DIR = HERE / "weights"
CACHE_DIR.mkdir(exist_ok=True)


def _canonical_preset(full_name: str) -> str:
    """Best-effort preset extraction from profile full_name string."""
    fn = full_name.lower()
    if "wcrw" in fn or "watercolor" in fn:
        return "WCRW"
    if "usfa" in fn or "ultra smooth" in fn:
        return "USFA"
    if "canvas" in fn:
        return "CanvasMatte"
    if "premiumluster" in fn or "premium luster" in fn:
        return "PremiumLuster"
    if "ultra prem" in fn and "matte" in fn:
        return "UltraPremMatte"
    if "ultra prem" in fn and "luster" in fn:
        return "UltraPremLuster"
    if "epsonproof" in fn or "epson proof" in fn:
        return "EpsonProof"
    # fallback: first token
    return full_name.split()[0]


def effective_rank(sv: np.ndarray, threshold: float = 0.99) -> int:
    """Number of singular values capturing `threshold` fraction of total variance."""
    energy = sv ** 2
    cumsum = np.cumsum(energy) / energy.sum()
    hits = np.where(cumsum >= threshold)[0]
    return int(hits[0]) + 1 if len(hits) else len(sv)


def run_analysis(variant: str = "d7", force: bool = False) -> dict:
    cache_path = CACHE_DIR / f"rank_analysis_{variant}.npz"

    meta_path = cache_path.with_suffix(".json")
    if cache_path.exists() and meta_path.exists() and not force:
        print(f"Loading cached results from {cache_path}")
        # allow_pickle=False is safe: .npz contains only numeric arrays;
        # string fields (names, presets, variant) live in the .json sidecar.
        arrays = np.load(str(cache_path), allow_pickle=False)
        result = {k: arrays[k] for k in arrays.files}
        with open(meta_path) as fh:
            meta = json.load(fh)
        result["names"]   = np.array(meta["names"])
        result["presets"] = np.array(meta["presets"])
        result["variant"] = meta["variant"]
        result["pair_same"] = result["pair_same"].astype(bool)
        # N and L not stored in numeric arrays — derive from sv_all shape and names
        result["N"] = np.int32(0)   # not needed for report()
        result["L"] = np.int32(result["sv_all"].shape[1])
        return result

    print(f"Computing rank analysis (variant={variant}) …")

    # Import here to avoid torch requirement at top-level when only reporting.
    from dataset import ProfileBank

    # Prefer the full 27-profile export; fall back to the filtered profiles-mk.json.
    all_path = HERE / "../../frontend/data/cae-input/profiles-all.json"
    mk_path  = HERE / "../../frontend/data/cae-input/profiles-mk.json"
    data_path = all_path if all_path.exists() else mk_path
    print(f"  Loading profiles from {data_path.name} …")
    with open(data_path) as fh:
        payload = json.load(fh)
    profiles_list = payload if isinstance(payload, list) else payload["profiles"]
    bank = ProfileBank(profiles_list, variant=variant)
    P = len(bank.profiles)
    N = bank.N
    L = bank.L

    names = [p["full_name"] for p in bank.profiles]
    presets = np.array([_canonical_preset(n) for n in names])

    print(f"  {P} profiles, {N} patches, {L} wavelengths")

    # Collect per-pair SVD stats.
    # For each (a, b): SVD of D = R_B - R_A  (shape N×L)
    n_pairs = P * (P - 1)
    pair_ref   = []
    pair_tgt   = []
    pair_same  = []          # bool: same preset
    sv_all     = np.zeros((n_pairs, min(N, L)), dtype=np.float32)
    rank99     = np.zeros(n_pairs, dtype=np.int32)  # eff. rank @ 99% energy
    rank95     = np.zeros(n_pairs, dtype=np.int32)  # eff. rank @ 95% energy
    rms_total  = np.zeros(n_pairs, dtype=np.float32)

    idx = 0
    for a in range(P):
        for b in range(P):
            if a == b:
                continue
            D = bank.spectra[b].astype(np.float64) - bank.spectra[a].astype(np.float64)
            # centre columns (remove mean spectrum) — optional but helps SVD interpretability
            D -= D.mean(axis=0, keepdims=True)

            # thin SVD: shape (N, L) → sv has min(N,L) values
            _, sv, _ = np.linalg.svd(D, full_matrices=False)

            sv_all[idx] = sv.astype(np.float32)
            rank99[idx] = effective_rank(sv, 0.99)
            rank95[idx] = effective_rank(sv, 0.95)
            rms_total[idx] = float(np.sqrt((D ** 2).mean()))
            pair_ref.append(a)
            pair_tgt.append(b)
            pair_same.append(presets[a] == presets[b])

            if idx % 50 == 0:
                print(f"  {idx}/{n_pairs} pairs …")
            idx += 1

    pair_ref  = np.array(pair_ref,  dtype=np.int32)
    pair_tgt  = np.array(pair_tgt,  dtype=np.int32)
    pair_same = np.array(pair_same, dtype=bool)

    numeric = dict(
        sv_all=sv_all,
        rank99=rank99,
        rank95=rank95,
        rms_total=rms_total,
        pair_ref=pair_ref,
        pair_tgt=pair_tgt,
        pair_same=pair_same.astype(np.uint8),
    )
    # Strings go to a JSON sidecar so the .npz never needs allow_pickle=True.
    meta = dict(variant=variant, names=names, presets=list(presets))

    np.savez_compressed(str(cache_path), **numeric)
    with open(cache_path.with_suffix(".json"), "w") as fh:
        json.dump(meta, fh)
    print(f"Saved → {cache_path} + .json sidecar")

    result = dict(**numeric,
                  names=np.array(names),
                  presets=np.array(list(presets)),
                  variant=variant,
                  N=np.int32(N),
                  L=np.int32(L))
    result["pair_same"] = pair_same   # keep as bool in memory
    return result


def report(data: dict) -> None:
    sv      = data["sv_all"]          # (n_pairs, min(N,L))
    rank99  = data["rank99"]
    rank95  = data["rank95"]
    same    = data["pair_same"]
    rms     = data["rms_total"]
    variant = str(data["variant"])

    print(f"\n{'='*60}")
    print(f"  RANK ANALYSIS — variant={variant}")
    print(f"{'='*60}")

    for label, mask in [("same-mode", same), ("cross-mode", ~same), ("all", np.ones_like(same, dtype=bool))]:
        if mask.sum() == 0:
            continue
        r99 = rank99[mask]
        r95 = rank95[mask]
        rm  = rms[mask]
        print(f"\n  [{label}]  n={mask.sum()} pairs")
        print(f"    rank@99%:  median={np.median(r99):.0f}  mean={r99.mean():.1f}"
              f"  p5={np.percentile(r99,5):.0f}  p95={np.percentile(r99,95):.0f}")
        print(f"    rank@95%:  median={np.median(r95):.0f}  mean={r95.mean():.1f}"
              f"  p5={np.percentile(r95,5):.0f}  p95={np.percentile(r95,95):.0f}")
        print(f"    RMS(D):    median={np.median(rm):.4f}  max={rm.max():.4f}")

    # Cumulative energy table: how many SVs capture X% of variance, by slice
    print(f"\n  CUMULATIVE ENERGY vs NUMBER OF COMPONENTS")
    print(f"  {'n_sv':>5}  {'same-mode ≥%':>14}  {'cross-mode ≥%':>14}")
    sv2 = sv ** 2  # (pairs, sv)
    energy_cumfrac = sv2.cumsum(axis=1) / sv2.sum(axis=1, keepdims=True)  # (pairs, sv)
    for n in [1, 2, 3, 5, 8, 13, 20]:
        if n > sv.shape[1]:
            break
        frac_same  = (energy_cumfrac[same,  n-1] if same.sum()  else np.array([])).mean() * 100
        frac_cross = (energy_cumfrac[~same, n-1] if (~same).sum() else np.array([])).mean() * 100
        print(f"  {n:>5}  {frac_same:>13.1f}%  {frac_cross:>13.1f}%")

    # Per-preset breakdown
    print(f"\n  PER-PRESET MEDIAN rank@99% (same-mode pairs only)")
    names  = data["names"]
    presets = data["presets"]
    pair_ref = data["pair_ref"]
    unique_presets = sorted(set(presets))
    for pr in unique_presets:
        mask_pr = np.array([presets[pair_ref[i]] == pr for i in range(len(pair_ref))]) & same
        if mask_pr.sum() == 0:
            continue
        print(f"    {pr:<20} n={mask_pr.sum():>4}  rank@99%: {np.median(rank99[mask_pr]):.0f}"
              f"  rank@95%: {np.median(rank95[mask_pr]):.0f}")


H5_RANK_PATH = HERE / "../../frontend/data/cae-input/h5-rank.json"


def report_h5() -> None:
    """Report from the pre-computed h5-rank.json (full 27-profile same-mode dataset)."""
    if not H5_RANK_PATH.exists():
        print(f"h5-rank.json not found at {H5_RANK_PATH}, skipping.")
        return

    with open(H5_RANK_PATH) as fh:
        h5 = json.load(fh)

    pp = h5.get("perPair", [])
    if not pp:
        print("h5-rank.json: no perPair data.")
        return

    def _preset(name: str) -> str:
        n = name.lower()
        if "wcrw" in n: return "WCRW"
        if "usfa" in n: return "USFA"
        if "canvas" in n: return "CanvasMatte"
        if "luster" in n: return "PremiumLuster"
        if "moab slick" in n: return "MOABSlickrock"
        if "moab lasal" in n and "gloss" in n: return "MOABLasalGloss"
        if "moab lasal" in n: return "MOABLasalDull"
        if "moab" in n: return "MOABother"
        if "pgpp" in n: return "PGPP"
        if "swm" in n: return "SWM"
        if "emp" in n: return "EMP"
        return name.split("_")[-1][:12]

    import collections
    by_preset: dict[str, list[int]] = collections.defaultdict(list)
    all_ranks: list[int] = []
    for row in pp:
        parts = row["pair"].split(" ↔ ")
        pr = _preset(parts[0]) if len(parts) == 2 else "unknown"
        by_preset[pr].append(row["r"])
        all_ranks.append(row["r"])

    r = np.array(all_ranks)
    print(f"\n{'='*60}")
    print(f"  H5-RANK (same-mode, full 27-profile dataset, @{h5.get('energy',0.99)*100:.0f}% energy)")
    print(f"  Source: h5-rank.json  |  n={len(r)} pairs")
    print(f"{'='*60}")
    print(f"\n  Rank distribution (all same-mode pairs):")
    print(f"    median={np.median(r):.0f}  mean={r.mean():.1f}"
          f"  p5={np.percentile(r,5):.0f}  p95={np.percentile(r,95):.0f}")
    for thr in [3, 4, 5, 6, 7, 8]:
        print(f"    rank<={thr}: {(r<=thr).mean()*100:.1f}%")

    print(f"\n  Implication: theoretical min k ≥ rank to fit one new substrate.")
    print(f"    same-mode: median rank={np.median(r):.0f} → need ≥{int(np.median(r))+1} anchors for a full fit")
    print(f"    95th pct : rank={np.percentile(r,95):.0f} → need ≥{int(np.percentile(r,95))+1} to cover 95% of pairs")

    print(f"\n  Per-preset (same-mode pairs only):")
    for pr, ranks in sorted(by_preset.items()):
        rv = np.array(ranks)
        print(f"    {pr:<20} n={len(rv):>4}  med={np.median(rv):.0f}"
              f"  p95={np.percentile(rv,95):.0f}  <=4:{(rv<=4).mean()*100:.0f}%  <=6:{(rv<=6).mean()*100:.0f}%")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Spectral residual rank analysis")
    ap.add_argument("--variant", choices=["raw", "d7"], default="d7",
                    help="Spectral variant: raw or d7 (OBA-cleaned). Default: d7")
    ap.add_argument("--force", action="store_true",
                    help="Recompute even if cache exists")
    ap.add_argument("--h5-only", action="store_true",
                    help="Only show h5-rank.json report (no SVD recomputation)")
    args = ap.parse_args()

    # Always show h5-rank first (full dataset, same-mode).
    report_h5()

    if not args.h5_only:
        # SVD on the available subset (profiles-mk.json, currently PremiumLuster subset).
        # When a full-dataset export is available, this will cover cross-mode too.
        data = run_analysis(variant=args.variant, force=args.force)
        print(f"\n  NOTE: SVD run above covers only the {len(data['names'])} profiles in profiles-mk.json.")
        print(f"  Cross-mode analysis requires a full-dataset ICM export.")
        report(data)
