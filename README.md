# Color Modeling

**Document-Driven Development** — research repo for cross-substrate ICC profile linearity.

We test whether **device behaviour** (ink mixing, dot gain, Yule-Nielsen optics) can be
separated from the **substrate effect** via a low-parameter affine transform in spectral or
model-parameter space. If true, an existing ICC profile can be adapted to a new substrate
from a handful of measured patches (white point + solids + a few ramps) rather than a full
multi-thousand-patch print run.

Start here: **[CLAUDE.md](CLAUDE.md)** — operating manual, DDD loop, and hard rules.

## Status (May 2026)

- ✅ ICC `.icm` parser with embedded CxF3 / ZXML extraction (`iccTagScanner`, `parsers/icmParser`).
- ✅ CxF3 (`cc:CxF` namespace) XML parser → `Measurement[]` with 36-band spectra.
- ✅ Spectral → XYZ (D50 / 2°) → Lab pipeline, CIEDE2000 ΔE00 (`lib/colormath.ts`).
- ✅ Cross-substrate patch matching by `Row:Col:Page` key.
- ✅ Ink-limit detection per channel (C / M / Y) and 2-ink combos (CY / MY / CM) using
  Yule-Nielsen interpolation (n = 2), ΔE76 threshold.
- ✅ Group breakdown table, ink-ratio T(λ) analyser, per-wavelength polynomial / YN /
  XYZ-affine spectral predictor.
- ✅ 3D CYNSN (Cellular Yule-Nielsen Spectral Neugebauer) ported to TypeScript:
  Nelder-Mead training, 8-primary KNN extraction, 27-node measured grid for CYNSN-2.
- 🟡 DeviceSpace abstraction — legacy CMYK fields coexist with RGB fields; refactor in
  progress.
- 🟡 CYNSN-2 grid/spreading optimisation mismatch — documented in
  [`docs/cynsn-pipeline.md`](docs/cynsn-pipeline.md).
- ⏳ Substrate transfer model (Phase 3) — not started.

## Dataset

27 Epson P9000 RGB ICM profiles (each with embedded CxF3 spectral data) + 1 standalone CxF
reference. Stored outside the repo at `/mnt/e/PET/LinkedInPosts/surecolor-p9000/`. All
profiles are **RGB** — the CMY model uses `c = (255 - R)/255` and assumes K = 0.

## Architecture (frontend-only, no backend yet)

- React 18 + TypeScript (strict) + Vite 8
- TailwindCSS + D3 v7 + Zustand
- Vitest for unit tests, GitHub Actions (Node 20) for CI

```text
frontend/src/
├── App.tsx, store/useProfileStore.ts
├── lib/
│   ├── colormath.ts            spectra → XYZ → Lab, CIEDE2000
│   ├── iccTagScanner.ts        ZXML tag locator + pako inflate
│   ├── parsers/{cxfParser,icmParser}.ts
│   ├── analyzers/{limitsAnalyzer,cynsn,spreading,optimizer,…}.ts
│   └── cgatsExport.ts
└── components/                  ComparisonView is the UI hub
```

## Quick start

```bash
cd frontend
npm install      # also installs the git pre-commit hook
npm run dev      # runs `vitest run` first via `predev`, then `vite`
npm test         # vitest one-shot
npm run build    # production build
```

**Node ≥ 18 required** (Node 12 cannot run vitest / vite due to optional chaining in deps).
Use `nvm use 20` if your local Node is older.

## Documentation map

| File | What it is |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Operating manual for any AI/contributor. Read first. |
| [AGENTS.md](AGENTS.md) | Repo guidelines for AI coding agents. |
| [docs/ONTOLOGY.md](docs/ONTOLOGY.md) | Domain model + mermaid diagram. |
| [docs/DATA_DICTIONARY.md](docs/DATA_DICTIONARY.md) | TypeScript type reference. |
| [docs/RESEARCH_HYPOTHESIS.md](docs/RESEARCH_HYPOTHESIS.md) | Falsifiable hypothesis + metrics. |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phased plan, current state. |
| [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) | What each module does. |
| [docs/Tech.md](docs/Tech.md) | Stack, versions, build/test commands. |
| [docs/EXPERIMENTS.md](docs/EXPERIMENTS.md) | Append-only experiment log. |
| [docs/knowledge-base.md](docs/knowledge-base.md) | OBA physics, per-ink absorption, predictor / anchor-strategy strengths and weaknesses. |
| [docs/progress-log.md](docs/progress-log.md) | Per-session changelog. |
| [docs/cynsn-pipeline.md](docs/cynsn-pipeline.md) | CYNSN flow + known bugs. |
| [docs/AGENTS.md](docs/AGENTS.md) | Claude Code subagents + skills map. |
| [docs/workflow.md](docs/workflow.md) | The DDD loop, expanded. |
| [docs/SKILLS.md](docs/SKILLS.md) | Domain expertise reference. |
| [docs/PROMPTS.md](docs/PROMPTS.md) | LLM prompt templates used by the team. |
| [docs/structure.md](docs/structure.md) | Current tree snapshot. |
| [TODO.md](TODO.md) | Open work. |

## Repository

<https://github.com/mik-nn/Color-Modeling.git>

## License

MIT
