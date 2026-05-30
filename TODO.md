# TODO

> Open work. Items resolved → move to `docs/progress-log.md` and an `EXPERIMENTS.md` row
> when applicable, then delete here.

---

## P1 — Cleaning pipeline

- [ ] Implement MAD outlier detection on spectra in `dataLoader.ts` (currently
      `clean === raw`).
- [ ] Implement Savitzky-Golay smoothing (window 5–7, order 2) for spectral cleaning.
- [ ] Compute `average_deltaE_raw_clean` honestly.

## P2 — Engineering

- [ ] Move CYNSN training to a Web Worker (Nelder-Mead blocks the main thread 1–5 s).
- [ ] Persist last selected profiles + ink limits to `localStorage` so dev iteration
      doesn't keep re-loading files.
- [ ] Replace legacy `icmParser` synthetic-fallback path with a hard error.

## P3 — Substrate transfer (Phase 3)

- [ ] Compute per-channel primary deltas between ref and target CYNSN fits.
- [ ] Test 8-primary calibration on substrate A predicting substrate B (target median
      ΔE00 < 3).
- [ ] Few-shot adaptation: minimum patches for ΔE00 < 3.

## P3 — Documentation

- [ ] Per-experiment screenshots saved under `docs/experiments/<date>-<slug>.png`.
- [ ] Article draft (`docs/article-draft.md`) — Substack post outline.

---

## Done — verify in CI (current branch)

- [x] Document-Driven Development scaffolding: `CLAUDE.md`, `docs/ONTOLOGY.md`,
      `docs/AGENTS.md` rewritten for subagents, all docs translated to English.
- [x] `docs/progress-log.md` and `docs/EXPERIMENTS.md` backfilled.
- [x] `.githooks/pre-commit` enforces progress-log update for `lib/` and `components/`
      changes; installed via `frontend/scripts/install-hooks.sh` triggered by
      `npm install` postinstall.
- [x] `.specify/`, `.kilo/`, `.lingma/` deleted.
- [x] `DeviceSpace` types + helpers added to `types/index.ts`; parsers populate `device`.
- [x] Duplicate `lib/cxFParser.ts` and `utils/cxfParser.test.ts` removed.

---

## Known environmental issues (not project bugs)

- **Local Node v12.** Cannot run vitest/vite. Use `nvm use 20` or rely on CI
  (GitHub Actions, Node 20). The `engines` field enforces `node >= 18`.

---

## Retired (2026-05-29 — H1 / H2 withdrawn)

H1 (CYNSN device-substrate separation) and H2 (DeviceSpace RGB↔CMYK invariance) were
withdrawn; see `docs/RESEARCH_HYPOTHESIS.md` Retraction (2026-05-29). The following are no
longer gating and are not planned:

- ~~CYNSN correctness: Bug 2 (`grid_cynsn2` ignored in `trainCYNSN3` loss), Bug 1 (`n` cap
  10→30), Phase-2 acceptance run on 27 profiles.~~
- ~~DeviceSpace migration epic: port `cynsn`/`limitsAnalyzer`/`groupAnalyzer`/
  `inkRatioAnalyzer`/`linearityAnalyzer` to `m.device`; remove legacy `RGB_*`/`CMYK_*`
  fields; H2 synthetic RGB-vs-CMYK fixture test.~~

Code already merged (DeviceSpace types/helpers in `types/index.ts`, CYNSN modules) stays as
inert scaffolding; revive only if a CMYK dataset arrives.
