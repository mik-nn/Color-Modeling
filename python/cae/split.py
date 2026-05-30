"""Deterministic 3-way split of the MK profile pool: train / test / validation.

  - **train** is the inner fitting set.
  - **test** is the inner held-out set used for early stopping, hyperparameter
    tuning, and per-epoch monitoring.
  - **validation** is the *outer* held-out set — never seen during training or
    tuning. Used once at the very end to report the final generalisation number.

K-fold cross-validation rotates folds over `train ∪ test`; `validation` is kept
out of the CV pool entirely (see `cv_train.py`).

Writes `split.json` with the three name lists so train/evaluate scripts pin the
same partition without re-seeding RNGs.
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA_FILE = HERE / "../../frontend/data/cae-input/profiles-mk.json"
SPLIT_FILE = HERE / "split.json"
SEED = 42
TRAIN_FRAC = 0.60   # of the full pool
TEST_FRAC = 0.20    # of the full pool (rest goes to validation)


def main() -> int:
    if not DATA_FILE.exists():
        print(
            f"missing data file: {DATA_FILE}\n"
            f"run `cd frontend && npx tsx scripts/exportCaeData.ts` first",
            file=sys.stderr,
        )
        return 1

    with open(DATA_FILE) as fh:
        payload = json.load(fh)
    names = sorted(p["full_name"] for p in payload["profiles"])
    if len(names) < 9:
        print(f"too few profiles ({len(names)}); need ≥ 9 for a 3-way split", file=sys.stderr)
        return 1

    rng = random.Random(SEED)
    shuffled = names[:]
    rng.shuffle(shuffled)
    n_total = len(shuffled)
    n_train = round(TRAIN_FRAC * n_total)
    n_test = round(TEST_FRAC * n_total)
    # Validation gets whatever is left so the counts sum to n_total exactly.
    n_val = n_total - n_train - n_test
    if n_val < 1:
        # Edge case for very small pools: borrow one from test.
        n_test = max(1, n_test - 1)
        n_val = n_total - n_train - n_test

    train = sorted(shuffled[:n_train])
    test = sorted(shuffled[n_train:n_train + n_test])
    val = sorted(shuffled[n_train + n_test:])

    out = {
        "seed": SEED,
        "train_count": len(train),
        "test_count": len(test),
        "validation_count": len(val),
        "train": train,
        "test": test,
        "validation": val,
    }
    SPLIT_FILE.write_text(json.dumps(out, indent=2))
    print(f"wrote {SPLIT_FILE}")
    print(f"  train      ({len(train)}): {train}")
    print(f"  test       ({len(test)}): {test}")
    print(f"  validation ({len(val)}): {val}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
