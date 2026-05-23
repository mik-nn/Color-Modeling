# TODO

> Open work. Items resolved → move to `docs/progress-log.md` and an `EXPERIMENTS.md` row
> when applicable, then delete here.

---

## P0 — CYNSN correctness (blocks Phase 2 acceptance)

- [ ] **Bug 2 — CYNSN-2 grid/spreading mismatch**
      `trainCYNSN3` calls `buildGridFromColorants3` inside `loss()`, so the optimiser
      never sees `grid_cynsn2`. Fix: pass `grid_cynsn2` into `trainCYNSN3` and consume it
      directly inside `loss()`. For CYNSN-2, only `spreading` (and optionally `n`) should
      remain free; the grid itself is fixed from measurements.
      See `docs/cynsn-pipeline.md`.
- [ ] **Bug 1 — `n` hard cap at 10**
      Raise to 30 or replace with a soft penalty `max(0, n - 20)²`. Re-validate that
      training does not blow up on substrates with naturally low `n`.
- [ ] **Phase 2 acceptance run** — after both fixes, run `runCYNSNComparison` on all 27
      P9000 profiles; aim for median ΔE00 < 2 on at least 20 of them. Append the result
      table to `docs/EXPERIMENTS.md`.

## P1 — DeviceSpace migration (epic)

The `DeviceSpace` discriminator and `device: DeviceValue` field were added to
`types/index.ts` along with `toCMY`, `toCMYK`, `deriveDevice` helpers. Parsers populate
`device` alongside legacy fields. Next:

- [ ] Port `cynsn.ts` to read `m.device` via `toCMY()` instead of direct `RGB_R/G/B`
      access. Branch when `device.space === 'cmyk'` (treat K accordingly).
- [ ] Port `limitsAnalyzer.ts` ramp detection to consume `device` (RGB ramps today are
      hard-coded `R==255 && B==255` patterns).
- [ ] Port `groupAnalyzer.ts` and `inkRatioAnalyzer.ts` similarly.
- [ ] Port `linearityAnalyzer.ts` — currently a CMYK-fuzzy-match shell that runs on RGB
      via `MatchedPatchPair`. Either rewrite for DeviceSpace or delete if redundant with
      CYNSN.
- [ ] When every analyser uses `device`, deprecate `RGB_*` / `CMYK_*` fields with a
      compiler error (remove from `Measurement`).
- [ ] Add a synthetic-fixture cross-validation test: same data encoded as RGB and as
      CMYK should produce ΔE00 < 0.5 between CYNSN predictions (H2 acceptance).

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
