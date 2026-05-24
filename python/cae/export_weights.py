"""Export trained CAE weights to a JSON file consumable by TS forward pass.

Usage:
  python export_weights.py --variant raw --out ../../frontend/src/data/cae_weights_raw.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import torch

HERE = Path(__file__).resolve().parent
WEIGHTS_DIR = HERE / "weights"


def tensor_to_list(t):
    if t.ndim == 0:
        return float(t.item())
    return t.detach().cpu().numpy().astype(float).tolist()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", choices=["raw", "d7"], required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    pt = WEIGHTS_DIR / f"cae_{args.variant}.pt"
    if not pt.exists():
        print(f"missing {pt} — run `python train.py --variant {args.variant}` first", file=sys.stderr)
        return 1
    bundle = torch.load(pt, map_location="cpu", weights_only=False)
    state = bundle["state_dict"]

    layers = {}
    for key, tensor in state.items():
        layers[key] = tensor_to_list(tensor)

    payload = {
        "schema_version": 1,
        "variant": bundle["variant"],
        "arch": {
            "spectral_dim": 36,
            "rgb_dim": 3,
            "substrate_latent_dim": 8,
            "ink_latent_dim": 16,
            "hidden_dim": 64,
            "n_substrate_ids": bundle["n_substrate_ids"],
        },
        "id_table": bundle["id_table"],
        "null_id": bundle["null_id"],
        "split": bundle["split"],
        "best_test_mse": bundle["best_test_mse"],
        "loss_curve_summary": {
            "first_epoch": bundle["loss_curve"][0],
            "last_epoch": bundle["loss_curve"][-1],
            "epochs": len(bundle["loss_curve"]),
        },
        "test_curve_summary": {
            "first_epoch": bundle["test_curve"][0],
            "last_epoch": bundle["test_curve"][-1],
        },
        "layers": layers,
    }

    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload))
    print(f"wrote {out} ({out.stat().st_size / 1024:.1f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
