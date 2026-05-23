# PROMPTS.md — LLM prompt templates

> Reusable prompts for ad-hoc tasks on this project. Keep terse, deterministic, and aimed
> at producing artefacts that can be appended to `docs/EXPERIMENTS.md`.

---

## 1. Within-profile CYNSN baseline

> Run `runCYNSNComparison` on profile `<NAME>`. Report:
> (a) median ΔE00 and P95 ΔE00 on the held-out test split for YNSN and CYNSN-2,
> (b) fitted `n_exponent` and spreading parameters,
> (c) number of primaries matched at tolerance 0.10.
> Then append a row to `docs/EXPERIMENTS.md` and a paragraph to
> `docs/progress-log.md`.

## 2. Cross-substrate linearity check

> Pick two RGB profiles (`<REF>`, `<TARGET>`) printed on the same printer / ink set,
> different substrates. Compute:
> Pearson r in XYZ, Pearson r of spectra, mean per-patch spectral R², slope CV of
> per-wavelength linear fit, mean ΔE00 after the XYZ-affine correction.
> Cross-reference against `RESEARCH_HYPOTHESIS.md` H1 acceptance criteria.

## 3. Scientific-text drafting

> Draft a section in academic style with KaTeX. Topic:
> "Ink-spreading-enhanced spectral Yule-Nielsen Neugebauer model with residual correction
> and a linear substrate-adaptation hypothesis." Cite ISO 11664-6 for ΔE00 and
> ISO 17972-3 for CxF/X3. Output in Markdown with KaTeX inline (`$ … $`) and display
> (`$$ … $$`) math.

## 4. Visualisation request

> Generate a React + D3 component that overlays spectral curves from N profiles
> (default 2) with raw / clean toggle, ΔE labels per wavelength on hover, and a download
> button that emits the data as CGATS.17. Output a self-contained `.tsx` file matching
> the style of `frontend/src/components/SpectralCurves.tsx`.

## 5. Diagnostic question

> Why might the within-profile CYNSN median ΔE00 be higher than 2 on a specific profile?
> Enumerate likely causes (primary mismatch, Yule-Nielsen `n` near the cap, spreading
> hitting the monotonicity penalty, paper white drift, M-condition mismatch) and propose
> a verification step for each.

## 6. β-VAE prototype scaffolding

> Propose a conditional β-VAE architecture for disentangling **device-invariant** and
> **substrate-specific** factors in spectral print data. Inputs: 36-band reflectance +
> device colorant vector. Output: latent split into two groups, with a recovery loss for
> the device side and a Kullback–Leibler term for the substrate side. Frame as a PyTorch
> module sketch.
