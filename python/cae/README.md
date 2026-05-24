# python/cae — Conditional Autoencoder training pipeline

Trains a substrate-conditioned spectral predictor on the MK (matte-black)
subset of the P9000 dataset, then exports weights as JSON for the TS
inference module (`frontend/src/lib/predict/cae.ts`).

## Setup

```bash
cd python/cae
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Pipeline

```bash
# Prerequisite: from frontend/, run `npx tsx scripts/exportCaeData.ts`.
# This produces frontend/data/cae-input/profiles-mk.json (~5 MB, gitignored).

# 1. Deterministic train/test split (11 train, 5 test). Writes split.json.
python split.py

# 2. Train the CAE (raw spectra variant).
python train.py --variant raw

# 3. Evaluate held-out pairs. Prints + writes evaluate_raw.json.
python evaluate.py --variant raw

# 4. Export weights for TS inference.
python export_weights.py --variant raw \
  --out ../../frontend/src/data/cae_weights_raw.json
```

For the D7 (OBA-cleaned) variant repeat steps 2–4 with `--variant d7`.

## Architecture

See plan: `36 (R) + 3 (RGB) + 8 (substrate latent)` →
`Linear(47, 64) → ReLU → Linear(64, 16)` (ink latent). Decoder mirrors.

Substrate encoder receives paper spectrum (36) + one-hot substrate ID
(N_train + 1 slots, the +1 being a `__null__` sentinel used 30 % of the
time during training as ID dropout). Total ~10 k parameters.

## Loss

```
L = MSE(R_B_pred, R_B_true)
  + λ_lat * || ink_latent_A - ink_latent_B ||²     (substrate invariance)
```

`λ_lat = 0.1`, decayed to 0.01 after epoch 20.

## File index

```text
requirements.txt      torch >= 2.0, numpy
split.py              11/5 train-test split, seed 42
dataset.py            PyTorch Dataset — yields (paper_A, R_A, RGB, id_A, paper_B, R_B, id_B)
model.py              CAEHybrid PyTorch module
oba.py                Python port of frontend/src/lib/predict/obaSeparator.ts
train.py              Adam, 50 epochs, batch 256, early stop on held-out median ΔE00
evaluate.py           per-pair held-out median + P95 ΔE00 → evaluate_<variant>.json
export_weights.py     state_dict → JSON for TS forward pass
```

## Reproducibility

- RNG seed 42 (numpy + torch).
- Deterministic split via sorted profile names.
- Loss curve + held-out metrics stored alongside weights JSON.
