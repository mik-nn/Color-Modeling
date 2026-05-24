"""Deterministic 70/30 split of the MK profile pool.

Writes split.json with explicit train/test profile name lists so the
training and evaluation scripts both use the same partition without
re-seeding RNGs.
"""

from __future__ import annotations

import json
import os
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA_FILE = HERE / "../../frontend/data/cae-input/profiles-mk.json"
SPLIT_FILE = HERE / "split.json"
SEED = 42
TRAIN_FRAC = 11 / 16  # 11 of 16 MK profiles


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
    if len(names) < 6:
        print(f"too few profiles ({len(names)}); need ≥ 6 to split", file=sys.stderr)
        return 1

    rng = random.Random(SEED)
    shuffled = names[:]
    rng.shuffle(shuffled)
    n_train = round(TRAIN_FRAC * len(shuffled))
    train = sorted(shuffled[:n_train])
    test = sorted(shuffled[n_train:])

    out = {
        "seed": SEED,
        "train_count": len(train),
        "test_count": len(test),
        "train": train,
        "test": test,
    }
    SPLIT_FILE.write_text(json.dumps(out, indent=2))
    print(f"wrote {SPLIT_FILE}")
    print(f"  train ({len(train)}): {train}")
    print(f"  test  ({len(test)}): {test}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
