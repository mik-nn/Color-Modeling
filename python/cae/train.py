"""Train the CAE on the training split.

Usage:
  python train.py --variant raw       # train on raw spectra
  python train.py --variant d7        # train on OBA-cleaned spectra
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
EPOCHS = 50
BATCH_SIZE = 256
LR = 1e-3
LAMBDA_LAT_INIT = 0.1
LAMBDA_LAT_DECAY_EPOCH = 20
LAMBDA_LAT_DECAYED = 0.01
SEED = 42


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", choices=["raw", "d7"], required=True)
    ap.add_argument("--epochs", type=int, default=EPOCHS)
    ap.add_argument("--batch", type=int, default=BATCH_SIZE)
    ap.add_argument("--lr", type=float, default=LR)
    args = ap.parse_args()

    WEIGHTS_DIR.mkdir(exist_ok=True)
    torch.manual_seed(SEED)
    np.random.seed(SEED)

    payload = load_payload()
    split = load_split()
    bank = ProfileBank(payload["profiles"], variant=args.variant)

    train_names = split["train"]
    test_names = split["test"]
    train_idx = [bank.index_of(n) for n in train_names]
    test_idx = [bank.index_of(n) for n in test_names]

    # ID table: training profiles get ids 0..N-1, null slot is N.
    id_table = {name: i for i, name in enumerate(train_names)}
    n_substrate_ids = len(train_names) + 1
    null_id = len(train_names)

    train_ds = CrossSubstrateDataset(
        bank, train_idx, id_table=id_table,
        id_dropout=0.3, null_id_value=null_id, rng_seed=SEED,
    )
    test_ds = CrossSubstrateDataset(
        bank, test_idx, id_table={},
        id_dropout=0.0, null_id_value=null_id, rng_seed=SEED + 1,
    )

    print(f"train pairs: {len(train_ds)} ({len(train_idx)} profiles)")
    print(f"test  pairs: {len(test_ds)} ({len(test_idx)} profiles, all ids = null)")

    train_loader = DataLoader(train_ds, batch_size=args.batch, shuffle=True, num_workers=0)
    test_loader = DataLoader(test_ds, batch_size=args.batch, shuffle=False, num_workers=0)

    model = CAEHybrid(n_substrate_ids=n_substrate_ids)
    optimiser = torch.optim.Adam(model.parameters(), lr=args.lr)

    loss_curve = []
    test_curve = []
    best_test = float("inf")
    best_state = None
    start = time.time()

    for epoch in range(args.epochs):
        model.train(True)
        lam = LAMBDA_LAT_INIT if epoch < LAMBDA_LAT_DECAY_EPOCH else LAMBDA_LAT_DECAYED
        total_loss = 0.0
        total_mse = 0.0
        n = 0
        for batch in train_loader:
            optimiser.zero_grad()
            loss, parts = model.loss(batch, lambda_lat=lam)
            loss.backward()
            optimiser.step()
            bs = batch["R_a"].shape[0]
            total_loss += parts["total"] * bs
            total_mse += parts["mse"] * bs
            n += bs
        train_loss = total_loss / n
        train_mse = total_mse / n
        loss_curve.append({"epoch": epoch, "train_loss": train_loss, "train_mse": train_mse})

        # Held-out evaluation — set eval mode then disable grad.
        model.train(False)
        with torch.no_grad():
            t_mse = 0.0
            t_n = 0
            for batch in test_loader:
                r_b_pred, *_ = model(batch["paper_a"], batch["paper_b"], batch["R_a"],
                                     batch["rgb"], batch["id_a"], batch["id_b"])
                m = torch.nn.functional.mse_loss(r_b_pred, batch["R_b"], reduction="sum").item()
                bs = batch["R_a"].shape[0]
                t_mse += m
                t_n += bs * r_b_pred.shape[1]
            test_mse = t_mse / t_n
        test_curve.append({"epoch": epoch, "test_mse": test_mse})

        if test_mse < best_test:
            best_test = test_mse
            best_state = {k: v.clone() for k, v in model.state_dict().items()}

        if epoch % 5 == 0 or epoch == args.epochs - 1:
            elapsed = time.time() - start
            print(
                f"epoch {epoch:3d}  train_loss {train_loss:.5f}  train_mse {train_mse:.5f}  "
                f"test_mse {test_mse:.5f}  best {best_test:.5f}  ({elapsed:.1f}s)"
            )

    # Save best.
    out = WEIGHTS_DIR / f"cae_{args.variant}.pt"
    meta = WEIGHTS_DIR / f"cae_{args.variant}_meta.json"
    torch.save({
        "state_dict": best_state or model.state_dict(),
        "n_substrate_ids": n_substrate_ids,
        "id_table": id_table,
        "null_id": null_id,
        "variant": args.variant,
        "split": split,
        "loss_curve": loss_curve,
        "test_curve": test_curve,
        "best_test_mse": best_test,
    }, out)
    meta.write_text(json.dumps({
        "variant": args.variant,
        "split": split,
        "epochs": args.epochs,
        "best_test_mse": best_test,
        "id_table": id_table,
        "null_id": null_id,
    }, indent=2))
    print(f"\nsaved {out}")
    print(f"saved {meta}")
    print(f"best held-out MSE: {best_test:.6f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
