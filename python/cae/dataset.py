"""PyTorch Dataset that yields training pairs (ref, target) at matched RGB."""

from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Sequence

import numpy as np
import torch
from torch.utils.data import Dataset

from oba import extract_oba_emission, per_patch_factor, subtract_oba

HERE = Path(__file__).resolve().parent
DATA_FILE = HERE / "../../frontend/data/cae-input/profiles-mk.json"
SPLIT_FILE = HERE / "split.json"


def load_payload():
    with open(DATA_FILE) as fh:
        return json.load(fh)


def load_split():
    with open(SPLIT_FILE) as fh:
        return json.load(fh)


class ProfileBank:
    """Indexed view over the parsed profile data."""

    def __init__(self, profiles: Sequence[dict], variant: str = "raw") -> None:
        self.variant = variant
        filtered = [p for p in profiles if p.get("patches")]
        if not filtered:
            raise ValueError("No profiles found with spectral patches")
        self.profiles = filtered
        self.by_name = {p["full_name"]: p for p in self.profiles}

        first = self.profiles[0]
        self.L = len(first["paper_spectrum"])
        patch_maps = [self._patch_map(prof) for prof in self.profiles]
        common_keys = set(patch_maps[0])
        for patch_map in patch_maps[1:]:
            common_keys &= set(patch_map)
        if not common_keys:
            raise ValueError("No common RGB patch coordinates across selected profiles")
        sample_id_order = sorted(common_keys, key=self._rgb_sort_key)
        self.N = len(sample_id_order)

        # Pre-stack spectra as (N_profiles, N_patches, L) for fast indexing.
        # Different sources can have different chart sizes; align by rounded
        # RGB device coordinates rather than assuming row-index equivalence.
        spectra = np.zeros((len(self.profiles), self.N, self.L), dtype=np.float32)
        rgb = np.zeros((len(self.profiles), self.N, 3), dtype=np.float32)
        paper_specs = np.zeros((len(self.profiles), self.L), dtype=np.float32)
        paper_idx_per = np.zeros(len(self.profiles), dtype=np.int64)

        for pi, prof in enumerate(self.profiles):
            patch_map = patch_maps[pi]
            paper_ti = -1
            brightest_neutral = (-1.0, -1)
            for ti, key in enumerate(sample_id_order):
                pat = patch_map[key]
                spectra[pi, ti] = pat["spectrum"]
                rgb[pi, ti] = pat["rgb"]
                r, g, b = pat["rgb"]
                # Tolerance: some profiles label their paper as (254,254,254)
                # or similar; track the brightest neutral as a fallback.
                if r >= 250 and g >= 250 and b >= 250 and abs(r - g) < 5 and abs(g - b) < 5:
                    paper_ti = ti
                if abs(r - g) < 5 and abs(g - b) < 5:
                    brightness = r + g + b
                    if brightness > brightest_neutral[0]:
                        brightest_neutral = (brightness, ti)
            paper_specs[pi] = prof["paper_spectrum"]
            if paper_ti < 0 and brightest_neutral[1] >= 0:
                paper_ti = brightest_neutral[1]
            if paper_ti < 0:
                raise ValueError(f"profile {prof['full_name']} has no paper-like neutral patch in shared chart")
            paper_idx_per[pi] = paper_ti

        if variant == "d7":
            for pi in range(len(self.profiles)):
                emission = extract_oba_emission(paper_specs[pi].astype(np.float64))
                factors = per_patch_factor(spectra[pi].astype(np.float64), int(paper_idx_per[pi]))
                spectra[pi] = subtract_oba(spectra[pi].astype(np.float64), factors, emission).astype(np.float32)
                paper_specs[pi] = subtract_oba(
                    paper_specs[pi][None, :].astype(np.float64),
                    np.array([1.0]),
                    emission,
                )[0].astype(np.float32)

        self.spectra = spectra
        self.rgb = rgb
        self.paper_specs = paper_specs
        self.sample_ids = sample_id_order

    @staticmethod
    def _rgb_key(patch: dict) -> str:
        r, g, b = patch["rgb"]
        return f"{round(r)},{round(g)},{round(b)}"

    @staticmethod
    def _rgb_sort_key(key: str) -> tuple[int, int, int]:
        r, g, b = (int(v) for v in key.split(","))
        return r, g, b

    @classmethod
    def _patch_map(cls, prof: dict) -> dict[str, dict]:
        patch_map = {}
        for patch in prof["patches"]:
            if len(patch.get("spectrum", [])) == len(prof["paper_spectrum"]):
                patch_map[cls._rgb_key(patch)] = patch
        return patch_map

    def index_of(self, name: str) -> int:
        for i, p in enumerate(self.profiles):
            if p["full_name"] == name:
                return i
        raise KeyError(name)


class CrossSubstrateDataset(Dataset):
    """Yields all (profile_a, profile_b, patch_index) triplets from a profile pool."""

    def __init__(
        self,
        bank: ProfileBank,
        profile_indices: Sequence[int],
        id_table: dict[str, int],
        id_dropout: float = 0.3,
        null_id_value: int | None = None,
        rng_seed: int = 0,
    ) -> None:
        self.bank = bank
        self.profile_indices = list(profile_indices)
        self.id_table = id_table
        self.id_dropout = id_dropout
        self.null_id_value = null_id_value if null_id_value is not None else len(id_table)
        self.rng = random.Random(rng_seed)
        # Triplets: (a_idx, b_idx, patch). a != b.
        triplets = []
        for a in self.profile_indices:
            for b in self.profile_indices:
                if a == b:
                    continue
                for pi in range(self.bank.N):
                    triplets.append((a, b, pi))
        self.triplets = triplets

    def __len__(self) -> int:
        return len(self.triplets)

    def __getitem__(self, idx: int):
        a_pi, b_pi, patch = self.triplets[idx]
        a_name = self.bank.profiles[a_pi]["full_name"]
        b_name = self.bank.profiles[b_pi]["full_name"]
        id_a = self.id_table.get(a_name, self.null_id_value)
        id_b = self.id_table.get(b_name, self.null_id_value)
        # ID dropout — replace with null with probability id_dropout.
        if self.id_dropout > 0:
            if self.rng.random() < self.id_dropout:
                id_a = self.null_id_value
            if self.rng.random() < self.id_dropout:
                id_b = self.null_id_value
        return {
            "paper_a": torch.from_numpy(self.bank.paper_specs[a_pi]),
            "paper_b": torch.from_numpy(self.bank.paper_specs[b_pi]),
            "R_a": torch.from_numpy(self.bank.spectra[a_pi, patch]),
            "R_b": torch.from_numpy(self.bank.spectra[b_pi, patch]),
            "rgb": torch.from_numpy(self.bank.rgb[a_pi, patch]) / 255.0,
            "id_a": torch.tensor(id_a, dtype=torch.long),
            "id_b": torch.tensor(id_b, dtype=torch.long),
        }
