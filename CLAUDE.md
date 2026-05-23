# CLAUDE.md — Project Operating Manual

> **You are working on a Document-Driven Development (DDD) research project.**
> Every non-trivial change must be reflected in documentation **before or together with** the code, never after the fact.
>
> If you cannot honor the rules in this file, stop and ask the user.

---

## 0. One-paragraph project description

A web-based tool for analysing cross-substrate color profile linearity. Loads ICC `.icm` profiles
(which embed CxF3 spectral data in a private ZXML tag), extracts per-patch device values and
36-band reflectance spectra (380–730 nm, 10 nm step), and runs comparative analysis between two
substrates printed on the same device. Goal: validate that the **device behavior** (ink mixing,
dot gain, Yule-Nielsen optics) can be **separated** from the **substrate effect** via an affine
or low-parameter transform in spectral / model-parameter space, enabling few-patch substrate
adaptation of existing profiles.

**Current dataset:** 27 Epson P9000 RGB profiles + 1 CxF reference. All profiles are RGB
(K = 0 in the CMY model). The codebase must remain device-space agnostic so future CMYK datasets
can be processed without a rewrite. See `docs/ONTOLOGY.md` for the data model and
`docs/RESEARCH_HYPOTHESIS.md` for the formal hypothesis.

---

## 1. The DDD Loop — non-negotiable

```
Idea
  └─► docs/RESEARCH_HYPOTHESIS.md  (formulate / refine hypothesis)
  └─► docs/specs/<feature>.md      (contract: inputs / outputs / metric)  [optional for small fixes]
        └─► CODE + TESTS           (implement; tests first for new analyzers)
              └─► run experiment   (in dev UI or via test fixture)
                    └─► docs/EXPERIMENTS.md   (append-only row: date | what | profiles | metric | conclusion | next)
                          └─► docs/progress-log.md   (one-paragraph entry per commit/session)
                                └─► docs/ROADMAP.md  (check off / re-plan)
                                      └─► git commit (Conventional Commits)
```

**Enforcement:** `.githooks/pre-commit` blocks `feat:` and `fix:` commits whose diff touches
`frontend/src/lib/` or `frontend/src/components/` *without* a matching change in
`docs/progress-log.md`. To install: `npm install` in `frontend/` (auto-runs setup), or
`./scripts/install-hooks.sh` manually.

**Bypass** with `--no-verify` only when the change is truly trivial (typo, comment, dead-code
removal) — and then *still* add a one-liner to `progress-log.md` in the next commit.

---

## 2. Where things live

| Concern | File |
|---|---|
| Project rules (this file) | `CLAUDE.md` |
| Repo guidelines for any AI/contributor | `AGENTS.md` |
| Conceptual model + entity diagram | `docs/ONTOLOGY.md` |
| Data schema (Measurement, ProfileData, …) | `docs/DATA_DICTIONARY.md` |
| Hypothesis + falsification criteria | `docs/RESEARCH_HYPOTHESIS.md` |
| Phase plan, milestones | `docs/ROADMAP.md` |
| Implementation map (what file does what) | `docs/IMPLEMENTATION.md` |
| Stack, versions, build commands | `docs/Tech.md` |
| Experiment log (append-only) | `docs/EXPERIMENTS.md` |
| Per-session changelog | `docs/progress-log.md` |
| Sub-system deep-dive (e.g. CYNSN) | `docs/<system>-pipeline.md` |
| Open work | `TODO.md` |
| Claude Code skills / subagents map | `docs/AGENTS.md` |

---

## 3. Hard rules

1. **No code without docs.** Adding/changing an analyzer, parser, or model = update
   `docs/IMPLEMENTATION.md` and append `docs/progress-log.md`. Adding a new measurable claim =
   update `docs/RESEARCH_HYPOTHESIS.md`. Producing a new metric on real data = append
   `docs/EXPERIMENTS.md`.
2. **Device-space agnostic.** All new code in `frontend/src/lib/` must accept a
   `DeviceSpace` discriminator (`'rgb' | 'cmyk'`) and branch correctly. No hard-coded
   `RGB_R/G/B` field access in new analyzers — use the `Measurement.device` shape from
   `types/index.ts`.
3. **No silent data invention.** Parsers must throw or set `has_spectral=false` rather than
   fabricate spectra/Lab values. The old `icmParser` "synthetic fallback" path is deprecated;
   do not extend it.
4. **English in docs and UI strings.** Russian only in `docs/progress-log.md` and
   `docs/EXPERIMENTS.md` *conclusions* if the author prefers it (mixed bilingual is acceptable
   for those two files; everything else is English).
5. **CIE conventions:** D50 / 2° observer, Lab via XYZ from spectral integration. CIEDE2000
   for all ΔE comparisons. If you need another illuminant/observer, name it explicitly in the
   function signature.
6. **Tests for math.** Any new function in `lib/analyzers/` or `lib/colormath.ts` needs at
   least one unit test with a hand-computed or ISO-reference value. Tests live next to the
   source (`*.test.ts`).
7. **CI is the source of truth.** Local Node may be too old to run vitest (see §6).
   `git push` and check GitHub Actions; don't claim "tests pass" without CI green.

---

## 4. Conventions

### 4.1 Commits

Conventional Commits, imperative, ≤ 70 chars subject:

- `feat(cynsn): pass measured grid into trainCYNSN3 loss`
- `fix(parser): treat RGB ICC space as device space, drop CMYK fallback`
- `docs(ontology): add Experiment entity + lifecycle diagram`
- `chore: bump vite to 8.1`
- `refactor(types): introduce DeviceSpace discriminator on Measurement`

Body explains **why** when it isn't obvious from the diff. Reference an `EXPERIMENTS.md`
entry by date if the commit implements an experimental finding.

### 4.2 Code style

- TypeScript strict mode. No `any` without `// reason: …`.
- Functional React components. Zustand for shared state. No class components.
- D3 for visualisation. Recharts only if D3 is overkill.
- Pure functions in `lib/`. Side-effects only in components and `dataLoader.ts`.
- File naming: `camelCase.ts` for modules, `PascalCase.tsx` for components.
- Comment **why**, not **what**. Reserve comments for invariants, references to formulas,
  and known limits.

### 4.3 Documentation style

- Tables and bullet lists over prose.
- Every metric has a unit and a target threshold.
- Every formula is in a fenced code block or KaTeX (`$$ … $$`).
- Reference files as `path:line` when discussing concrete code.

---

## 5. Architecture map (quick)

```
frontend/src/
├── App.tsx                          entry, lays out ProfileUploader + ProfileList + ComparisonView
├── store/useProfileStore.ts         Zustand: profiles, selection, results
├── types/index.ts                   data model — includes DeviceSpace discriminator
├── lib/
│   ├── colormath.ts                 spectraToXYZ, xyzToLab, deltaE00 (CIEDE2000)
│   ├── cgatsExport.ts               CGATS.17 exporter
│   ├── dataLoader.ts                file dispatch (.icm / .cxf)
│   ├── iccTagScanner.ts             extractZxmlCxfXml(buffer) — locates + inflates ZXML tag
│   ├── parsers/
│   │   ├── cxfParser.ts             cc:CxF namespace XML → Measurement[]
│   │   └── icmParser.ts             ICC header → ZXML CxF → Measurement[]
│   └── analyzers/
│       ├── limitsAnalyzer.ts        per-channel ink limits via YN ramp prediction
│       ├── linearityAnalyzer.ts     Pearson/R²/slope-stability cross-substrate (LEGACY — see TODO)
│       ├── groupAnalyzer.ts         per-patch-group breakdown
│       ├── inkRatioAnalyzer.ts      T(λ) = R_ink/R_paper analysis
│       ├── spectralPredictor.ts     per-λ polynomial / YN models, XYZ affine
│       ├── spreading.ts             polynomial dot-gain (1 DOF per channel)
│       ├── optimizer.ts             Nelder-Mead simplex (pure TS)
│       └── cynsn.ts                 3D CYNSN: demichel3, grid build, train/eval
└── components/                      UI (ComparisonView is the hub)
```

---

## 6. Local environment caveats

- **Local Node is v12.** Vitest, tsc, vite all need ≥ 18. Don't fight it: write code, push,
  let CI run on Node 20. If you need to validate locally, install `nvm use 20` first.
- **WSL2 + Windows paths.** Sample data lives at
  `/mnt/e/PET/LinkedInPosts/surecolor-p9000/`. Don't import it into the repo.

---

## 7. When in doubt

1. Re-read this file.
2. Check `docs/ONTOLOGY.md` for the right vocabulary.
3. Check `docs/progress-log.md` for what was tried last.
4. Ask the user with a small, concrete question. Don't guess.

---

## 8. Anti-patterns (do not do)

- Writing code first, "I'll document it later." (No.)
- Inventing synthetic Lab/spectra when a parser fails. (Throw instead.)
- Adding a new metric to the UI without an `EXPERIMENTS.md` entry that justifies it.
- Hardcoding `255 - R` etc. inside a new analyzer — go through the DeviceSpace helper.
- Squashing many features into a single commit; the pre-commit hook will likely block you.
- Bypassing the pre-commit hook routinely (`--no-verify`). It's a budget, not a free pass.
