"""Evaluate trained CAE on held-out pairs, per pair median + P95 ΔE00.

Uses an inline D50/2° spectraToLab + CIEDE2000 (ported from
frontend/src/lib/colormath.ts) to stay decoupled from the colour-science
package.

Output: evaluate_<variant>.json with one entry per (ref, target) held-out
pair, plus per-substrate medians.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch

from dataset import ProfileBank, load_payload, load_split
from model import CAEHybrid

HERE = Path(__file__).resolve().parent
WEIGHTS_DIR = HERE / "weights"

# CIE 1931 2° standard observer, 380–730 nm @ 10 nm.
CMF_X = np.array([
    0.001368, 0.004243, 0.014310, 0.043510, 0.134380, 0.283900, 0.348280, 0.336200, 0.290800,
    0.195360, 0.095640, 0.032010, 0.004900, 0.009300, 0.063270, 0.165500, 0.290400, 0.433450,
    0.594500, 0.762100, 0.916300, 1.026300, 1.062200, 1.045600, 0.971600, 0.854450, 0.708600,
    0.574200, 0.415400, 0.302400, 0.218000, 0.143700, 0.095800, 0.063700, 0.041900, 0.028700,
])
CMF_Y = np.array([
    0.000039, 0.000120, 0.000396, 0.001210, 0.004000, 0.011600, 0.023000, 0.038000, 0.060000,
    0.090980, 0.139020, 0.208020, 0.323000, 0.503000, 0.710000, 0.862000, 0.954000, 0.994950,
    0.995000, 0.952000, 0.870000, 0.757000, 0.631000, 0.503000, 0.381000, 0.265000, 0.175000,
    0.107000, 0.061000, 0.032000, 0.017000, 0.008210, 0.004102, 0.002091, 0.001047, 0.000520,
])
CMF_Z = np.array([
    0.006450, 0.020050, 0.067850, 0.207400, 0.645600, 1.385600, 1.747060, 1.772110, 1.669200,
    1.287640, 0.812950, 0.465180, 0.272000, 0.158200, 0.078250, 0.042160, 0.020300, 0.008750,
    0.003900, 0.002100, 0.001650, 0.001100, 0.000800, 0.000340, 0.000190, 0.000050, 0.000020,
    0.000050, 0.000030, 0.000050, 0.000010, 0.000000, 0.000000, 0.000000, 0.000000, 0.000000,
])
D50 = np.array([
    23.942, 28.022, 31.493, 38.031, 43.207, 52.088, 64.458, 67.989, 76.221, 84.854,
    92.023, 97.420, 99.858, 100.000, 97.997, 97.478, 97.746, 97.278, 97.783, 95.756,
    97.434, 96.785, 97.010, 95.785, 95.694, 95.688, 92.949, 89.937, 88.200, 87.244,
    84.374, 82.831, 80.019, 80.460, 79.174, 79.048,
])
K_NORM = float(np.sum(D50 * CMF_Y))


def spectra_to_xyz(R):
    s = 100.0 / K_NORM
    return s * np.array([np.sum(R * D50 * CMF_X), np.sum(R * D50 * CMF_Y), np.sum(R * D50 * CMF_Z)])


def lab_f(t):
    delta = 6 / 29
    return np.where(t > delta ** 3, np.cbrt(t), t / (3 * delta * delta) + 4 / 29)


def xyz_to_lab(X, Y, Z, wp):
    fx = lab_f(X / wp[0])
    fy = lab_f(Y / wp[1])
    fz = lab_f(Z / wp[2])
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def spectra_to_lab(R, wp):
    X, Y, Z = spectra_to_xyz(R)
    return xyz_to_lab(X, Y, Z, wp)


def delta_e_00(L1, a1, b1, L2, a2, b2):
    # Port of frontend/src/lib/colormath.ts deltaE00 — vectorised.
    C1ab = np.sqrt(a1 * a1 + b1 * b1)
    C2ab = np.sqrt(a2 * a2 + b2 * b2)
    avgCab = (C1ab + C2ab) / 2
    avgCab7 = avgCab ** 7
    G = 0.5 * (1 - np.sqrt(avgCab7 / (avgCab7 + 25 ** 7)))
    a1p = (1 + G) * a1
    a2p = (1 + G) * a2
    C1p = np.sqrt(a1p * a1p + b1 * b1)
    C2p = np.sqrt(a2p * a2p + b2 * b2)
    h1p = np.degrees(np.arctan2(b1, a1p)) % 360
    h2p = np.degrees(np.arctan2(b2, a2p)) % 360
    dLp = L2 - L1
    dCp = C2p - C1p
    dhp = np.where(C1p * C2p == 0, 0, h2p - h1p)
    dhp = np.where(dhp > 180, dhp - 360, dhp)
    dhp = np.where(dhp < -180, dhp + 360, dhp)
    dHp = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dhp) / 2)
    avgLp = (L1 + L2) / 2
    avgCp = (C1p + C2p) / 2
    avgHp = np.where(C1p * C2p == 0, h1p + h2p,
                     np.where(np.abs(h1p - h2p) > 180,
                              ((h1p + h2p + 360) / 2),
                              ((h1p + h2p) / 2)))
    T = (1 - 0.17 * np.cos(np.radians(avgHp - 30))
         + 0.24 * np.cos(np.radians(2 * avgHp))
         + 0.32 * np.cos(np.radians(3 * avgHp + 6))
         - 0.20 * np.cos(np.radians(4 * avgHp - 63)))
    SL = 1 + (0.015 * (avgLp - 50) ** 2) / np.sqrt(20 + (avgLp - 50) ** 2)
    SC = 1 + 0.045 * avgCp
    SH = 1 + 0.015 * avgCp * T
    avgCp7 = avgCp ** 7
    RC = 2 * np.sqrt(avgCp7 / (avgCp7 + 25 ** 7))
    dTheta = 30 * np.exp(-(((avgHp - 275) / 25) ** 2))
    RT = -np.sin(np.radians(2 * dTheta)) * RC
    kL = kC = kH = 1.0
    return np.sqrt((dLp / (kL * SL)) ** 2 + (dCp / (kC * SC)) ** 2
                   + (dHp / (kH * SH)) ** 2 + RT * (dCp / (kC * SC)) * (dHp / (kH * SH)))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", choices=["raw", "d7"], required=True)
    ap.add_argument(
        "--set",
        choices=["test", "validation"],
        default="validation",
        help="Which held-out split to score the targets on. 'test' = the CV inner held-out; "
             "'validation' = the outer held-out (never seen during training/CV). Default: validation.",
    )
    args = ap.parse_args()

    pt = WEIGHTS_DIR / f"cae_{args.variant}.pt"
    if not pt.exists():
        print(f"missing {pt} — run `python train.py --variant {args.variant}` first", file=sys.stderr)
        return 1
    bundle = torch.load(pt, map_location="cpu", weights_only=False)

    payload = load_payload()
    split = load_split()
    bank = ProfileBank(payload["profiles"], variant=args.variant)

    model = CAEHybrid(n_substrate_ids=bundle["n_substrate_ids"])
    model.load_state_dict(bundle["state_dict"])
    model.train(False)

    null_id = bundle["null_id"]

    train_idx = [bank.index_of(n) for n in split["train"]]
    test_idx = [bank.index_of(n) for n in split["test"]]
    # 'set' chooses which held-out group acts as the target pool to score against.
    # Cross-substrate `ref` profiles always include train + test (whatever the model saw).
    eval_set_names = split.get(args.set, [])
    if not eval_set_names:
        print(
            f"split.json has no '{args.set}' key — falling back to legacy 'test' targets",
            file=sys.stderr,
        )
        eval_set_names = split.get("test", [])
    eval_target_idx = [bank.index_of(n) for n in eval_set_names if n in {p["full_name"] for p in bank.profiles}]

    rows = []
    with torch.no_grad():
        for b in eval_target_idx:
            paper_b = torch.from_numpy(bank.paper_specs[b]).unsqueeze(0)
            id_b = torch.tensor([null_id], dtype=torch.long)
            paper_wp_b = spectra_to_xyz(bank.paper_specs[b].astype(np.float64))
            for a in train_idx + test_idx:
                if a == b:
                    continue
                a_name = bank.profiles[a]["full_name"]
                b_name = bank.profiles[b]["full_name"]
                a_in_train = a in train_idx
                paper_a = torch.from_numpy(bank.paper_specs[a]).unsqueeze(0).expand(bank.N, -1)
                paper_b_e = paper_b.expand(bank.N, -1)
                r_a = torch.from_numpy(bank.spectra[a])
                rgb = torch.from_numpy(bank.rgb[a]) / 255.0
                id_a_v = bundle["id_table"].get(a_name, null_id)
                id_a_t = torch.full((bank.N,), id_a_v, dtype=torch.long)
                id_b_t = id_b.expand(bank.N)
                r_b_pred, *_ = model(paper_a, paper_b_e, r_a, rgb, id_a_t, id_b_t)
                r_b_pred_np = np.clip(r_b_pred.numpy(), 0, 1).astype(np.float64)
                r_b_true_np = bank.spectra[b].astype(np.float64)

                # ΔE00 per patch using target's paper WP.
                de = []
                for i in range(bank.N):
                    Lp, ap_, bp = spectra_to_lab(r_b_pred_np[i], paper_wp_b)
                    Lt, at_, bt = spectra_to_lab(r_b_true_np[i], paper_wp_b)
                    de.append(float(delta_e_00(Lp, ap_, bp, Lt, at_, bt)))
                de_arr = np.array(de)
                rows.append({
                    "ref": a_name,
                    "ref_in_train": a_in_train,
                    "target": b_name,
                    "median_de00": float(np.median(de_arr)),
                    "p95_de00": float(np.percentile(de_arr, 95)),
                    "mean_de00": float(np.mean(de_arr)),
                })
                print(
                    f"  ref={a_name[:35]:35} → tgt={b_name[:30]:30}  "
                    f"med={rows[-1]['median_de00']:.2f}  p95={rows[-1]['p95_de00']:.2f}"
                    f"  {'(train ref)' if a_in_train else '(held-out ref)'}"
                )

    out = WEIGHTS_DIR / f"evaluate_{args.variant}.json"
    out.write_text(json.dumps({
        "variant": args.variant,
        "rows": rows,
        "summary": {
            "median_of_medians": float(np.median([r["median_de00"] for r in rows])),
            "median_of_p95s": float(np.median([r["p95_de00"] for r in rows])),
            "fraction_under_1.5_de00": float(np.mean([r["median_de00"] <= 1.5 for r in rows])),
        },
    }, indent=2))
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
