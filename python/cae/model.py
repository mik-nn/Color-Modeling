"""CAE-Hybrid: substrate encoder + spectrum encoder + decoder.

All shapes match the plan: paper spectrum is 36 bands, RGB is 3, substrate
latent is 8, ink latent is 16.
"""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F


class CAEHybrid(nn.Module):
    def __init__(
        self,
        spectral_dim: int = 36,
        rgb_dim: int = 3,
        substrate_latent_dim: int = 8,
        ink_latent_dim: int = 16,
        hidden_dim: int = 64,
        n_substrate_ids: int = 12,  # 11 training profiles + 1 null slot
    ) -> None:
        super().__init__()
        self.spectral_dim = spectral_dim
        self.n_substrate_ids = n_substrate_ids

        sub_in = spectral_dim + n_substrate_ids
        self.substrate_fc1 = nn.Linear(sub_in, 32)
        self.substrate_fc2 = nn.Linear(32, substrate_latent_dim)

        enc_in = spectral_dim + rgb_dim + substrate_latent_dim
        self.encoder_fc1 = nn.Linear(enc_in, hidden_dim)
        self.encoder_fc2 = nn.Linear(hidden_dim, ink_latent_dim)

        dec_in = ink_latent_dim + rgb_dim + substrate_latent_dim
        self.decoder_fc1 = nn.Linear(dec_in, hidden_dim)
        self.decoder_fc2 = nn.Linear(hidden_dim, spectral_dim)

    def encode_substrate(self, paper: torch.Tensor, sub_id: torch.Tensor) -> torch.Tensor:
        # paper: (B, 36); sub_id: (B,) long.
        onehot = F.one_hot(sub_id, num_classes=self.n_substrate_ids).float()
        x = torch.cat([paper, onehot], dim=-1)
        x = F.relu(self.substrate_fc1(x))
        return self.substrate_fc2(x)

    def encode_spectrum(self, r: torch.Tensor, rgb: torch.Tensor, sub_lat: torch.Tensor) -> torch.Tensor:
        x = torch.cat([r, rgb, sub_lat], dim=-1)
        x = F.relu(self.encoder_fc1(x))
        return self.encoder_fc2(x)

    def decode(self, ink_lat: torch.Tensor, rgb: torch.Tensor, sub_lat: torch.Tensor) -> torch.Tensor:
        x = torch.cat([ink_lat, rgb, sub_lat], dim=-1)
        x = F.relu(self.decoder_fc1(x))
        return self.decoder_fc2(x)

    def forward(self, paper_a, paper_b, r_a, rgb, id_a, id_b):
        """Forward: predict B from A's spectrum + RGB + both substrate identities."""
        sub_a = self.encode_substrate(paper_a, id_a)
        sub_b = self.encode_substrate(paper_b, id_b)
        ink = self.encode_spectrum(r_a, rgb, sub_a)
        r_b = self.decode(ink, rgb, sub_b)
        return r_b, ink, sub_a, sub_b

    def loss(
        self,
        batch,
        lambda_lat: float = 0.1,
    ) -> tuple[torch.Tensor, dict]:
        paper_a = batch["paper_a"]
        paper_b = batch["paper_b"]
        r_a = batch["R_a"]
        r_b_true = batch["R_b"]
        rgb = batch["rgb"]
        id_a = batch["id_a"]
        id_b = batch["id_b"]

        r_b_pred, ink_a, _, sub_b = self.forward(paper_a, paper_b, r_a, rgb, id_a, id_b)
        # Substrate-invariance: encode same R_b with target's substrate latent
        # → should yield same ink latent as ink_a.
        ink_b = self.encode_spectrum(r_b_true, rgb, sub_b)

        mse = F.mse_loss(r_b_pred, r_b_true)
        inv = F.mse_loss(ink_a, ink_b)
        total = mse + lambda_lat * inv
        return total, {"mse": mse.item(), "inv": inv.item(), "total": total.item()}
