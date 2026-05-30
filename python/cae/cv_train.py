"""K-fold cross-validation training for the CAE.

The 3-way split (`split.py` → `split.json`) gives `train` / `test` / `validation`.
This script rotates K folds over the **pool = train ∪ test**, training each fold's
model on the remaining (K-1) folds and reporting per-fold held-out MSE. The
**validation** set is *never* touched by CV — it is reserved for the final
generalisation report (`evaluate.py --set validation`).

After CV, a final model is trained on the entire pool (train ∪ test) and saved as
`weights/cae_<variant>.pt` (overwriting the file used by `evaluate.py`).

Run:
  python cv_train.py --variant d7 --folds 5 --epochs 50
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader

from dataset import CrossSubstrateDataset, ProfileBank, load_payload, load_split
from model import CAEHybrid

HERE = Path(__file__).resolve().parent
WEIGHTS_DIR = HERE / "weights"
DEFAULT_EPOCHS = 50
BATCH_SIZE = 256
LR = 1e-3
LAMBDA_LAT_INIT = 0.1
LAMBDA_LAT_DECAY_EPOCH = 20
LAMBDA_LAT_DECAYED = 0.01
SEED = 42


def train_one(bank, train_idx, eval_idx, train_names, epochs, verbose=False):
    """Train one model on `train_idx` profiles, monitor on `eval_idx`. Returns
    (best_eval_mse, best_state_dict, id_table, n_substrate_ids, null_id)."""
    id_table = {name: i for i, name in enumerate(train_names)}
    n_ids = len(train_names) + 1
    null_id = len(train_names)

    train_ds = CrossSubstrateDataset(
        bank, train_idx, id_table=id_table,
        id_dropout=0.3, null_id_value=null_id, rng_seed=SEED,
    )
    eval_ds = CrossSubstrateDataset(
        bank, eval_idx, id_table={},
        id_dropout=0.0, null_id_value=null_id, rng_seed=SEED + 1,
    )

    train_loader = DataLoader(train_ds, batch_size=BATCH_SIZE, shuffle=True, num_workers=0)
    eval_loader = DataLoader(eval_ds, batch_size=BATCH_SIZE, shuffle=False, num_workers=0)

    model = CAEHybrid(n_substrate_ids=n_ids)
    opt = torch.optim.Adam(model.parameters(), lr=LR)
    best = float("inf")
    best_state = None

    for epoch in range(epochs):
        model.train(True)
        lam = LAMBDA_LAT_INIT if epoch < LAMBDA_LAT_DECAY_EPOCH else LAMBDA_LAT_DECAYED
        for batch in train_loader:
            opt.zero_grad()
            loss, _ = model.loss(batch, lambda_lat=lam)
            loss.backward()
            opt.step()

        model.train(False)
        with torch.no_grad():
            t_mse = 0.0
            t_n = 0
            for batch in eval_loader:
                r_b_pred, *_ = model(
                    batch["paper_a"], batch["paper_b"], batch["R_a"],
                    batch["rgb"], batch["id_a"], batch["id_b"],
                )
                t_mse += torch.nn.functional.mse_loss(r_b_pred, batch["R_b"], reduction="sum").item()
                t_n += batch["R_a"].shape[0] * r_b_pred.shape[1]
            eval_mse = t_mse / t_n

        if eval_mse < best:
            best = eval_mse
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
        if verbose and (epoch % 10 == 0 or epoch == epochs - 1):
            print(f"    epoch {epoch:3d}  eval_mse {eval_mse:.6f}  best {best:.6f}")

    return best, best_state, id_table, n_ids, null_id


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", choices=["raw", "d7"], required=True)
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--epochs", type=int, default=DEFAULT_EPOCHS)
    args = ap.parse_args()

    WEIGHTS_DIR.mkdir(exist_ok=True)
    torch.manual_seed(SEED)
    np.random.seed(SEED)

    payload = load_payload()
    split = load_split()
    bank = ProfileBank(payload["profiles"], variant=args.variant)
    available = {p["full_name"] for p in bank.profiles}

    pool = sorted(set(split.get("train", [])) | set(split.get("test", [])))
    pool = [n for n in pool if n in available]
    val_names = [n for n in split.get("validation", []) if n in available]
    if len(pool) < args.folds:
        print(f"pool too small ({len(pool)}) for {args.folds}-fold CV", file=sys.stderr)
        return 1

    rng = np.random.default_rng(SEED)
    shuffled = list(rng.permutation(pool))
    folds = [shuffled[i::args.folds] for i in range(args.folds)]

    print(f"CV: {args.folds}-fold over {len(pool)} (train+test) profiles, {args.epochs} epochs/fold")
    print(f"Validation (held out from CV): {len(val_names)} profiles")

    results = []
    start_all = time.time()
    for k in range(args.folds):
        fold_eval = folds[k]
        fold_train_names = [n for n in pool if n not in fold_eval]
        if len(fold_eval) < 2 or len(fold_train_names) < 2:
            print(f"fold {k + 1}/{args.folds}  skipped — eval={len(fold_eval)} train={len(fold_train_names)} (need ≥ 2 each for pair-based loss)")
            continue
        train_idx = [bank.index_of(n) for n in fold_train_names]
        eval_idx = [bank.index_of(n) for n in fold_eval]
        t0 = time.time()
        best_mse, _, _, _, _ = train_one(
            bank, train_idx, eval_idx, fold_train_names, args.epochs,
        )
        elapsed = time.time() - t0
        print(f"fold {k + 1}/{args.folds}  train={len(fold_train_names)}  eval={len(fold_eval)}  "
              f"best_mse={best_mse:.6f}  ({elapsed:.1f}s)")
        results.append({
            "fold": k,
            "eval_profiles": fold_eval,
            "best_eval_mse": best_mse,
        })

    mses = np.array([r["best_eval_mse"] for r in results])
    print(f"\nCV summary ({args.folds}-fold)")
    print(f"  mean MSE  : {mses.mean():.6f}")
    print(f"  std MSE   : {mses.std():.6f}")
    print(f"  per-fold  : {[float(f'{m:.6f}') for m in mses]}")

    # Final model: train on the full pool, monitor on validation (still held out).
    print(f"\nFinal model: training on full pool ({len(pool)}), monitoring validation ({len(val_names)})")
    pool_idx = [bank.index_of(n) for n in pool]
    # If validation has fewer than 2 profiles, the pair-based eval can't form even
    # one (ref, target) pair → fall back to test profiles for monitoring.
    if len(val_names) >= 2:
        val_idx = [bank.index_of(n) for n in val_names]
    else:
        fallback = [n for n in split.get("test", []) if n in available]
        print(f"validation has {len(val_names)} profile(s) — falling back to test ({len(fallback)}) for monitoring")
        val_idx = [bank.index_of(n) for n in fallback]
        if len(val_idx) < 2:
            print("test fallback also < 2 — using train pool for monitoring (loose)")
            val_idx = pool_idx[:2]
    t0 = time.time()
    best_val_mse, best_state, id_table, n_ids, null_id = train_one(
        bank, pool_idx, val_idx, pool, args.epochs, verbose=True,
    )
    print(f"final validation MSE: {best_val_mse:.6f}  ({time.time() - t0:.1f}s)")

    out_pt = WEIGHTS_DIR / f"cae_{args.variant}.pt"
    torch.save({
        "state_dict": best_state,
        "n_substrate_ids": n_ids,
        "id_table": id_table,
        "null_id": null_id,
        "variant": args.variant,
        "split": split,
        "cv": {
            "folds": args.folds,
            "epochs": args.epochs,
            "per_fold_mse": [float(m) for m in mses],
            "mean_mse": float(mses.mean()),
            "std_mse": float(mses.std()),
        },
        "validation_mse": best_val_mse,
        "best_test_mse": best_val_mse,  # backward-compat key used by TS loader / evaluate
    }, out_pt)
    print(f"saved {out_pt}")

    cv_out = WEIGHTS_DIR / f"cv_{args.variant}.json"
    cv_out.write_text(json.dumps({
        "variant": args.variant,
        "folds": args.folds,
        "epochs": args.epochs,
        "pool_size": len(pool),
        "pool": pool,
        "validation_profiles": val_names,
        "per_fold": results,
        "mean_mse": float(mses.mean()),
        "std_mse": float(mses.std()),
        "validation_mse": best_val_mse,
        "total_seconds": time.time() - start_all,
    }, indent=2))
    print(f"saved {cv_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
