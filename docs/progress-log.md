# progress-log.md

> Append-only per-session changelog. Newest entries at the top. Bilingual EN/RU acceptable.
> Each entry: date, one-line summary, body explaining **why**, links to relevant
> `EXPERIMENTS.md` rows and commits.

---

## 2026-06-09: USFA CAE_D7 fix — per-mode split + CGATS reader

**Задача:** понять, почему модели не работают на USFA профилях; исправить.

**Диагноз:**

1. Корень провала USFA Unryu (washi) — `split.json` содержал PremLuster имена → `train.py` делал auto-split с seed=42, не гарантируя нужный состав; Kozo (единственный washi-якорь) мог не попасть в pool нужным образом.
2. `icm_reader.py` не читал MOAB `targ`/CGATS профили — возвращал None для всех 17 MOAB icc файлов (искал только ZXML/CxF тег). BC профили используют CxF3-core namespace (`http://colorexchangeformat.com/CxF3-core`), не старый `http://www.color.org/colorexchange`.
3. `profiles-all.json` содержал только 27 BC профилей; MOAB были исключены.

**Изменения:**

- `python/cae/icm_reader.py` — поддержка CxF3-core namespace (Target→RGB + Measurement→ReflectanceSpectrum join by Row/Col/Page) + CGATS `targ`-тег (MOAB). Нулевые байты в ZXML stripped. Металлические без спектров → None. 44/45 профилей читаются.
- `python/cae/split.json` — USFA-специфичный split: 5 train (Kozo в train), 1 test (Entrada Bright), 1 validation (Unryu).
- TS-экспорт перезапущен: `CAE_INK_MODE=all` → `profiles-all.json` (44 профиля, 18.88 MB); `CAE_PRINT_MODE=UltrasmoothFineArt` → `profiles-mk.json` (7 USFA).
- `python/cae/cv_train.py --variant d7 --folds 5 --epochs 50 --export-suffix USFA` на 7 USFA профилях.

**Результат:** Unryu med-of-med: **3.64 → 1.30 ΔE00** (×2.8 улучшение). Kozo→Unryu: 2.55 → **1.18**. p95 ≤ 4.0 (было ≤ 18.2). Урок: per-mode обязателен; явный split с washi в train — обязателен.

→ `EXPERIMENTS.md` строка 2026-06-09.

---

## 2026-06-09: k-sweep harness — D-optimal anchor selection vs greedy

**Задача:** реализовать сравнительный k-sweep: greedy (worst-patch) vs D-optimal (greedy Gram-Schmidt в PCA-пространстве `X_A`) для предикторов D1/C7 при k ∈ {3,5,8,13,20,30}, срезы same-mode / cross-mode.

**Реализация:**

- `lib/experiments/kSweep.ts` — `dOptimalAnchors`: PCA проекция `X_A` (rank=min(8,N-1,L)), жадный выбор строк с максимальной нормой остатка после проецирования; `runKSweep`: перебор всех направленных пар (классификация via `canonicalPrintMode`), greedy через `runGreedyActiveAnchors(seed=[paper], targetMedianDE=-Infinity)`, D-optimal через `dOptimalAnchors`, агрегация pass-fraction + медиан. H4 gate: median ≤1.5 AND p95 ≤3.0.
- `lib/experiments/kSweep.worker.ts` — Web Worker обёртка, прогресс-тики.
- `components/KSweepView.tsx` — вкладка k-Sweep: контролы, прогресс-бар, D3 line charts (pass-fraction vs k, median vs k), таблица min-k, CSV-экспорт.
- `App.tsx` — добавлена вкладочная панель Transfer / k-Sweep.

**Тесты:** 9/9 pass, 205/205 total. Фикстура требует ≥60 патчей (порог `alignByCommonSampleIds` = 50).

**Следующий шаг:** запустить sweep на всех 27 профилях, записать результат в EXPERIMENTS.md.

Обновлены: IMPLEMENTATION.md (разделы 2.1, 2.4.3, 2.5, 5).

---

## 2026-06-08: Cross-mode SVD tier analysis — coverage vs k, per-preset breakdown

**Задача:** детализировать cross-mode ранги по пресет-парам — понять, какие пары самые сложные и сколько якорей нужно для покрытия разных tier.

**Результаты (558 cross-mode пар, raw-вариант):**

- Coverage @99% энергии: k=7 → 91.8%, k=8 → **99.3%**, k=10 → 100%.
- Три тира: easy (rank≤5, 20%): VibranceMetallic↔Luster-пары, RMS=0.050; medium (rank 6–7, 72%): CanvasMatte↔WCRW, стандарт; hard (rank≥8, 8%): EMP-профили.
- Самые сложные target-пресеты: BC_1930_pk_EMP, BC_ArtPeelBlckt_mk_EMP, BC_VibranceGloss_pk_PGPP, BC_VibranceLuster_PLPP260 — все median rank=7, p95=8.
- Важный контр-интуитивный факт: hard-пары имеют **меньший** RMS (0.030) чем easy (0.050) — они спектрально компактны, но структурно богаче.

**Вывод:** для cross-mode D-optimal k=8 достаточен для 99.3% пар; EMP-профили требуют k=9. S1=13 перекрывает 100% с запасом. Следующий шаг: D-optimal anchor selection по SVD-базису остатка.

Обновлены: EXPERIMENTS.md (новая строка), RESEARCH_HYPOTHESIS.md (H5 Addendum 2026-06-08b).

---

## 2026-06-08: SVD rank analysis — raw vs d7, все 27 профилей

**CAE-диагноз (закрыт):** static CAE предсказывает из одной бумаги (k=0), anchor-fit предикторы (D1/C7) видят измеренные якоря. Разные задачи. CAE_LOO с 8-D latent + Nelder-Mead уступает C7/D1 в 5–6 ΔE на PremiumLuster (1 support). CAE убран из основного пайплайна, оставлен как baseline-линия.

**Инфраструктура:**

- `scripts/exportCaeData.ts` расширен: `CAE_INK_MODE=all` (mk+pk), `CAE_OUT_FILE`. Запуск на `/mnt/e/PET/LinkedInPosts/surecolor-p9000/` → `profiles-all.json` (8.92 MB, 27 профилей, 25 080 патчей).
- `python/cae/rank_analysis.py` — batch SVD остатков D=X_B−X_A для всех 702 пар, кэш `.npz`+`.json`, отчёт raw vs d7 + same/cross-mode срезы.
- `python/cae/icm_reader.py` — Python ICM/CxF парсер (minimal, defusedxml).

**Результаты SVD (702 пары, 27 профилей):**

- same-mode (n=144): median rank@99% = 5, p95 = 8. d7 ≡ raw (rank не меняется).
- cross-mode (n=558): median rank@99% = 6, p95 = 8. d7 ≡ raw.
- OBA-компенсация: снижает RMS на ~2%, ранг не трогает. OBA — не отдельная структурная степень свободы.
- 5 компонент покрывают 99.0% same-mode / 98.2% cross-mode энергии.

**Импликации для min-k:** info-theoretic нижняя граница = rank+1 = **6 патчей same-mode, 7 cross-mode**. Текущий S1=13 — достаточно с запасом. D-оптимальный выбор якорей по SVD-базису даёт min-k ближе к теоретическому пределу, чем greedy worst-patch. Следующий шаг: k-sweep с D-optimal vs greedy.

Обновлены: EXPERIMENTS.md (новая строка), RESEARCH_HYPOTHESIS.md (H5 addendum 2026-06-08).

---

## 2026-06-08: Документация H14 — два обязательных инварианта LOO

Зафиксированы два требования, нарушение которых делает LOO некорректным:

1. **Все профили режима** — `S = AllProfiles_mode \ {Target}` означает буквально все профили данного Epson media preset, а не только загруженные в текущей UI-сессии. Браузерная реализация обязана загрузить все профили режима перед запуском CAE_LOO; Python pipeline обязан включать все профили режима в LOO fold, не фиксированный 80/20 сплит.

2. **Единая RGB-сетка** — перед входом в Nelder-Mead каждый support-профиль `p ∈ S` должен быть WLS-интерполирован на точную RGB device grid целевого профиля (`B_raw.D`, форма N_target × 3). Текущий браузерный код имеет два пути: same-grid (SAMPLE_ID intersection, переменный размер) и different-grid (WLS, всегда N_target). Это несогласованность: при смешанных чартах (BC 905 + MOAB ~1550) same-grid путь даёт < 50 совпадений и падает в WLS, но WLS должен применяться всегда. Python `dataset.py` использует `common_keys &= …` — пересечение коллапсирует до N=10 при смешанных пулах (задокументировано в H10b full-pool failure). Правильное решение: WLS на референсную сетку для любого смешанного пула.

Обновлены `RESEARCH_HYPOTHESIS.md` (H14 Algorithm + Math) и `IMPLEMENTATION.md` (строки dynamicLOO.ts и Python dataset.py).

---

## 2026-06-08: Фаза C v3 — MOAB PremiumLuster via WLS interpolation; LOO support=5

Додано fallback у LOO support-set construction: якщо `alignByCommonSampleIds` дає < 50 спільних патчів (BC ↔ MOAB, різні сітки), будуємо WLS інтерполятор з джерела (k=16) і оцінюємо спектри на RGB-сітці цільового профілю. Результат: LOO support=5 (2 BC + 4 MOAB) замість 1. Метрики: CAE_LOO VL→RS median 7.77 (було 7.81 з 1 support). Гейн мінімальний — bottleneck у PremiumLuster CAE (навчений на 2 BC профілях), не в кількості support. Logged у EXPERIMENTS.md v3 row. Наступний крок: перенавчання PremiumLuster bundle з 6 профілями (4 MOAB + 2 BC).

## 2026-06-08: Фаза C — PremiumLuster H14 evaluation; k=3 fix; all 905 support patches

Bug corrected: CAE_LOO was passing S1 k=13 anchors as few-shot signal into the Nelder-Mead loss, over-specifying the target substrate. Fixed to k=3 (anchorIdx.slice(0,3) = paper + 2 chromatic). Removed 30-patch subsample cap on support profiles (now uses all patches, defaulting `maxPatchesPerSupport ?? Infinity`). Evaluated on both PremiumLuster pairs (VL↔RS): CAE_LOO median 7.8–8.9 (k=3, 1 support profile). C7 = 1.37–1.38. Root cause: PremiumLuster has only 2 profiles → 1 support → insufficient substrate manifold coverage for Nelder-Mead. H14 conditional pass: algorithm correct, needs |S| ≥ 3. Updated H14 status and algorithm spec in RESEARCH_HYPOTHESIS.md; logged Фаза C results in EXPERIMENTS.md. WCRW reference result (prev session, k=13): median 1.26, P95 3.90 (3 support profiles). See EXPERIMENTS.md row 2026-06-08 (Фаза C).

## 2026-06-08: CAE_LOO wired into UI; dynamicLOO.ts rewritten; display fixes

Diagnosed root cause of CAE_LOO being dead code: `predictTargetWithLOO` was never imported by TransferView. Three bugs fixed in the old implementation: (1) `refProfile: 'support'` caused ink encoder to use null_id instead of the real support profile's substrate ID; (2) latent init was zeros instead of `encodeSubstrate(targetPaper, null_id)`; (3) old code used target's N to index support profiles. Rewrote `dynamicLOO.ts` with clean `LOOProfileData` interface (flat matrices), correct profile IDs for ink encoder, subsampled loss (≤30 patches/profile for optimizer speed), few-shot anchor term, init from target paper. Exported `CAEForward` from `cae.ts` for direct use in optimizer loop without evaluation overhead. Added `CAE_LOO` predictor to TransferView with same-mode support set construction (canonicalPrintMode grouping, alignByCommonSampleIds per support profile). UI: "Worst 5 patches" now shows `(R,G,B)` triples; anchor list shows `(R,G,B)` instead of SAMPLE_IDs. Baseline experiment logged in EXPERIMENTS.md (H14 observation: C7/D1 beat all CAE variants on every mode except WCRW). See EXPERIMENTS.md row 2026-06-08.

## 2026-06-07: Added optimizer.ts (Nelder-Mead) and dynamicLOO.ts for LOO dynamic training. 
Fixed spectraToXYZ/xyzToLab/deltaE00 signatures. Added overrideSubstrateLatent to CAERunInput. Hypothesis 4 under validation.
## 2026-06-07: Pivot to intra-mode LOO dynamic training. 
Static CAE fails when mixing WCRW/PremiumLuster. Implemented dynamic substrate latent optimization via Nelder-Mead on support set (All\{Target}) before anchor residual application. Hypothesis 4 formulated. Code isolated to `lib/analyzers/dynamicLOO.ts`.


## 2026-06-03 — CAE_D7_3ANCHOR + learnable descriptor framework for Premium Luster

**Part 1: CAE_D7_3ANCHOR** — Lab-direction 3-anchor selector (complete, working).
User provides angle1/angle2/chroma in UI → selector finds closest patches in a/b* space → CAE inference + anchor fine-tuning.
Results show k=3 is experimental but foundation laid.

**Part 2: Learnable substrate descriptor** — Core framework for fixing CAE on small-mode datasets (Premium Luster: 3 profiles).
Replace one-hot profile ID encoding with computed features: **OBA Score + Paper White-point (5 scalars)**.

Changes:
- `frontend/src/lib/colormath.ts`: `extractSubstrateDescriptor(paper) → [OBA, WP_X, WP_Y, WP_Z]` (normalized)
- `frontend/src/lib/predict/caeTrain.ts`: New file. `CAEForwardLearnable` (forward pass with descriptor),
  `trainCAELearnable(input)` async loop (loss computation, non-blocking via setTimeout).
- Weights initialized randomly, export/import JSON ready.

**Why this fixes Premium Luster:**
- Old CAE: 44-dim one-hot(44) with only 3 training examples → memorization, bad generalization.
- New CAE: 4-dim descriptor (OBA + WP) → encodes substrate *properties* not *identity* → zero-shot on unseen profiles.

**Next steps (not done yet):**
1. TransferView integration: UI sliders for anchor_count / chroma / train params, "Train" button, loss curve display.
2. SGD backprop: implement full gradient computation (currently loss-only).
3. Export/import UI: download weights JSON, re-load from file.
4. Test on Premium Luster pairs vs D1 to validate the hypothesis.

**Status:** Commit `178eeff` — foundation layer complete. Ready for TransferView wiring.

---

## 2026-06-03 — CAE_D7_3ANCHOR predictor: 3-anchor Lab-direction selector

Implemented a new predictor mode `CAE_D7_3ANCHOR` that selects anchors automatically via Lab
hue direction + chroma matching. User provides angle1 (default 45°), angle2 (default 165°),
and chroma target (default 30) via new UI sliders. Selector finds the closest patch to each
(angle, chroma) point in a/b* space (ignoring L*). Uses existing CAE fine-tuning infrastructure
(`anchorResiduals`) to correct substrate latent based on anchor residuals.

**Why**: Hypothesis is that 2 well-chosen chromatic anchors + anchor fine-tuning can reduce
P95 ΔE00 from ~5.3 (S1's 13 anchors) to <2.0 with only 3 inputs. No other predictor is
currently gated by chroma-aware anchor selection, so this is a pure research hook.

**Changes**:
- `frontend/src/lib/predict/cae.ts`: Exported `buildAnchorResiduals(input)` helper to expose
  `CAEForward` encoding for per-anchor residuals (sub_A, sub_B, ink_lat_A, ink_lat_B).
- `frontend/src/components/TransferView.tsx`:
  - Added `pickLabDirectionAnchorIdx()` pure helper to find paper + 2 chromatic anchors.
  - New state: `angle1` (45°), `angle2` (165°), `chromaTarget` (30).
  - New `runCAE_D7_3ANCHOR()` adapter that calls picker, builds residuals, runs CAE with
    `anchorResiduals` parameter.
  - New UI panel (conditional on `predictor === 'CAE_D7_3ANCHOR'`): 3 sliders for
    angle1/angle2/chroma.
  - Wired into `dispatch`, `variants`, `runs` logic with proper CAE metrics (refInTrain,
    targetInTrain, bestTestMSE).

Existing predictors (A3, D1, B3, C7, CAE_RAW, CAE_D7, CAE_D7_M1) unchanged. Anchor
strategies S1/S2/S3/S4 unchanged. No new tests needed (pure wrapper over existing CAE logic).

---

## 2026-05-30 — H10b L2-init regulariser (Pareto-best default)

USFA's H10b P95 ballooned from 4.68 (baseline k=0) to 8.38 with the default fine-tune.
A grid sweep over (lr ∈ {0.005, 0.01, 0.02, 0.05}) × (steps ∈ {50, 100, 200}) gave the
same P95 ≈ 8.3 — the optimisation converged to the same minimum regardless of step size,
so the problem is structural over-fit of the 8-dim substrate latent on k = 13 anchors,
not an optimisation knob. Added an **L2 penalty** that pulls `sub_b` toward the
encoder's initial estimate (`finetune_sub_b(..., l2_init)` + `--l2-init` CLI arg).

L2 sweep across three per-mode CAEs:

| Mode | k = 0 baseline (med / P95) | H10b l2 = 0 | H10b l2 = 0.1 |
| --- | --- | --- | --- |
| WCRW | 0.98 / 2.27 | 0.88 / 2.56 | 0.93 / **2.13** |
| USFA | 2.26 / 4.68 | 2.11 / 8.38 | 2.16 / **4.29** |
| CanvasMatte | 2.58 / 4.86 | **1.73 / 4.10** | 2.15 / 4.27 |

**`l2 = 0.1` is Pareto-best as the default**: improves P95 dramatically on WCRW (−17 %)
and USFA (−49 % vs unregularised, even better than the k = 0 baseline), at the cost of a
tiny median bump (5 % on WCRW). On OBA-disparate modes (CanvasMatte) the unregularised
H10b still wins on median because the anchor signal disambiguates the high-OBA / low-OBA
sub-clusters — `l2 = 0` recommended there. Default `--l2-init 0.1`; override with
`--l2-init 0` for OBA-loaded substrate pairs.

---

## 2026-05-30 — Per-mode CAE_D7 + H10b anchor fine-tune (huge win)

The 36-profile pool CAE_D7 saturated at median-of-medians ΔE00 = 3.30 on validation
because the substrate manifold spans 10 wildly different Epson presets and 8 substrate
latent dims can't fit them all. Switched to **per-print-mode CAE_D7**: filter the export
to a single Epson preset, run the 3-set split + 5-fold (or 3-fold) CV pipeline per mode,
get a smaller / tighter manifold per model. Each per-mode model now monitors against its
own validation set (still held out).

Additionally re-tested **H10b** (anchor fine-tune at inference): few-shot gradient on
`substrate_latent_B` over k S1 anchors of the target, then decode all non-anchor patches
with the fine-tuned latent. Required earlier work (bank.N was 10 on the 36-profile pool
because `ProfileBank` intersects RGB across all profiles — useless for evaluation); the
per-mode pools share a chart so bank.N rises to ~905 (BC) or ~2033 (MOAB), making k = 13
viable.

| Pool | CV mean MSE | Val MSE | k = 0 median ΔE00 | H10b k = 13 median | k = 0 ≤ 1.5 | H10b ≤ 1.5 |
| --- | --- | --- | --- | --- | --- | --- |
| Full 36 (mixed presets) | 0.00206 | 0.00150 | 3.30 | 3.25 | 1.0 % | 6.9 % |
| **WCRW (9 BC)** | **0.00039** | **0.000112** | **0.98** | **0.88** | **100 %** | **100 %** |
| USFA (7 MOAB) | 0.00101 | 0.00137 | 2.26 | 2.11 | 30 % | 40 % |
| **CanvasMatte (5 BC)** | ~0.0004 | 0.000331 | 2.58 | **1.73** | 0 % | **25 %** |

**Two effects compound:**

- *Per-mode focus alone* drops the validation median 3.4× on WCRW (3.30 → 0.98) and
  meaningfully on USFA / CanvasMatte. The model can model one homogeneous substrate
  family well within an 8-dim latent.
- *H10b anchor fine-tune* helps more where the per-mode baseline still has room: −10 %
  on the already-tight WCRW, −7 % on USFA, **−33 % on CanvasMatte** (where the high-OBA
  vs low-OBA cluster split inside the mode is exactly what 13 anchors can correct).

Per-mode weights archived as `python/cae/weights/cae_d7_{WCRW,USFA,CanvasMatte}.pt`;
the original 36-profile model saved as `cae_d7_full36.pt`. Frontend's
`frontend/src/data/cae_weights_d7.json` is unchanged (still the full-36 export) — a
follow-up will add a mode selector in the UI so the CAE_D7 predictor loads the right
mode-specific weight.

New `evaluate.py --anchors k` flag drives the H10b path (Adam, 200 steps, lr = 0.05).
Output split into `evaluate_d7.json` (baseline) and `evaluate_d7_a{k}.json` (with
anchors). `split.py` floor lowered to 5 profiles for per-mode pools; `cv_train.py`
skips folds with eval < 2 profiles and falls back to test for monitoring when
validation has < 2.

---

## 2026-05-30 — H12 — single-α OBA emission scaling (REJECTED)

User-proposed hypothesis: derive a per-profile OBA contribution from a handful of
diagnostic anchors (paper + yellow + gray + cyan/blue), then scale the default D7
emission model by a fitted α to fix the cross-vendor OBA-band residual. Implemented
`lib/predict/obaModelFit.ts` (closed-form weighted-LSQ α-fit from anchor patches +
their per-anchor poly2 baselines), wired into a test runner
`scripts/experiments/h12_oba_scale.ts` (DecorMatte ref vs Lyve / BelgianLinen /
ChromataWhite targets, 4 anchor recipes).

**Rejected.** α_ref on DecorMatte ranged 0.30–1.83 across recipes (CV ≈ 79 % vs the
30 % falsification threshold). On all three OBA-disparate pairs H12 either tied
or worsened median ΔE00 by +0.01 to +0.14. Diagnosis: yellow ink has T(440) ≈ 0,
so its observed emission contribution is tiny regardless of substrate emission
magnitude — the LSQ reads this as "low α" and the uniform scaling then cancels
real emission contribution at other patches. A single profile-level scalar cannot
capture the per-ink visible-band attenuation of fluorescent emission. The right
model is per-band attenuation `g(λ)` fitted from yellow/cyan/red anchors, not a
scalar — deferred (the CAE_D7 absorbs this structure implicitly).

The module + tests remain useful as a building block when the richer per-band
model is implemented. See `docs/RESEARCH_HYPOTHESIS.md` H12 Result + `EXPERIMENTS.md`.

---

## 2026-05-30 — H13c (adaptive gate) + plain-D1 reveal D7 wrapper is redundant

Excluded AllureAq (1550-patch chart that breaks cross-chart SAMPLE_ID alignment, 41+ ΔE
artefact) from the same-mode H4 bucket — its print mode is effectively "unknown to us"
until the parser/alignment layer handles different chart sizes properly. Added two new
columns to `h13_m0m2.ts`:

- **plain D1**: D1+S1, `residualRank=5`, `uvBandCount=4`, **no D7 wrapper at all**.
- **H13c**: adaptive gate on `obaMismatch(papA, papB)` — below 0.10 use plain D1 (no
  compensation), at or above 0.10 use H13b (anchor-driven kNN emission).

Result on 90 same-mode BC pairs (AllureAq excluded):

| predictor | med-of-meds | P95-of-meds | losses ≥ 0.1 vs base |
| --- | ---: | ---: | ---: |
| plain D1 (no OBA) | **0.800** | 1.416 | — |
| baseline D7-default | 0.803 | 1.416 | — |
| H13 (paper-scaled emission) | 0.986 | 1.577 | 42 |
| H13b (anchor kNN emission) | 0.856 | 1.547 | 23 |
| **H13c (adaptive gate)** | **0.817** | 1.466 | **10** |

**Surprising finding: the D7 OBA wrapper is essentially redundant.** Once D1 carries
`residualRank=5` + `uvBandCount=4` (the 2026-05-29 tuning), plain D1 matches baseline
D7-default exactly on med-of-medians and P95-of-medians (0.800 / 1.416 vs 0.803 / 1.416).
The UV-clamp + high-rank residual already absorb most of the OBA non-linearity — analytic
emission subtraction adds variance equal to what it removes on average.

**H13c is the right tool but it's a small win on top of an already-tight baseline.**
The cheap measured-emission injection above threshold helps OBA-disparate pairs by
0.08–0.09 ΔE (DecorMatte → Lyve, DecorMatte → ChromataWhite, 800M → BelgianLinen) — but
the bulk of pairs benefit more from leaving the spectra alone. Below-threshold pairs
correctly route to plain D1 → no penalty.

Implication: the H13 acceptance bar (`median improvement ≥ 0.3 ΔE`) was set too high given
how good the post-2026-05-29 D1 already is. The realistic gain is **0.08–0.09 ΔE on the
OBA-disparate slice**, which is what H13c captures.

Next: deploy H13c as the default OBA path in `TransferView` (replaces the D7-default
toggle); strip the analytic D7 emission code from the default predictor pipeline (keep
`obaSeparator` as a diagnostic). Article framing: *"Once D1's residual is rich enough,
OBA fluorescence is a small residual signal, not a dominant non-linearity. Measured
M0/M2 anchors recover the last 0.08–0.09 ΔE on OBA-disparate pairs but don't materially
move the dataset median."*

Per-pair JSON at `frontend/data/cae-input/h13_m0m2.json` with `plain_*`, `base_*`, `h13_*`,
`h13b_*`, `h13c_*`, `obaMismatch`, `h13cUsedB` per row. tsc 0, 188 tests green.

---

## 2026-05-30 — H13 (measured M0/M2 OBA correction) — REJECTED on average; per-mode H4 breakdown

**Parser extension.** `cxfParser` now collects paired **M2** (UV-cut) spectra alongside the
primary M0 measurement per patch, exposed as `Measurement.spectra_m2`. Probe across all
26 BC profiles: M2 paired in **23**. Three profiles carry M2 only (BC_1930, BC_PhotoPeelGloss,
BC_RiverStone — all pk). M0-preference reordered to **M0 > M1 > M2** so the primary
`spectra` field and `spectra − spectra_m2 ≈ measured fluorescence` stay aligned.

**Per-mode H4 breakdown (D1+S1+D7+rank=5+UV-clamp, 98 same-mode BC pairs):**

| mode | n | med-of-meds | H4 pass | worst pair (median) |
| --- | ---: | ---: | ---: | --- |
| WCRW | 56 | **0.748** | **100 %** | OpticaOne → VibrancePhotoMatte 1.03 |
| CanvasSatin | 12 | 1.059 | 67 % | Silverada → Crystalline 1.35 |
| CanvasMatte | 20 | 1.072 | 60 % | DecorMatte → ChromataWhite 1.89 (OBA-disparate) |
| PremiumGlossy | 6 | 1.233 | 50 % | VibranceMetallic → PhotoPeelGloss 1.77 |
| PremiumLuster | 2 | 1.607 | 0 % | RiverStone → VibranceLuster 1.61 |
| EnhancedMatte | 2 | 2.173 | 0 % | 1930 → ArtPeelBlckt 2.17 |

WCRW solves cleanly; CanvasMatte and CanvasSatin are mid-tier with OBA-disparate outliers;
the small-n modes (Premium Luster / EMP) need more profiles before a per-mode conclusion is
fair.

**H13 (simple, M0/M2-based OBA correction) — REJECTED.** New
`scripts/experiments/h13_m0m2.ts`: train D1 on the OBA-free M2 spectra (no UV clamp), then
re-add measured emission `E_patch(λ) = E_paper(λ) · u(patch)` with
`u = R_patch_m2(380) / R_paper_m2(380)`. Compared against the current best
`D1+S1+D7-default` on 92 same-mode BC pairs:

| metric | baseline D7 | H13 simple |
| --- | ---: | ---: |
| med-of-medians | 0.806 | **0.987** |
| P95-of-medians | 1.442 | **1.619** |
| wins / losses ≥ 0.1 ΔE | — | **0 wins / 43 losses** |
| H4 pass rate | 83.7 % | 84.8 % |

H13 helps where physically expected — the OBA-extreme Canvas Matte pairs (DecorMatte → Lyve
−0.09, 800M → BelgianLinen −0.09, DecorMatte → ChromataWhite −0.06) — but **hurts on every
other mode**, dragging WCRW (n=56) up 0.17 median. Root cause: the per-band scaling
`u(patch) = R_patch_m2(380) / R_paper_m2(380)` is too crude — when paper OBA is small
(most pairs) the measured `E_paper` carries measurement noise and the `× u` step amplifies
it onto every non-anchor patch.

**Honest conclusion: M0/M2 measurement *data* is valuable (it pins emission directly), but
re-projecting emission onto non-anchor patches via a single global UV factor is the wrong
model.** The next experiment is H13b: replace the global `u` with **anchor-driven kNN
emission interpolation** — for each anchor, take its measured `E_anchor = M0_anchor − M2_anchor`
as a direct emission sample; for non-anchor patches, interpolate `E(λ)` from the k anchor
emissions weighted by RGB distance. This grounds the emission magnitude in actual
multi-coverage measurements instead of a single paper-relative ratio.

188 tests green, tsc clean. Per-pair JSON at
`frontend/data/cae-input/h13_m0m2.json`.

---

## 2026-05-30 — H4-revised registered; h4_batch extended with CAE_D7 column

**H4-revised (RESEARCH_HYPOTHESIS.md).** New dated section reframes the original H4
(cross-substrate transfer at k ≤ 15, ≥ 80 % of pairs) to the **same Epson media preset**
sub-claim. Acceptance bound met (80.6 %, 98 BC same-mode pairs) under D1+S1+D7+rank=5+
UV-clamp. Cross-preset transfer flagged as a separate problem (H10b territory).

**h4_batch.ts extended** with a CAE_D7 column. Per pair: also run `runCAETransfer` with the
mode-specific weight bundle picked by `pickCaeBundle(refPreset, tgtPreset)` (same logic as
TransferView's `pickCaeD7Bundle`), at **k = 0** (paper-only, no anchor fine-tune — that
lives in Python `evaluate.py` only). Re-ran the 600-pair batch:

| Slice | n | D1+S1+D7 med-of-meds | D1 H4 pass | CAE_D7 k=0 med-of-meds | CAE pass |
| --- | ---: | ---: | ---: | ---: | ---: |
| same-mode | 98 | **0.84** | **80.6 %** | 1.17 | 53.1 % |
| cross-mode | 502 | 2.47 | 0.8 % | 6.06 | 0.0 % |
| all | 600 | 2.36 | 13.8 % | 5.85 | 8.7 % |

Same-mode story: D1 with 13 measured anchors beats CAE_D7 at k = 0 (0.84 vs 1.17 median) —
the anchors carry the bulk of the substrate signal that the per-mode CAE has to infer from
paper alone. **CAE_D7 k = 0 on same-mode pairs reaches 53.1 % pass** — a strong paper-only
baseline given how much harder the task is than the anchored equivalent.

Cross-mode story: neither D1+S1 (0.8 %) nor CAE_D7 k = 0 (0.0 %) clears the bound. CAE k = 0
is materially worse because the mode-bundle picker falls back to `full36` for any pair where
the two profiles disagree on preset — and the full36 model has the harder substrate manifold
to span. The next experiment is H10b: CAE_D7 with anchor fine-tune at inference (k = 13,
L2 reg = 0.5 per the USFA sweep), already proven to lower P95 by 14–20 % on per-mode runs.

Per-pair JSON now carries both D1 and CAE columns at
`frontend/data/cae-input/h4_batch.json` for the article's headline plot.

188 tests green, tsc clean.

---

## 2026-05-30 — H4 batch: D1+S1+D7+rank5+UV clamp on 600 BC pairs; PremiumLuster per-mode CAE

**H4 batch acceptance run.** New `scripts/experiments/h4_batch.ts` walks every
ordered same-chart pair of BC P9000 profiles (27 profiles → 702 directed pairs,
600 with ≥100 shared SAMPLE_IDs after dropping the 1550-patch `AllureAq` and
its non-overlap targets). Each pair runs D1 with current TransferView defaults:
`residualRank=5`, `uvBandCount=4` (per-band UV clamp), D7 OBA-separation ON,
S1 forced anchors (k=13).

Aggregate over **all 600 BC pairs**:

| Metric | Value | Threshold |
| --- | --- | --- |
| median-of-medians ΔE00 | **2.358** | — |
| median-of-P95s | 6.00 | — |
| fraction median ≤ 1.5 | 17.0 % | — |
| fraction P95 ≤ 3.0 | 13.8 % | — |
| **fraction H4 pass (both)** | **13.8 %** | ≥ 80 % |

→ **H4 REJECTED at the dataset level.** But the same-mode / cross-mode
breakdown rescues the headline:

| Slice | Pairs | med-of-meds | H4 pass |
| --- | --- | --- | --- |
| **Same Epson preset** | 98 | **0.84** | **80.6 %** ← passes |
| Cross-preset | 502 | 2.47 | 0.8 % |

→ **H4 holds when scoped to same Epson media preset.** The 80 % acceptance is
met on the 98 same-mode BC pairs. Cross-preset transfer with k = 13 anchors is
essentially hopeless under D1+S1 — different ink mode (mk vs pk), different
total ink limit, and different driver media settings move device response
beyond what a paper-ratio + low-rank residual can absorb.

Worst pairs (all cross-mode): DecorMatte (CanvasMatte mk, OBA-extreme) → photo-paper
glossy / satin targets (~3.7–3.9 median, P95 9–11). The S1 anchor set is fundamentally
inadequate for these — needs either many more anchors or a richer model.

**PremiumLuster per-mode CAE.** With only 5 MK PremiumLuster profiles available
after the mk/unknown filter, the 3-way split degenerates to 3 train / 1 test / 1
validation, so cross-validation is essentially LOO. `cv_train.py` adapted to:
(a) cap folds to pool size, (b) fall back to test (then loose train) for
monitoring when validation has < 2 profiles, (c) skip folds with
< 2 train or < 2 eval profiles. Final model trained on all 4 train+test
profiles, monitored on the train pool itself (loose): MSE 0.0027 at epoch 49.
JSON exported to `frontend/src/data/cae_weights_d7_PremiumLuster.json` and
wired into the `CAE_D7_BY_MODE` registry. EMP skipped — only 2 MK profiles
pass the exporter filter.

Other improvements this session:
- `exportCaeData.ts CAE_PRINT_MODE` now matches via `canonicalPrintMode` so BC
  abbreviations and MOAB Epson-ish names collapse onto the same preset.
- `cv_train.py --export-suffix <name>` auto-runs `export_weights.py` so future
  per-mode runs are a single command.
- `split.py` minimum profile count lowered from 9 to 5; cv NaN summary now
  serialises as JSON `null` instead of unparseable `NaN`.

188 tests green, tsc clean. `frontend/data/cae-input/h4_batch.json` carries the
full 600-row per-pair table for later analysis.

---

## 2026-05-30 — CAE_D7 retrained with classic train/test/validation + 5-fold CV

Pipeline now follows the textbook three-set protocol: `split.py` writes
`train` / `test` / `validation` (22 / 7 / 7 from the 36-MK pool, deterministic
seed 42). `cv_train.py` runs **5-fold CV over `train ∪ test`** (29 profiles, 23/6
per fold, monitoring held-out MSE per fold), then trains a final model on the
full 29-profile pool while monitoring the **validation** set (never seen during
CV). `evaluate.py` gained `--set {test, validation}` (default `validation`) so
the final ΔE00 number is always measured against the outer held-out set.

**5-fold CV (train ∪ test, 50 epochs / fold):** per-fold best MSE
[0.00279, 0.00185, 0.00207, 0.00196, 0.00163] → **mean 0.00206 ± 0.00039**.

**Final model (29 train, monitored on 7 validation, 50 epochs):**
validation MSE **0.001495**.

**Validation ΔE00 (paper-only prediction, k = 0 anchors):**
median-of-medians **3.30**, median-of-P95s 7.42, 1.0 % of pairs ≤ 1.5, 34 % ≤ 3.
Per validation target (median across 29 ref profiles):

| target | median | worst |
| --- | --- | --- |
| MOAB Entrada Rag Natural (USFA) | **1.77** | 2.77 |
| BC_ChromataWhite (CanvasMatte, low OBA) | 2.59 | 3.67 |
| BC_800M (CanvasMatte, high OBA) | 3.16 | 3.97 |
| BC_Signa270 (WCRW) | 3.37 | 4.50 |
| BC_PuraVelvet (WCRW) | 3.49 | 4.61 |
| BC_BagasseSmooth (WCRW) | 4.22 | 5.52 |
| BC_VibranceMetallic (Premium Glossy, metallic) | 4.50 | 5.55 |

The CAE is competitive on substrate categories well-represented in the training
pool (MOAB USFA: 1.77 median) and degrades on under-represented substrates
(BC matte/canvas, metallic). Honest result: as a **k = 0 anchor predictor** it's
useful but doesn't beat A3/D1/C7 with 13 anchors (~1.5 ΔE00 on cross-substrate).
The next lever is anchor fine-tune (H10b) at inference — that path remains open.

Exported weights to `frontend/src/data/cae_weights_d7.json` (228 KB) for the
TransferView CAE_D7 predictor. `export_weights.py` now tolerates bundles from
either `train.py` (loss_curve present) or `cv_train.py` (cv stats present).

182 tests green, tsc clean.

---

## 2026-05-30 — H11 sharpened: local-linear WLS interpolant + per-pair breakdown; GLOSSARY.md

**Local-linear WLS interpolator (big win).** New `lib/interp/wlsInterp.ts`: at each
query point fit a hyperplane `R(λ) ≈ β₀ + β·rgb` per band from the k nearest neighbours
weighted by `1/d²`, solve via Cholesky on the 4×4 normal equations, fall back to IDW
when neighbours are collinear. Same `Interpolator` interface as `rgbInterp` so it's a
drop-in. Default in `modeCompare`: `MODE_INTERP=wls`, `MODE_KNN=20`, `MODE_GRID_LEVELS=11`.

H11 results with WLS (vs the previous IDW numbers, all device-normalised):

| preset | median IDW → WLS | P95 IDW → WLS |
| --- | --- | --- |
| Canvas Matte | 1.62 → **1.20** | 3.48 → **3.28** |
| Premium Luster | 1.75 → **1.38** | 3.79 → **3.27** |
| Premium Glossy | 1.88 → **1.34** | 4.39 → **3.96** |

Interpolation noise floor (held-out 10 %) drops in lock-step: BC ΔE00 median 1.81 → **0.66**,
MOAB 1.33 → **0.43**. Cross-set ΔE00 now sits clearly above the floor (no longer
floor-limited) — the residual is mostly real substrate difference.

**Per-pair breakdown surfaces the actual outliers.** Added a cross-set per-pair table
to `mode-comparison.md`. Surprise: the metallic `VibranceMetallic` is NOT the
Premium-Glossy outlier (P95 1.91, the BEST in the group). The dragger is
`PhotoPeelGloss × MOAB Lasal Gloss` (median 2.52, P95 4.70). Canvas Matte outliers are
the OBA-extreme BC papers (DecorMatte, 800M) paired with the low-OBA MOAB Anasazi —
cross-vendor OBA chemistry isn't perfectly captured by D7's quadratic-extrapolation
emission. Most pairs are now P95 < 3; the residual outliers are physically grounded
(OBA chemistry differences across vendors), not interpolation artefacts.

**GLOSSARY.md.** First pass at the project's article-ready terminology — colour-science
basics, file formats, hardware/print modes, substrate physics, predictor/anchor IDs,
hypotheses, interpolation methods, statistics. Lives alongside `docs/ONTOLOGY.md`
(which keeps its existing small operational glossary). Goal: anyone (including an
external co-author) can read the project's experiments without inferring acronyms.

182 tests green (added 5 for WLS), tsc clean.

---

## 2026-05-29 — D1 defaults tuned for OBA-disparate pairs (rank 5, UV-aware clamp, D7 on)

Triggered by a focused look at `BC_DecorMatte`, the OBA-extreme paper in Canvas Matte
(R(380)=0.117, OBA score 1.196 — Z=-1.56 within the cluster, dataset-wide rank #2 by
UV absorption after AllureAq). Paper-ratio at 380 nm for DecorMatte ↔ low-OBA papers in
the same mode hits 5.05–5.94× — the default D1 clamp `[0.3, 3.0]` truncates 2 bands and
loses real signal.

Three changes shipped together (`analyzeDecorMatte.ts` + `compareD1Defaults.ts` for the
diagnostic + measurement):

1. **D1 default residual rank 2 → 5** (`TransferView.tsx`). H5 showed the substrate-transform
   difference has median effective rank 5 at 99% energy; rank-2 systematically under-captures
   the OBA + ink-coverage structure on top of paper white.
2. **Per-band UV clamp** in `paperRatioResidual.ts`: new options `ratioClampUV`
   (default `[0.1, 7.0]`) and `uvBandCount` (default 0 — opt-in). TransferView passes
   `uvBandCount: 4` (380–410 nm), so the UV ratios can grow to 5–7× without truncation,
   while 420–730 nm keeps the conservative `[0.3, 3.0]` clamp. Default behaviour of the
   library function is unchanged (existing tests pin `[0.3, 3.0]`).
3. **D7 OBA-separation default ON** (`obaSeparate: true`). The wrapper is a no-op for
   non-OBA substrates (emission ≈ 0), so making it the default is safe and removes a
   manual toggle for the OBA case.

Quantified on three same-chart pairs against DecorMatte (S1, k=13):

| pair | OLD median / P95 | NEW median / P95 | clamped bands old → new |
| --- | --- | --- | --- |
| DecorMatte ↔ Lyve          | 1.447 / 5.099 | 1.416 / **4.057** (−20% P95) | 2 → 0 |
| DecorMatte ↔ BelgianLinen  | 1.659 / 4.726 | 1.468 / **4.007** (−15%)      | 2 → 0 |
| DecorMatte ↔ ChromataWhite | 1.928 / 7.471 | 1.886 / **6.419** (−14%)      | 2 → 0 |

The median moves modestly (rank=5 is the main mover here); the big win is P95 (worst-patch
behaviour) dropping 14–20% and zero clamped bands across the board — UV information is
preserved instead of truncated. UV-clamp *alone* hurts (the wider band admits noise without
the D7 stabiliser); the three changes are complementary.

177 tests green, tsc clean, Playwright check confirms the new defaults are applied in the
live app (D7 checkbox on, rank-5 selected by default; cross-chart paths unaffected).

---

## 2026-05-29 — TransferView UI: .icc upload + cross-chart grid alignment

Two reported bugs from a live run.

**(1) `.icc` files invisible in the uploader.** `ProfileUploader.tsx` had
`accept=".icm,.cxf"` even though `dataLoader.ts` already dispatches `.icc` through
the same ICM parser path. Added `.icc` to the accept list and the user-facing
labels so MOAB profiles can be added by drag-drop or the file picker.

**(2) Cross-chart compare hard-errored on "Only 0 shared SAMPLE_IDs".** The
transfer pipeline aligned profiles by SAMPLE_ID (Row:Col:Page), which fails for
BC (905-patch chart, integer RGB) ↔ MOAB (~2033-patch chart, fractional RGB
levels) because the two charts don't share IDs. Added
`alignByDeviceGrid(A, B, levels=9)` in `lib/dataset/matrix.ts`: builds per-band
k-NN IDW interpolators on each profile, resamples both onto a common RGB lattice
restricted to the intersection of the two device bounding boxes, returns
aligned `X_A` / `X_B` / `D` plus synthetic `G:r-g-b` sampleIds. `TransferView`
now falls back to grid alignment when shared SAMPLE_IDs < 50, and the rest of
the predictor pipeline (anchors, A3/D1/B3/C7, OBA separation, evaluation) runs
unchanged because it consumes the aligned matrices. UI gains a `crossChart`
banner and the metric label switches from "shared SAMPLE_IDs" to
"grid points (interp)" when interpolation was used. Anchor heuristics keep
working because `pickHeuristicAnchors` selects by nearest RGB, and the regular
grid contains the corners + neutrals exactly.

177 tests green (added 2 for `alignByDeviceGrid`), `tsc --noEmit` clean.

---

## 2026-05-29 — H11: substrate normalisation closes the cross-vendor gap; PCA rejected

Two follow-ups to the H11 mode comparison.

**PCA-score interpolation (rejected).** Added `lib/interp/pcaInterp.ts` (PCA via a Jacobi
eigensolver + score-space IDW) as an alternative to per-band IDW, hypothesising that coupling
the 36 bands would denoise the interpolation. It made things slightly worse: BC interpolation
floor 1.81 → 1.98 ΔE00, cross-set Canvas Matte 2.16 → 2.23. A clean negative result: the
interpolation bottleneck is *spatial* (the BC 905-patch chart is sparse/irregular vs MOAB's
~2033 regular lattice — BC floor 1.81 vs MOAB 1.33), not spectral noise. PCA truncation
discards signal, not noise. Kept as opt-in (`MODE_INTERP=pca`); default stays IDW.

**Substrate normalisation (big win, now default).** The first H11 pass compared *raw* spectra,
but H11 is about device response "once paper white + OBA are accounted for" — that step was
missing. Added `MODE_NORM` to `modeCompare.ts`: `oba` removes OBA fluorescence (reuses D7
`extractOBAEmission` + per-patch factor), `device` additionally takes the paper-relative ratio
and re-applies a common reference paper (mean cleaned paper, ratio cap 4), comparing inks as if
printed on the same substrate. Cross-set median ΔE00 dropped sharply (none → device): Canvas
Matte 2.16 → 1.62, Premium Luster 2.28 → 1.75, Premium Glossy 3.36 → 1.88. The residual is now
at/below the BC interpolation floor → **H11 confirmed**: the raw 2–3 ΔE gap was substrate, not
device. `device` is now the default. See `docs/EXPERIMENTS.md` 2026-05-29 row and
`docs/mode-comparison.md`.

**H5 rank test (rejected).** Added `scripts/experiments/h5_rank_distribution.ts` (exports
`jacobiEigen` from `pcaInterp`). Over 461 same-chart pairs, the raw difference `X_B − X_A`
has median effective rank 5 (max 9); only 17.8% of pairs reach rank ≤ 4 at 99% energy →
**H5 rejected**. The substrate-transform difference needs ~5–6 components (paper white + OBA
band + ink-coverage interaction), so D1's rank-≤3 residual under-captures. See
`docs/RESEARCH_HYPOTHESIS.md` H5 Result + `docs/EXPERIMENTS.md`.

Next: local-linear (WLS) spatial interpolant to lower the ~1.8 BC floor; re-run H5 on the
device-normalised difference; try D1 with rank-5 residual.

---

## 2026-05-29 — Retire H1/H2; print-mode taxonomy + cross-vendor comparison plan

Decision (user): withdraw **H1** (CYNSN-based device-substrate separation) and **H2**
(DeviceSpace RGB↔CMYK invariance). Recorded as a dated Retraction section in
`docs/RESEARCH_HYPOTHESIS.md` (past hypotheses are never edited in place). The CYNSN
within-profile track never met its acceptance gate and had already been removed from the
frontend, so its P0 bugs and the DeviceSpace migration epic were moved to a Retired block in
`TODO.md` and the corresponding ROADMAP phases marked RETIRED. The active program is now the
data-driven track (H3–H10, CAE) plus the new **H11**.

Registered **H11 — cross-vendor same-mode device-response equivalence**: two profiles built
for the same Epson media preset (e.g. Canvas Matte) but different papers/vendors should
share device response after paper normalisation. Pre-registered pass: cross-set (BC vs MOAB)
median ΔE00 ≤ 3 on the three overlapping presets and smaller than cross-preset pairings.

Established the canonical print-mode taxonomy from the MOAB "Media Settings" PDF (media
preset = canonical mode). Three presets overlap across the two source sets and are
comparable: **Canvas Matte, Premium Luster, Premium Glossy**. BC-only: Canvas Satin,
Watercolor Radiant White, Enhanced Matte, Singleweight Matte. MOAB-only: Premium Semigloss,
Ultrasmooth Fine Art, Velvet Fine Art. Both charts share the 380–730 nm / 10 nm / 36-band
wavelength grid but differ in RGB sampling (BC 905-patch chart vs MOAB ~2033-patch
12-level lattice), so cross-set comparison requires interpolation onto a common RGB grid.

Implementation (this session): `utils/printMode.ts` canonical-mode mapper (+tests),
physical reorg of `data/profiles/` into per-preset subfolders, recursive profile discovery
in `scripts/exportCaeData.ts`, `lib/interp/rgbInterp.ts` k-NN IDW interpolator (+tests), and
`scripts/experiments/modeCompare.ts` producing `docs/mode-comparison.md` + `EXPERIMENTS.md`
rows.

---

## 2026-05-27 — MOAB ICC CGATS spectra and print-mode CAE grouping

Added the missing MOAB ingestion path: `.icc` uploads now share the existing
ICM parser, and when an ICC does not contain ZXML CxF the parser reads the
`targ` ICC `text` tag and parses its CGATS.17 spectral table. Filename metadata
now records `printMode`, using the final profile-name segment before extension
(`USFA`, `Prem Luster`, `CanvasMatte`, etc.), and the CAE exporter can filter
by `CAE_PRINT_MODE` so training sets can be built from profiles printed in the
same mode instead of mixing unrelated media settings.

Real MOAB verification in
`data/profiles/2023 Epson SureColor P9000 MOAB Profiles` found 17/18 ICC files
with spectral CGATS data. Same-mode spectral correlations are high for the
usable same-chart groups: Prem Luster mean r=0.9978, Prem Semigloss r=0.9979,
USFA mean r=0.9977, VFA r=0.9866 when matched by rounded RGB patches. This
also exposed that some MOAB targets use fractional RGB steps, so same-mode
analysis must align by device coordinates or chart identity, not just assume
all files have identical row counts. See `docs/EXPERIMENTS.md` 2026-05-27 row.

CAE training data alignment was updated for that finding: `python/cae/dataset.py`
no longer filters everything to the legacy 905-patch chart, and instead builds
the common training chart from rounded RGB coordinates across the exported
profiles. `python/cae/train.py` now falls back to a deterministic auto split
when the checked-in split does not match a filtered MOAB payload.

## 2026-05-27 — S4 Lab-saturation anchor experiment

Added an experimental S4 anchor strategy for testing whether a very small
target set can be chosen by colorimetric saturation rather than by RGB ramps.
`frontend/src/lib/sampling/labSaturation.ts` converts spectra to paper-relative
Lab using the shared `colormath` path, sorts candidate patches by chroma, and
keeps hue-separated saturated anchors after paper. `TransferView` now exposes
S4 as "paper + two saturated anchors" and passes those anchors into the existing
A3/D1/B3/C7/CAE predictor flow.

Tests added in `labSaturation.test.ts` cover every exported helper and the S4
picker: chroma, hue, angular distance, row-to-Lab conversion, paper-first
ordering, hue-separation fallback, and invalid input errors. This records the
new hypothesis as experimental UI/runtime support only; no real-profile metric
has been produced yet, so `EXPERIMENTS.md` is unchanged.

---

## 2026-05-25

Fixed dataset filtering to exclude profiles with incorrect number of patches.

- Modified `python/cae/dataset.py` to filter profiles to only those with exactly 905 patches
- Updated `python/cae/split.json` to remove 'BC_AllureAq_P9000_MK_EMP' which had 1550 patches
- Successfully tested training with D7 variant (OBA-cleaned spectra) - completed 2 epochs
- Training now proceeds without KeyError exceptions

This ensures the CAE training only uses profiles with the expected 905-patch chart consistency.

---

## 2026-05-25 — Compared D7 CAE with M0 vs M1 Measurements

Evaluated two D7-CAE variants trained on different measurement conditions:

- **D7-CAE-M0**: Standard M0 measurements (baseline)
- **D7-CAE-M1**: M1 measurements (UV included illumination)

**D7-CAE-M0 Results** (from previous run):

- Median of medians ΔE00: **1.66**
- Median of P95 ΔE00: **4.58**
- Fraction of pairs with median ΔE00 ≤ 1.5: **0.40** (40%)

**D7-CAE-M1 Results** (current run):

- Median of medians ΔE00: **3.12**
- Median of P95 ΔE00: **6.59**
- Fraction of pairs with median ΔE00 ≤ 1.5: **0.00** (0%)

The M0-based D7-CAE substantially outperforms the M1-based version, indicating that:

1. Standard M0 measurements provide better spectral data for substrate transfer modeling
2. M1 measurements (which include UV) introduce noise or complications that degrade CAE performance
3. The OBA preprocessing in D7-CAE is particularly beneficial with M0 data where UV effects can be properly modeled and removed

This validates the choice to use M0 measurements as the standard for the CAE training pipeline.

---

## 2026-05-24 — Phase 8: CAE_RAW — Conditional Autoencoder cross-trained on MK profiles

First neural-network predictor lands as the 5th option in the
TransferView head-to-head. Cross-trained on 70 % of the matte-black (MK)
profile subset (11 train / 5 held-out, seed 42). Goal: separate substrate
factor from print-mode factor so the model generalises across substrates
on the same printer + ink mode.

### New scaffolding

- **`frontend/scripts/exportCaeData.ts`** — TS → JSON exporter for the
  Python training pipeline. Reuses existing `parseIcmFile` (jsdom-polyfilled
  DOMParser). Dumps all 16 MK profiles with paper spectrum + per-patch
  RGB + spectrum. Output `data/cae-input/profiles-mk.json` (~5 MB,
  gitignored). Run: `npx tsx scripts/exportCaeData.ts`.
- **`python/cae/`** (new subtree, gitignored venv + weights):
  - `requirements.txt` — torch ≥ 2.0, numpy.
  - `split.py` — deterministic 11 / 5 split, seed 42, writes `split.json`.
  - `dataset.py` — `ProfileBank` + `CrossSubstrateDataset` yielding
    `(paper_A, R_A, RGB, id_A, paper_B, R_B, id_B)` triplets, optional
    D7 OBA-cleaning at load time.
  - `oba.py` — Python port of `obaSeparator.ts` (quadratic-extrapolation
    extractor + UV-block proxy + subtract/add helpers).
  - `model.py` — `CAEHybrid` PyTorch module:
    `substrate_encoder(paper(36) + onehot_id(12)) → 32 → 8` and
    `spectrum_encoder(R(36) + RGB(3) + sub_lat(8)) → 64 → 16` and decoder
    mirror. Loss = `MSE(R_B_pred, R_B_true) + 0.1 · ‖ink_lat_A − ink_lat_B‖²`
    (substrate-invariance term, decayed to 0.01 after epoch 20).
  - `train.py` — Adam lr 1e-3, batch 256, 30 epochs (early-stop on
    held-out MSE), ID dropout 30 %.
  - `evaluate.py` — full per-pair held-out median + P95 ΔE00 (inline
    spectraToLab + CIEDE2000 ports).
  - `export_weights.py` — `state_dict` → JSON for TS load.

### TS inference + UI

- **`frontend/src/lib/predict/cae.ts` (new)** — pure-TS forward pass
  (matrix multiply + ReLU). Loads `cae_weights_raw.json`. Substrate ID
  comes from `weights.id_table`; unseen profile names map to `null_id`.
  No anchor fine-tune in this version — substrate identity is the paper
  spectrum alone.
- **`frontend/src/data/cae_weights_raw.json`** — committed weights JSON
  (214 KB). Schema documented in `cae.ts`.
- **`frontend/src/components/TransferView.tsx`** —
  - `PredictorKey += 'CAE_RAW'`; ALL renamed to "All predictors".
  - New CAE detail block: cross-train split notice, best held-out MSE
    from weights file, "in train pool / held-out" indicator per
    ref / target, caveat about absent anchor fine-tune.

### Training run results (variant: raw)

- 99,550 training pairs, 18,100 held-out pairs.
- Best held-out reflectance MSE: **0.0009** at epoch 25.
- Per-pair ΔE00 summary: median-of-medians **3.20**, median-of-P95s 8.29,
  **0 % of pairs achieve median ≤ 1.5**.

### Head-to-head observations

| Pair                              | A3   | D1   | B3   | C7   | **CAE_RAW** |
| --------------------------------- | ---- | ---- | ---- | ---- | ----------- |
| DecorMatte → Lyve (both in train) | 1.54 | 1.45 | 2.13 | 1.28 | **1.94**    |
| 600MT → OpticaOne (both held-out) | 0.64 | 0.60 | 0.68 | 0.52 | **2.35**    |

**H10 rejected in current form.** The CAE without anchor fine-tune
consistently loses because A3 / D1 / B3 / C7 each see 13 anchors of
MEASURED target reflectance — the CAE sees only the paper white spectrum.
The model has done what it was trained for (cross-substrate
generalisation, MSE 0.0009 on reflectance), but the task is asymmetric.
Three remediation paths queued (H10b — anchor fine-tune; H10c — D7-CAE
on OBA-cleaned spectra; CAE conditioning on (paper_A, paper_B, R_A, RGB,
anchors)).

Outlier: AllureAq (substrate class "EMP") explodes to 29 ΔE00 — substrate
very different from the rest of the training pool.

Screenshots:

- `docs/experiments/2026-05-24-cae-train-pair-decormatte-lyve.png`
- `docs/experiments/2026-05-24-cae-heldout-pair-600mt-opticaone.png`

### Verification

- `npx tsc --noEmit` → exit 0.
- `npx vitest run` → **91 / 91 passed** (no new TS tests yet).
- `npx vite build` → **411 KB / 161 KB gzip** (was 197 / 63 — weights
  added 214 KB raw, ~70 KB gzipped after minification + tree-shake).
- Python `evaluate.py` ran on 5 held-out targets × every other profile =
  85 directed pairs; full results in
  `python/cae/weights/evaluate_raw.json` (gitignored).

### Next

Stage 2 — train D7-CAE (Python `train.py --variant d7`), commit
`cae_weights_d7.json`, add CAE_D7 to UI. After that: H10b anchor-finetune
revision, AllureAq investigation, batch H4 / H8 / H9 runner.

---

## 2026-05-24 — Substack article draft: data-driven cross-substrate transfer

First publishable summary of Phase 1–7 + UI-cleanup findings. Written for
a colour-science / print-shop audience with mid-level technical depth.
Lives at `docs/article-draft.md`; will be copied to Substack manually
when ready.

### Structure (≈ 3300 words, 10 sections)

1. Hook — IT8.7/4 vs few-patch substrate adaptation.
2. Setup — Epson SC-P9000, 10-channel-as-RGB caveat, 27 profiles.
3. Four predictors — A3, D1, B3, C7 with per-λ math.
4. Three anchor strategies — S1, S2, S3.
5. Two findings — C7 wins at S1; **C7 + S3 neutral (k=5) BEATS C7 + S1
   (k=13)** on DecorMatte ↔ Lyve, median ΔE00 1.06 vs 1.28.
6. OBA detour — R(380) range across substrates, OBA-mismatch table,
   per-ink UV absorption table (Y = strongest UV blocker), S3 cyan
   catastrophic failure mode explained.
7. Fix — D7 analytic OBA separation, 7-step algorithm, before/after
   table (D1 + S3 cyan 2.93 → 2.42).
8. Live numbers — pointer to the running tool + repo links.
9. Limitations — 10-channel printer hides the inks; one-pair anecdote
   pending 702-pair batch; OBA proxy bias; M0/M2 mixing; B3 still
   underperforms.
10. Why this matters — workflow implication: from hours/dollars to
    minutes/cents per new substrate.

Plus references list (ISO 13655, ISO 11664-6, ISO 17972-3, Wyble & Berns
2000, Fairchild 2013, ICC.1:2010) and a companion-data section linking
every quoted number back to its `EXPERIMENTS.md` row.

### Tone + caveats

- Honest framing throughout: "predictions are empirical regressions, not
  physical ink models".
- Single-pair anecdote vs statistical claim called out explicitly in §9.
- All numbers reproducible from a single pair load in the live tool.
- Headline title proposed: _"Predicting Color Across Print Substrates
  with 5 Patches"_; alternative for OBA-centric framing kept as
  comment block.

No code changes in this commit. Pre-commit hook bypassed via the
"docs-only" path (no touches to `lib/` or `components/`).

---

## 2026-05-24 — UI cleanup: drop legacy Compare tab + analyser deps

The "Compare (legacy)" tab and every component / analyser it depended on
were dead in the data-driven track. They were never updated to handle the
RGB-fronted 10-channel printer (we have no algorithm for the driver's
proprietary RGB → 10-ink separation), so any number they produced was
either uninterpretable or misleading. Removed.

New default landing: TransferView with a printer / workflow header banner
that names the device (Epson SureColor SC-P9000) and the caveat in plain
text — predictions are empirical regressions, not physical models.

### Deleted (21 files)

Components:

- `ComparisonView.tsx`, `InkLimitSection.tsx`, `GroupBreakdownTable.tsx`,
  `InkRatioTable.tsx`, `LabScatterPlot.tsx`, `SpectralCurves.tsx`,
  `PatchCorrelationScatter.tsx`, `PredictionAccuracyView.tsx`.

Analysers:

- `linearityAnalyzer{.ts,.test.ts}`, `spectralPredictor.ts`,
  `inkRatioAnalyzer.ts`, `groupAnalyzer.ts`, `limitsAnalyzer.ts`,
  `cynsn{.ts,.test.ts}`, `spreading{.ts,.test.ts}`,
  `optimizer{.ts,.test.ts}`, `index.ts`.

Types (`frontend/src/types/index.ts`):

- `MatchedPatchPair`, `InkRatioResult`, `PatchGroupResult`,
  `PredictionModelType`, `SpectralPredictionModel`,
  `PatchPredictionResult`, `SpectralPredictionEvaluation`,
  `ModelComparisonRow`, `SpectralModelComparison`, `LinearityResult`.

### Modified

- `frontend/src/App.tsx` — drop tab system; sole content = `TransferView`.
  New header banner with printer link + workflow caveat ("we do NOT model
  individual inks — predictions are empirical regressions").
- `frontend/src/store/useProfileStore.ts` — minimal store. Dropped
  `selectedProfiles`, `linearityResult`, `selectProfile`,
  `setSelectedProfiles`, `clearSelection`, `setLinearityResult`,
  `canSelectMore`. Kept: `profiles`, `isLoading`, `error`, `addProfiles`,
  `removeProfile`, `setLoading`, `setError`, `getProfileByName`.
- `frontend/src/components/ProfileList.tsx` — removed checkbox UI;
  read-only list with remove button only. Hint text now says "Use the
  Reference / Target dropdowns on the right to pick a pair."

### Verification

- `npx tsc --noEmit` → exit 0
- `npx vitest run` → **91/91 passed** (was 130; −39 from deleted analyser
  tests).
- `npx vite build` → **197 KB JS / 63 KB gzip** (was 350 KB / 106 KB;
  −44 % bundle).
- Playwright headless: legacy tab count = 0, ALL + S3 neutral + D7 ON
  renders, header banner visible.

Screenshot: `docs/experiments/2026-05-24-app-cleanup-best-case.png`.

---

## 2026-05-24 — Phase 7: D7 OBA-separation wrapper (analytic, no extra anchor)

User-articulated insight ("у нас же есть измерения на 2х подложках"): since
both substrates are fully measured in the research dataset, the OBA
fluorescence component can be extracted analytically from the paper spectra
alone — no extra measurement needed. Wraps any base predictor with a
pre-clean / post-add-back pipeline.

### Algorithm (per knowledge-base §1.5 path 2)

1. **Extract OBA emission per substrate** from paper spectrum:
   - Fit degree-2 polynomial to `R_paper(λ)` over the OBA-free range
     λ ∈ [460, 730] nm.
   - Extrapolate base polynomial back to λ ∈ [380, 450] nm.
   - `OBA_emission(λ) = max(0, R_paper(λ) − base(λ))` in the OBA band.
2. **Per-patch OBA factor** in [0, 1]:
   `factor(patch) = clamp(R_patch(380) / R_paper(380), 0, 1)`. UV-block
   proxy from existing spectra — no additional measurement.
3. **Pre-clean** both ref and target matrices:
   `R_clean = R_measured − factor · emission`.
4. **Run any base predictor** on `(R_clean_A → R_clean_B)`.
5. **Add OBA back** to the prediction:
   `R_pred = R_pred_clean + factor · emission_B`.

### Changes

- **`frontend/src/lib/predict/obaSeparator.ts` (new)**:
  - `extractOBAEmission(paperSpec, options)` — quadratic-extrapolation OBA
    extractor; returns emission per λ, base-coeffs, peak amplitude.
  - `computeOBAFactorPerPatch(X, L, paperIdx)` — UV-block proxy.
  - `subtractOBA / addOBA` — element-wise, [0, 1]-clamped.
  - `runOBASeparatedTransfer({basePredict, ...})` — full wrapper, returns
    standard `PredictionReport` with `variant = "D7_<base>"`.
- **`frontend/src/lib/predict/obaSeparator.test.ts` (+8 tests)**: flat-paper
  zero-emission, Gaussian-bump recovery, non-negative emission, UV-block
  proxy bounds, subtract→add roundtrip, identity-predictor wrapping,
  bump-detection on target paper.
- **`frontend/src/components/TransferView.tsx`**:
  - New "D7 OBA-separate" checkbox (control row expanded 4→5 columns).
  - Inline OBA pre-clean of `X_A`, `X_B`, and the pool matrices when
    enabled (pool gets target's emission as a proxy).
  - Each predictor adapter (A3, D1, B3, C7) detects the toggle and
    post-adds OBA back via `evalWithOBABack` before evaluating.
  - New `OBAExtractionTile` showing per-λ emission (380–460 nm) for ref +
    target with peak amplitude and peak λ.

### First data point (DecorMatte ref → Lyve target)

| Strategy | k   | Predictor | D7 OFF   | D7 ON    | Δ         |
| -------- | --- | --------- | -------- | -------- | --------- |
| S1       | 13  | A3        | 1.54     | 1.50     | −0.04     |
| S1       | 13  | D1        | 1.45     | 1.42     | −0.03     |
| S1       | 13  | B3        | 2.17     | 2.21     | +0.04     |
| S1       | 13  | C7        | 1.28     | 1.30     | +0.02     |
| S3 cyan  | 5   | A3        | 9.31     | 9.23     | −0.08     |
| S3 cyan  | 5   | **D1**    | **2.93** | **2.42** | **−0.51** |
| S3 cyan  | 5   | B3        | 21.28    | 21.69    | +0.41     |
| S3 cyan  | 5   | C7        | 9.28     | 8.88     | −0.40     |

Extracted OBA: A (DecorMatte) peak = 0.106 @ 410 nm; B (Lyve) peak = 0.000
(no OBA, as expected from per-substrate dump).

**Direction-of-OBA matters**: this pair has OBA in the REF only, so the
predicted target naturally has no OBA contribution to add back. The win is
in stripping OBA from the ref so the cross-substrate signal is no longer
contaminated by the 380–410 nm bump. **D1 + S3 cyan benefits most** (−0.51
median ΔE00) because that combination was the catastrophic failure case
in Phase 6 — D7 directly addresses it. B3 slightly degrades because pool
basis was rebuilt with target's (zero) emission proxy for ALL pool, biased
for OBA-rich pool members.

### Verification

- `npx tsc --noEmit` → exit 0
- `npx vitest run` → **130/130 passed** (was 122; +8 obaSeparator)
- `npx vite build` → 350 KB / 106 KB gzip, success
- Playwright headless sweep — 4 configurations (S1/S3cyan × D7 ON/OFF),
  numbers extracted, screenshots captured.

Screenshots:

- `docs/experiments/2026-05-24-d7-s1-on-decormatte-lyve.png`
- `docs/experiments/2026-05-24-d7-s3cyan-on-decormatte-lyve.png`

### Next

(a) Run inverse pair (Lyve→DecorMatte) where target has heavy OBA, to
exercise the "add OBA back" branch; (b) Phase 8 batch runner over many
OBA-disparate pairs for statistical verdict on D7's impact; (c) Improve
per-pool-profile OBA extraction in the B3 path (currently uses target's
emission as global proxy — should use each pool profile's own paper).

---

## 2026-05-24 — Phase 6: C7 per-λ monotone curve + S3 single-channel ramp anchors

User hypothesis: substrate transform `B = f_λ(A)` is a function of A per
wavelength — the same `f_λ` applies to every ink, so anchors from one
channel ramp suffice. This phase implements the machinery to test it.

### C7 predictor

`lib/predict/perLambdaCurve.ts` — for each λ:

1. Take the k anchor (A(λ), B(λ)) pairs.
2. Sort by A, dedup colliding A values (average B).
3. Build a piecewise-linear interpolant.
4. Apply: bracket-linear inside the range, slope-of-edge extrapolation
   outside, clamped to [0, 1].

72 free parameters of A3 → up to k free DOF per λ — captures saturation
curves and OBA non-linearity in a way A3's affine cannot.

### S3 anchor strategy

`lib/sampling/channelRamp.ts` — `pickChannelRampAnchors(profile, {channel,
levels})` picks paper + N nearest patches along one channel:

- C: G=B=255, R varies.
- M: R=B=255, G varies.
- Y: R=G=255, B varies.
- neutral: R=G=B varies.

Levels in 0–255 device-addressing space (255 = no ink). Default
`[192, 128, 64, 0]` → 4 ramp anchors + paper = k=5.

### TransferView wiring

- Predictor dropdown gains C7 option and renames ALL to "4-way".
- Anchor strategy dropdown gains S3 option.
- New S3 control panel (only shown when S3): channel selector + ramp
  levels slider (1–8). Surfaces total k = 1 + levels alongside.

### First data points

DecorMatte ↔ Lyve, both CanvasMatte, OBA mismatch 0.179:

| Strategy              | k   | A3   | D1   | B3    | **C7**   | Winner |
| --------------------- | --- | ---- | ---- | ----- | -------- | ------ |
| S1                    | 13  | 1.54 | 1.45 | 2.17  | **1.28** | C7     |
| S3 neutral (4 levels) | 5   | 1.53 | 1.42 | 27.00 | **1.06** | C7     |
| S3 cyan (4 levels)    | 5   | 9.31 | 2.93 | 21.28 | 9.28     | D1     |

**Two findings:**

1. **C7 beats A3, D1, B3 at the same anchor budget (S1, k=13).**
   The per-λ piecewise curve captures saturation curves the per-λ affine
   misses, with no need for the paper-ratio decomposition D1 uses.

2. **C7 + S3 neutral (k=5) BEATS C7+S1 (k=13).** User hypothesis confirmed
   for neutral ramp. Substrate transform is shared across inks when the
   anchor ramp visits all reflectance levels at every λ. 5 anchors get a
   median ΔE00 of 1.06 — better than 13 anchors anywhere else.

3. **OBA caveat (user reminder).** C7 + S3 cyan (k=5) explodes to median
   9.28. Cyan is transparent at 380–410 nm → cyan ramp does not vary
   A(λ) there → per-λ curve undetermined at OBA bands → catastrophic
   extrapolation. S3 single-channel ramps only work when the channel
   absorbs across the full λ range. Neutral does; cyan doesn't.

H9 added to `docs/RESEARCH_HYPOTHESIS.md`. Empirical confirmation on this
pair + caveat. Phase 7 batch runner needed for definitive verdict.

Screenshots:

- `docs/experiments/2026-05-24-c7-s1-decormatte-lyve.png`
- `docs/experiments/2026-05-24-c7-s3-neutral-k5-decormatte-lyve.png`
- `docs/experiments/2026-05-24-c7-s3-cyan-FAIL-decormatte-lyve.png`

### Tests (+11)

- `perLambdaCurve.test.ts` (+6): anchor recovery, dedup, [0,1] clamp,
  degenerate dedup → constant offset, error guards, end-to-end synthetic
  monotone-non-affine transform.
- `channelRamp.test.ts` (+5): C/M/Y/neutral ramp picks, custom levels,
  nearest-fallback, no-duplicate guarantee, CMYK rejection.

### Verification

- `npx tsc --noEmit` → exit 0
- `npx vitest run` → **122/122 passed** (was 110; +11)
- `npx vite build` → 344 KB / 104 KB gzip, success
- Playwright: 3 head-to-head screenshots captured against real P9000 data,
  numbers extracted and recorded above.

### Next

Phase 7 — H9/H4/H8 batch runner over all 702 directed pairs (or a sampled
subset) to produce distributions for the hypothesis tests. Open question:
add a "blue boost" patch to S3 cyan/magenta/yellow ramps to ground the
OBA bands, or just ship S3 with a UI warning when a non-neutral channel
is chosen.

---

## 2026-05-24 — Phase 5: S2 greedy adaptive anchor selection

User-facing answer to "what is the minimum k for this ΔE budget?".

Greedy loop on top of any of the existing predictors (A3 / D1 / B3):

1. Start from S1 seed (13 forced anchors).
2. Run predictor → inspect report.
3. If `medianDE00 ≤ targetMedianDE` — stop (converged).
4. Else add `report.worstPatchSampleIds[0]` (skipping rows already in anchors)
   to the anchor set, refit, loop until `maxK` is hit.

The predictor is treated as a pure callback `(anchorIdx) → PredictionReport`,
so the same machinery wraps every variant. B3's pool basis is built once
before the loop (heavy SVD) and reused.

### Changes

- **`frontend/src/lib/sampling/greedy.ts` (new)** — `runGreedyActiveAnchors`
  with `GreedyPredictor`, `GreedyOptions`, `GreedyStep`, `GreedyResult`
  types. Trajectory + per-iter step record + converged flag + onIteration
  callback for live UI updates.
- **`frontend/src/lib/sampling/greedy.test.ts` (+5 tests)** — converge-at-iter-0
  when seed already passes, monotone-improving trajectory, maxK cap with
  `converged=false`, worst-patch already-anchor skip, error guards.
- **`frontend/src/components/TransferView.tsx`** —
  - New "Anchor strategy" dropdown: `S1 forced (13)` vs `S2 greedy adaptive`.
  - S2 control panel (only shown when S2 selected): ΔE target slider
    (0.5 → 5.0, step 0.1) + max anchors slider (15 → 80, step 1).
  - Predictor blocks now show an S2 trajectory card when S2 is active:
    converged flag, iteration count, final k, per-iter median ΔE00
    trajectory string, list of added rows.
  - Internal refactor: each variant exposed as a `dispatch(v, anchorIdx)`
    closure so S2 can call it repeatedly. B3 pool basis built outside
    the per-variant loop and reused across iterations.

### First data point (EXPERIMENTS row)

DecorMatte (ref) vs Lyve (target), both CanvasMatte, D1 + S2, target
0.8 ΔE00, max k = 40:

- Seed k=13: median 1.45
- After 28 iterations (k=40): median **1.33**, P95 3.09, R² 0.941
- Did NOT converge to 0.8 — hit k cap

**Empirical floor for D1 on this pair ≈ 1.33 ΔE00 even at k=40.**
Trajectory non-monotone (greedy occasionally adds a patch that worsens
median locally). P95 dropped 5.36 → 3.09 (43% reduction): the real win
of going k=13 → k=40 is outlier safety, not median improvement.

Screenshot: `docs/experiments/2026-05-24-s2-greedy-d1-decormatte-lyve.png`.

### Verification

- `npx tsc --noEmit` → exit 0
- `npx vitest run` → **110/110 passed** (was 105; +5 greedy)
- `npx vite build` → 339 KB / 102 KB gzip, success
- Playwright headless: S2 dropdown selects, slider changes value (via
  native input setter for React), greedy iterations visible in trajectory
  card, ANCHORS k counter jumps from 13 to 40.

### Next

Phase 7 — H4/H7/H8 batch runner over all 702 directed pairs. With S2
shipped we can now ask "what's the median minimum-k distribution across
all substrates?" Will produce a JSON artefact + summary row in
`EXPERIMENTS.md`.

---

## 2026-05-24 — Phase 4: B3 pool-PCA predictor + 3-way head-to-head

Third predictor (B3) lands. Uses a PCA basis built from the _pool_ of all
loaded substrate profiles (target auto-excluded), projects both reference
and target anchor spectra into that basis, then fits a per-PC diagonal
affine mapping on the anchors. The mapping is applied to all reference
scores → reconstruct → predicted target spectra.

Why this design: a single substrate spans a low-D manifold in spectral
space, and pooling many substrates surfaces the _common_ axes of substrate
variation (OBA loading, ink-paper optical mixing, surface scatter). A new
substrate is approximately a point on the same manifold; the diagonal map
absorbs the per-PC scaling and offset.

### Design pivot during implementation

First cut used pure RGB-kNN-interpolation of anchor scores (no reference
profile). Empirical result on DecorMatte ↔ Lyve: median ΔE00 = 12.6,
R² = −0.806 — catastrophic. Diagnosis: 13 sparse RGB anchors cannot
interpolate the score field across 905 patches. Switched to ref-driven
diagonal mapping (the original "B3" from the plan, not the RGB-only
variant). Documented as a header comment in `poolPCATransfer.ts`.

### Changes

- **`frontend/src/lib/predict/poolPCATransfer.ts` (new)** — final design:
  - `fitPoolBasis({matrices, rowCounts, L, p})` — wraps `fitPoolPCA` with
    a default rank of 6.
  - `runPoolPCATransfer({basis, X_ref, X_target, sampleIds, anchorIdx, …})`
    — extract anchor spectra → project ref + target into pool basis → fit
    per-PC diagonal `Z_B[c] ≈ s[c]·Z_A[c] + b[c]` → apply to all ref
    scores → reconstruct → clamp [0,1] → evaluate on non-anchor patches.
  - Reports per-PC slope, intercept, and R² for diagnostics.
- **`frontend/src/lib/predict/poolPCATransfer.test.ts` (+3 tests)** —
  pool basis construction, end-to-end synthetic ref+target reconstruction
  via diagonal mapping, error guards.
- **`frontend/src/components/TransferView.tsx`** —
  - Predictor dropdown gains "ALL (3-way)" and "B3" options.
  - "B3 basis rank" selector (3 / 4 / 6 / 8 / 12).
  - Pool size computed from `profiles` array, excluding the chosen target.
  - B3 detail block: pool size + basis rank + honest caveat that pool size
    < 5 degrades B3 to noise.
  - Head-to-head winner logic generalised to N predictors (sorts by
    median ΔE00, reports winner + margin over runner-up).

### First data point (EXPERIMENTS row)

DecorMatte (ref, no OBA) vs Lyve (target, OBA-loaded), both CanvasMatte,
7-profile pool (8 loaded, target excluded).

| Predictor   | median ΔE00 | P95      | R²        | RMS        |
| ----------- | ----------- | -------- | --------- | ---------- |
| A3          | 1.54        | 5.94     | 0.428     | 0.0210     |
| **D1**      | **1.45**    | **5.36** | **0.846** | **0.0166** |
| B3 (rank 6) | 2.17        | 14.56    | −0.165    | 0.0292     |

**Honest finding:** B3 with diagonal score mapping underperforms both A3
and D1 on this pair. P95 = 14.56 reveals catastrophic outliers on a few
patches (likely saturated ink loads where the 7-profile pool basis under-
represents the ink-stacking direction). Three remediation paths queued:
larger pool (all 27 profiles), full M score mapping (B2 variant, 6× param
cost), or pool-PCA + per-pair residual hybrid.

Screenshot:
`docs/experiments/2026-05-24-3way-b3-decormatte-lyve.png`.

### Verification

- `npx tsc --noEmit` → exit 0
- `npx vitest run` → **105/105 passed** (was 102; +3 from poolPCATransfer)
- `npx vite build` → 335 KB / 102 KB gzip, success
- Playwright headless: 3-way head-to-head visible; B3 row populated; winner
  callout shows "D1 by 0.09 over A3".

### Next

H6/H7 batch tests will rerun B3 across all 702 directed pairs to see if
the median-wins-over-A3 hypothesis still holds despite this single bad
data point. Phase 5 (S2 greedy adaptive anchors) likely earns more user
value than fighting B3 further.

---

## 2026-05-23 — Phase 3.5: OBA-aware D1 (ratio clamp + UI mismatch tile)

User observation triggered this commit: the spectral difference between
substrates in 380–390 nm is dominated by optical brighteners (OBA / FWA),
not by ink-paper optics. Empirical dump (commit 1e73dc6, second EXPERIMENTS
row) confirmed: R_paper(380 nm) ranges 0.117 → 0.819 across 8 sampled
substrates — a **7× spread**. Substrate-class name does NOT predict OBA
content (DecorMatte 0.117 and Lyve 0.663 are both CanvasMatte).

D1's `r(λ) = B_paper / A_paper` predictor blows up at those bands without
protection. A3's per-λ affine handles the linear part but cannot model the
non-linear OBA-vs-ink-coverage interaction.

### Changes

- **`frontend/src/lib/predict/oba.ts` (new)** — `detectOBA(spectrum)` returns
  `{ score = R(440)/R(550), r380, r440, r550, hasOBA }`. `obaMismatch(a, b)`
  is symmetric, non-negative. `obaMismatchSeverity` buckets into
  low / moderate / high at 0.05 / 0.15 thresholds.
- **`frontend/src/lib/predict/oba.test.ts` (+6 tests)** — flat spectrum
  score ≈ 1; synthetic 440 nm bump score > 1.1; bounds checks; symmetry;
  severity buckets.
- **`frontend/src/lib/predict/paperRatioResidual.ts`** — finalised the
  ratio clamp. New options field `ratioClamp: [number, number]` default
  `[0.3, 3.0]`. Fit now records `r` (clamped), `rUnclamped` (raw),
  `clampedBands: Int32Array` (indices where clamp fired), `clamp` (bounds
  used). Plumbed through `applyPaperRatioResidual` and
  `runPaperRatioResidualTransfer`.
- **`frontend/src/lib/predict/paperRatioResidual.test.ts` (+2 tests)** —
  no clamp in normal range; clamp activates at extreme ratios and bands
  list matches; custom `ratioClamp` honoured.
- **`frontend/src/components/TransferView.tsx`** —
  - Profile dropdowns now show `(OBA x.xx)` suffix per profile.
  - New `OBAMismatchTile` above head-to-head: shows mismatch score with
    red/yellow/green severity colouring; per-band table for ref + target
    (R(380), R(440), R(550), score); short advisory text matching severity.
  - D1 detail block now shows `clamped bands: N/36` when the ratio clamp
    fired, with explanatory text.
- **`frontend/src/App.tsx`** — kept the dev-only `window.__store =
useProfileStore` line that landed during OBA dump investigation. Used
  by Playwright introspection to extract paper spectra for analysis.

### Hypothesis added

- **H8** in `docs/RESEARCH_HYPOTHESIS.md`: for OBA-mismatched pairs
  (`oba_mismatch ≥ 0.10`), D1 with default clamp beats A3 in median ΔE00
  on ≥ 60 % of pairs. Falsifiable via Phase 7 batch runner.

### First data point (EXPERIMENTS row)

DecorMatte (no OBA, R(380) = 0.117, score = 1.195) vs Lyve (OBA-loaded,
R(380) = 0.663, score = 1.017) — both CanvasMatte, OBA mismatch 0.179.

| Predictor          | median ΔE00 | P95 ΔE00 | R²        | RMS        |
| ------------------ | ----------- | -------- | --------- | ---------- |
| A3                 | 1.54        | 5.94     | 0.428     | 0.0210     |
| D1 (rank 2, clamp) | **1.45**    | **5.36** | **0.846** | **0.0166** |

D1 wins by 0.09 ΔE00 and 2× higher R². **Meets H4 target (≤ 1.5);** A3
misses by 0.04. Clamp fired on 2/36 bands (380, 390 nm — raw ratios 5.67×,
4.82× clamped to 3.0×). Screenshot:
`docs/experiments/2026-05-23-oba-mismatch-decormatte-lyve.png`.

### Verification

- `npx tsc --noEmit` → exit 0
- `npx vitest run` → **102/102 passed** (was 93; +6 oba + 2 clamp + 1
  TransferView wiring)
- `npx vite build` → 331 KB / 101 KB gzip, success
- Playwright headless: OBA mismatch tile renders red (0.179 high),
  clamped-bands count visible in D1 block, A3 vs D1 head-to-head shows
  D1 winning by 0.09 ΔE00 on the first OBA-disparate pair.

### Next

Phase 4 — B3 pool-PCA predictor (basis from all 27 profiles, expected to
help on OBA-disparate pairs because OBA pattern is shared across many
substrates in the pool). Phase 5 — S2 greedy adaptive anchor selection.
Phase 7 — H4/H8 batch runner over all 702 directed pairs.

---

## 2026-05-23 — Phase 3: D1 paper-ratio + PCA residual + head-to-head TransferView

Phase 3 lands the second predictor (D1) and a head-to-head comparison mode so
A3 baseline and D1 can be evaluated side-by-side on the same anchor set.

D1 design:

- First-order: `B̂₁(λ, RGB) = r(λ) · A(λ, RGB)` with `r(λ) = B_paper / A_paper`
  (zero-division guard at 1e-3). Costs ONE anchor (paper).
- Second-order: PCA on residuals at the k-1 non-paper anchors, default rank 2.
  Per-RGB residual interpolated to all patches via inverse-distance-weighted
  kNN (K = 4) in device-RGB space.
- Final: `B̂ = B̂₁ + ε̂`, clamped to [0, 1].
- Degenerate paths: k = 1 → first-order only (graceful baseline); k = 2 →
  rank-1 trivial basis built from the single residual direction; k ≥ 3 → full
  PCA on residuals.

Changes in this commit:

- **`frontend/src/lib/predict/paperRatioResidual.ts` (new)** —
  `fitPaperRatioResidual`, `applyPaperRatioResidual`,
  `runPaperRatioResidualTransfer`. Reuses `dataset/basis.ts` for PCA.
- **`frontend/src/lib/predict/paperRatioResidual.test.ts` (+4 tests)** —
  paper-only k=1 path, pure-multiplicative recovery, k=2 degenerate basis,
  end-to-end run on non-multiplicative synthetic data.
- **`frontend/src/components/TransferView.tsx` (rewrite)** —
  - Predictor dropdown: `A3 vs D1 (head-to-head)` (default), `A3 only`, `D1 only`.
  - D1 residual rank selector (1 / 2 / 3 / 4).
  - Anchor strategy displayed as fixed text (only S1 for now).
  - Head-to-head table when both run: per-predictor median/P95 ΔE00, R², RMS,
    k. Bottom-line "Winner on median ΔE00" callout.
  - Per-predictor detail blocks: metric tiles, worst-5 patches, per-λ R²
    strip (A3 only), residual-rank annotation (D1 only).
  - Internal type narrowing via discriminated union (`{kind: 'ok' | 'error'}`)
    to keep tsc strict-mode happy.

First real-data observation (BC_17MGloss vs BC_17MSatin, both pk on
CanvasSatin):

- A3: median ΔE00 = 0.50, P95 = 1.71, R² = 0.967
- D1 (rank 2): median ΔE00 = 0.65, P95 = 2.08, R² = 0.965
- A3 wins because this pair is almost pure multiplicative substrate (same
  base, different finish). D1's residual stage overfits without adding value.
  Expect D1 to win on substrate pairs with strong non-linear deviation
  (different paper class, different OBA content, etc.).

Tests (+4): paperRatioResidual.test.ts. Phase 3 total: 93 → 93 (PCA test
file path is paperRatioResidual.test.ts; counts include all prior tests).

Verification (Node 22 via nvm; CI on Node 20):

- `npx tsc --noEmit` → exit 0
- `npx vitest run` → 93/93 passed
- `npx vite build` → 327 KB / 100 KB gzip, success
- Playwright headless verification on real data — screenshot captured;
  metrics + head-to-head + per-predictor blocks all populated.

Next: Phase 4 — Pool-PCA basis predictor (B3) so the 27-profile pool is
exploited; Phase 5 — greedy active anchor selection (S2) so the user can
see the minimum k for a chosen ΔE00 budget. The OBA observation (see
follow-up commit) will need an OBA-aware predictor variant or a per-λ
ratio cap to prevent D1 from blowing up on UV-bright substrate mismatches.

---

## 2026-05-23 — Standing permission: Playwright + screenshots (CLAUDE.md §7.1)

Added `CLAUDE.md` §7.1 — the agent is now expected to start the dev server,
drive it with Playwright (headless by default), and capture screenshots
without asking permission after every non-trivial frontend change. First
applied while diagnosing the Phase 2 `TransferView` panel: a screenshot
proved the new tab was rendering and that the empty-state message was the
expected behaviour when no profiles are loaded. A follow-up screenshot with
two real P9000 ICMs loaded showed populated metrics (median ΔE00 = 0.50,
P95 = 1.71, k = 13 anchors out of 905 shared SAMPLE_IDs) — A3 baseline
clearly meets the H4 acceptance bound on this pair.

Workflow + scope documented in `CLAUDE.md` §7.1.

---

## 2026-05-23 — Phase 2: A3 per-λ affine predictor + S1 heuristic anchors + TransferView UI

Phase 1 was infra-only — no visible output. This phase lands the first predictor end
to end so the user can pick two profiles in the UI and see actual ΔE00 numbers.

Why A3 first: trivial (closed-form OLS, 72 free parameters), no surprises, gives a
baseline that D1 (paper-ratio + PCA residual) and B3 (pool-PCA) must justify their
complexity against. Why S1 first: deterministic, no hidden hyperparameters, picks
the patches every reasonable transfer model needs (paper + 8 RGB corners + 5
neutrals = 13 anchors).

Changes in this commit:

- **`frontend/src/lib/sampling/heuristic.ts` (new)** — `pickHeuristicAnchors`
  picks the nearest measured patch to each of: paper (255,255,255), 6 RGB
  primaries, black, and N evenly spaced neutrals. Returns an `AnchorSet` with
  row indices in `meta.chosenIdx` for downstream predictor consumption.
- **`frontend/src/lib/predict/perLambdaAffine.ts` (new)** —
  - `fitPerLambdaAffine(X_A_anchors, X_B_anchors, L)`: closed-form OLS per λ
    yielding `(a, b)`. Fallback to `a=1, b=mean(B)-mean(A)` when variance at a
    wavelength is degenerate.
  - `applyPerLambdaAffine(X_A, L, fit)`: apply with [0,1] clamp.
  - `runPerLambdaAffineTransfer(input)`: end-to-end Task-2 run. Extracts anchor
    rows, fits, predicts every patch, evaluates on non-anchor patches.
  - `paperWPFromBrightestPatch(X, N, L)`: helper to derive paper-relative XYZ
    when no exact paper anchor exists.
- **`frontend/src/components/TransferView.tsx` (new)** — Phase 2 UI hub.
  Dropdowns for ref + target profile. Metric tiles: median ΔE00 (colour-coded
  green/yellow/red), P95 ΔE00, mean spectral R², mean RMS, anchor count,
  held-out patch count, shared SAMPLE_IDs. Worst-5 patches by ΔE00. Anchor list
  with labels (paper, red, …, neutral_0, …). Per-λ R² strip showing where the
  affine fit is tight vs loose.
- **`frontend/src/App.tsx`** — new tab strip above the main pane: "Compare
  (legacy)" → existing `ComparisonView`; "Transfer (Phase 2 — A3 + S1)" → new
  `TransferView`. Selection persists across tab switches.

Tests (+9, all pass):

- `heuristic.test.ts`: 4 tests — exact corners present, nearest fallback,
  neutralCount option, CMYK rejection.
- `perLambdaAffine.test.ts`: 5 tests — exact recovery of known (a, b),
  degenerate-wavelength fallback, shape guards, [0,1] clamp, end-to-end
  identity-affine transfer reports low ΔE00.

Verification (Node 22 via nvm; CI uses Node 20):

- `npx tsc --noEmit` → exit 0.
- `npx vitest run` → **89/89 passed** (was 80/80 pre-Phase 2; +9 new).
- `npx vite build` → 317 KB / 97 KB gzip, success.

How to see the result: `npm run dev` in `frontend/`, drag-drop two ICM
profiles (different substrates, same printer/mode), switch to the "Transfer"
tab, pick reference and target. The report card populates as soon as both are
chosen. No "Run" button — the prediction is cheap enough to recompute on every
selection change.

Honest framing in the UI: the panel header explicitly says "predictor: per-λ
affine, anchor strategy: forced heuristic" so the user knows this is empirical
regression, not physics. Subsequent phases (D1, B3) will compete on the same
panel.

Next: Phase 3 — D1 paper-ratio + PCA residual predictor (expected best
performance at small k); add predictor dropdown to the panel so A3 / D1 / B3
can be compared head-to-head.

---

## 2026-05-23 — Phase 1: data-driven track shared infrastructure

Strategic pivot from physics-faithful CYNSN to data-driven profile compression and
cross-substrate transfer (plan: `/home/mikz/.claude/plans/64c2df34-whitepoint-rgb-cmy-bug.md`).
This commit lands the shared infra used by every predictor and anchor-selection
method in subsequent phases. No predictors yet — that lands in Phase 2 onward.

Why now: the previous CYNSN track was physics-incorrect for the actual dataset
(Epson P9000 is a 10-channel printer hiding behind an RGB ICC), and the architecture
had drifted from any falsifiable hypothesis. Resetting to a data-driven track keeps
the parser + UI shell + colour math (the parts that work) and rebuilds the analytic
layer on honest assumptions: empirical regression on RGB → R(λ) with explicit
acknowledgement that primaries/n/spreading from the old CYNSN had no physical
meaning on this dataset.

Changes in this commit:

- **`frontend/src/types/index.ts`** — add `WhitePointXYZ`, `SaturationLimits`,
  `AnchorSet`, `PredictionReport` types. These are the contract between every
  predictor and the evaluation harness.
- **`frontend/src/lib/colormath.ts`** — add optional `wp` argument to `xyzToLab` and
  `spectraToLab`. Default = `D50_PERFECT_WHITE` (matches historic behaviour, no
  regression). Passing a substrate-derived white point yields paper-relative Lab
  where the substrate's paper anchor sits at (100, 0, 0).
- **`frontend/src/lib/dataset/matrix.ts` (new)** — `loadProfileMatrix` builds N×L
  spectral and N×{3,4} device matrices in stable SAMPLE_ID order so cross-profile
  joins by `Row:Col:Page` are deterministic. `alignByCommonSampleIds` does the
  join itself and returns index arrays for the shared subset.
- **`frontend/src/lib/dataset/split.ts` (new)** — `splitCalTest` with `kfold`,
  `random`, and `fixed` modes. Deterministic Mulberry32 PRNG under a seed so
  experiment runs are reproducible across sessions.
- **`frontend/src/lib/dataset/evaluate.ts` (new)** — `evaluatePrediction` consumes a
  predicted vs measured spectral matrix and returns the canonical `PredictionReport`:
  median + P95 ΔE00 (paper-relative WP), mean spectral R², mean RMS, five worst
  patches by ΔE00.
- **`frontend/src/lib/dataset/basis.ts` (new)** — minimal PCA: Jacobi
  eigendecomposition on an L×L covariance matrix (L = 36, plenty fast in pure TS),
  `fitPCA`/`pcaProject`/`pcaReconstruct`/`varianceExplained`. `fitPoolPCA`
  concatenates per-profile matrices for hypothesis H6 (pool basis vs ref-only basis).
- **Pre-existing optimiser flakiness fix (cherry-picked from your uncommitted work)** —
  `nelderMead` now requires BOTH ftol AND xtol to fire before declaring convergence.
  The previous behaviour returned the moment one of the two thresholds was hit,
  which caused the 1D quadratic test to stop at x ≈ 0.3 instead of converging to 0.
  The rest of your in-progress analyser/component work remains stashed under
  `stash@{1}` for separate review.
- **New hypothesis statements: H3, H4, H5, H6** in `docs/RESEARCH_HYPOTHESIS.md`,
  each with falsifiable acceptance/reject criteria and a pointer to the experiment
  script that will test it.
- **New tests:** 4 in `dataset/matrix.test.ts`, 7 in `dataset/split.test.ts`,
  3 in `dataset/evaluate.test.ts`, 6 in `dataset/basis.test.ts`, 3 in
  `colormath.wp.test.ts`. Total: 23 new tests covering every Phase 1 module.

Verification (Node 22 via nvm; CI uses Node 20):

- `npx tsc --noEmit` → exit 0.
- `npx vitest run` → **80/80 passed** (was 57/57 pre-Phase 1; +23 from new tests).
- `npx vite build` → 304 KB / 93 KB gzip, success.

Next: Phase 2 — A3 per-λ affine predictor + S1 heuristic anchor strategy + minimal
`TransferView` UI panel. Will compose entirely from the modules landed in this commit.

---

## 2026-05-23 — DeviceSpace abstraction (foundation) + tsc cleanup

Two parallel chunks of code work shipped together because the tsc fixes are
needed for the build to be green at all — DeviceSpace touches the same files
indirectly through `types/index.ts`.

### DeviceSpace abstraction (foundation slice)

The codebase had two competing conventions for device-side colorants: legacy
`CMYK_*` fields (used by `linearityAnalyzer` and the old icmParser synthetic
path) and direct `RGB_R/G/B` access (used by everything currently producing
results on the real RGB dataset). Future CMYK datasets cannot be processed
without a rewrite under either convention. Step 1 of the migration:

- **`types/index.ts`** — introduce `DeviceSpace = 'rgb' | 'cmyk'`,
  `DeviceValue = { space, values }`, and a new optional `device?: DeviceValue`
  field on `Measurement`. Add helpers `toCMY()` (RGB inversion / CMYK→CMY with
  K composited multiplicatively), `toCMYK()`, and `deriveDevice()` to build
  `device` from legacy fields for transitional code paths.
- **`parsers/cxfParser.ts`, `parsers/icmParser.ts`** — populate `device`
  alongside the existing `RGB_*`/`CMYK_*` fields. No analysers consume it yet;
  per-analyser port is queued under TODO.md P1 epic.

Legacy `RGB_*` / `CMYK_*` fields remain populated so existing analysers keep
working. They will be removed once every analyser has been ported.

### Duplicate removal

- **Deleted** `frontend/src/lib/cxFParser.ts` (137 LOC) — a vestigial
  text-format CxF/X3 `@data` parser referenced only by its own test. The real
  CxF3 path goes through `lib/iccTagScanner.ts` + `lib/parsers/cxfParser.ts`.
- **Deleted** `frontend/src/utils/cxfParser.test.ts` — the only consumer of
  the file above.

### tsc cleanup (pre-existing errors, not introduced by this session)

`npx tsc --noEmit` was failing on `main` before this session. Verified the
errors were not introduced by the DeviceSpace edits, then cleaned them up:

- **`types/index.ts`** — `PatchGroupResult` gained the fields the analyser
  was already producing and the table was already reading: `pearson_r`,
  `r_squared_L`, `slope_L`, `intercept_L`. These were referenced from
  `groupAnalyzer.ts` and `GroupBreakdownTable.tsx` / `ComparisonView.tsx`
  but absent from the interface.
- **`lib/iccTagScanner.ts`** — drop broken `import type … from './types'`
  (no such module; the types are defined inline).
- **`src/global.d.ts`** — minimal ambient declaration for `pako` (avoids the
  `@types/pako` dev dep for just `inflate`).
- **`.gitignore`** — strip stray markdown fence (lines 1, 56 were literal
  triple-backtick); add `!frontend/src/**/*.d.ts` exception so hand-written
  ambient declarations are tracked; add `.kilo/` alongside `.specify/` and
  `.lingma/`.
- **`spectralPredictor.ts`** — drop unused `PredictionModelType` import and
  unused `n` local.
- **`InkRatioTable.tsx`, `PredictionAccuracyView.tsx`** — drop unused
  destructured props (`refLabel`, `targetLabel`).

Verification: `npx tsc --noEmit` exits 0; `npx vitest run` → 57/57 passed;
`npx vite build` → success.

---

## 2026-05-23 — DDD enforcement: pre-commit hook

Wire the DDD loop into git. Without a hook, future commits will drift back to "I'll
document it later" — the project's prior state, which produced the audit findings in the
previous entry.

- **`.githooks/pre-commit` (new)** — fails when `git diff --cached` touches
  `frontend/src/lib/` or `frontend/src/components/` without a matching change to
  `docs/progress-log.md`. Bypass with `--no-verify` only for trivial fixes (typos,
  comments, dead code) — and then log it in the following commit.
- **`frontend/scripts/install-hooks.sh` (new)** — idempotent `chmod +x .githooks/* &&
git config core.hooksPath .githooks`. Safe to re-run; skips silently outside a git
  work tree (e.g. tarball install).
- **`frontend/package.json`** — `postinstall` script runs the installer so every
  `npm install` keeps the hook active. Guarded with `|| true` so a missing repo does
  not fail the install.

Rationale for raw `.githooks/` vs husky: zero new dependencies, one shell file in the
repo, identical onboarding (`npm install`). Husky's added value (auto-wiring of
`core.hooksPath` from `node_modules`) is exactly what `install-hooks.sh` does in a
fraction of the lines.

Verification: `git config core.hooksPath` returns `.githooks` after `npm install`.
Commit 2 of today's session (this commit) passed the gate because it updates
`progress-log.md`.

---

## 2026-05-23 — Documentation revision (DDD foundation)

Project-wide doc audit and reset. Reasons: documentation had drifted significantly from
the code (CMYK language in `README.md` / `IMPLEMENTATION.md` / `RESEARCH_HYPOTHESIS.md`
while the dataset is RGB-only; `progress-log.md` stopped at 2026-05-21 even though four
substantive commits landed after; `EXPERIMENTS.md` was a template with a single ad-hoc
row; `TODO.md` referenced Node v12 blockage that no longer applies). Several aliased AI
scaffolding folders (`.specify/`, `.kilo/`, `.lingma/`) were dead weight.

Changes in this commit:

- **`CLAUDE.md` (new)** — operating manual: DDD loop, hard rules, file map,
  architecture map, environment caveats, anti-patterns.
- **`docs/ONTOLOGY.md` (new)** — entity model + mermaid diagram, glossary, conventions
  (D50/2°, ΔE00, wavelength grid, device-vs-colorimetric RGB distinction). Establishes
  **spectra as primary measurement, Lab as derived/informational** — all hypothesis tests
  must rest on spectral or XYZ-linear quantities.
- **`docs/SATA_DICTIONARY.md` → `docs/DATA_DICTIONARY.md`** — typo fix + content rewrite
  emphasising spectral primacy.
- **All docs translated to English** and updated to reflect current code state (RGB only,
  CYNSN Phase 2, CYNSN-2 known bugs, DeviceSpace migration target).
- **`docs/AGENTS.md` rewritten** for concrete Claude Code subagents and skills,
  replacing the abstract 6-roles version.
- **`docs/EXPERIMENTS.md` backfilled** with the four experiments embedded in commits
  since 2026-05-21 (ink-limit Yule-Nielsen bug, primary-extraction collapse, CYNSN-2
  measured-grid override, colormath exponentiation fix).
- **`docs/progress-log.md` backfilled** with entries for all twelve commits since
  `a5a03c7`.
- **`docs/ROADMAP.md`** restructured into phases with measurable acceptance criteria and
  a cross-cutting epics section.
- **`docs/RESEARCH_HYPOTHESIS.md`** rewritten as pre-registered, falsifiable H1 with
  sub-hypotheses, acceptance criteria, falsification criteria, dataset slice. Added H2
  (DeviceSpace invariance) as the engineering gate for future CMYK datasets.
- **`docs/structure.md`** updated to reflect the actual tree (added `.githooks/`,
  `scripts/`, `ONTOLOGY.md`, removed stale `hooks/` reference).
- **`docs/workflow.md`** expanded into the full DDD loop with the after-run checklist.
- **`docs/SKILLS.md`** deduplicated (the file had a doubled "CxF specifications" block).
- **`docs/PROMPTS.md`** replaced CMYK-era prompts with CYNSN baseline / cross-substrate /
  diagnostic / VAE templates that match current code.
- **`docs/Tech.md`** version-aligned with `frontend/package.json`; removed `math.js` /
  `simple-statistics` claims (not in deps).
- **`README.md`** rewritten to reflect ZXML/CxF reality (was claiming A2B-table parsing).
- **`AGENTS.md`** (root) updated with the DDD gate clause and the "what done means" list.
- **`TODO.md`** restructured into P0 (CYNSN bugs) / P1 (DeviceSpace epic, cleaning
  pipeline) / P2 (engineering) / P3 (transfer model, docs). Removed stale Node v12 item.
- **`.specify/`, `.kilo/`, `.lingma/` deleted** — unused AI scaffolding leftovers from
  Spec-Kit / Kilo Code / Lingma. None referenced by the project.

No code touched in this commit. Hook wiring and DeviceSpace refactor follow in separate
commits.

---

## 2026-05-21 — `fix(cynsn): primary extraction collapse + CYNSN-2 measured grid` (f8cb1e8)

Two bugs fixed in CYNSN:

1. **Primary-extraction collapse.** `extractNeugebauerPrimaries3` was collapsing onto a
   single vertex when the KNN tolerance was too tight. Loosened tolerance handling and
   added IDW fallback so all 8 corners always receive a spectrum.
2. **CYNSN-2 measured-grid override.** Added the post-training swap that replaces grid
   nodes near measured patches (tol 0.08) with the measured spectra. **Caveat:** the
   training loop still ignores `grid_cynsn2` during loss evaluation — `spreading` ends
   up tuned for the wrong grid. Documented as Bug 2 in `docs/cynsn-pipeline.md`. Fix
   queued in `TODO.md`.

## 2026-05-21 — `fix: colormath exponentiation parse error; add tests + CI` (a2ea011)

`xyzToLab` body contained `-x/25**2` which parses as `-(x / (25**2))` not `-((x/25)**2)`
under standard precedence. Resulted in incorrect L\* in a narrow range. Fixed to
`-(((x/25)**2))`. Added `lib/colormath.test.ts` with ISO 11664-6 reference pairs for
`xyzToLab` and `deltaE00`. Wired GitHub Actions CI (`.github/workflows/ci.yml`, Node 20)
to run `npm test` followed by `npm run build`.

## 2026-05-21 — `feat: port CYNSN 3D CMY model to TypeScript with Nelder-Mead optimizer` (87cae9a)

Initial CYNSN port. New files: `lib/colormath.ts` (`xyzToLab`, `spectraToLab`, `deltaE00`),
`lib/analyzers/spreading.ts` (polynomial dot-gain + monotonicity penalty),
`lib/analyzers/optimizer.ts` (Nelder-Mead simplex, pure TS),
`lib/analyzers/cynsn.ts` (`demichel3`, `findCell3`, grid builders, `predictSpectra3`,
`extractNeugebauerPrimaries3`, `trainCYNSN3`, `evaluateCYNSN3`, `runCYNSNComparison`).
Architecture choice: K = 0 always → 3D CMY → 8 primaries → YNSN with `n_intervals = 1`
gives the single-cell baseline; CYNSN-2 uses `n_intervals = 2` for a 27-node grid.

UI integration: `ComparisonView` gained the "Within-profile CYNSN prediction" section
with per-profile YNSN vs CYNSN-2 table (columns: model, n_exponent, median ΔE00,
P95 ΔE00, RMS). Color coding: green < 2.0, yellow 2–3, red > 3.

Also pre-computed measured Lab outside the `trainCYNSN3` optimiser loop to avoid repeated
spectraToLab calls; reused a `predTmp` buffer to cut allocation pressure.

## 2026-05-21 — `feat: ink limits gate all analysis — sliders at top, filtered patches everywhere` (cc14bf6)

Ink-limit sliders moved to the top of `ComparisonView` and now gate every downstream
analyser (linearity, groups, ink-ratio, predictor, CYNSN). Each analyser receives the
already-filtered `MatchedPatchPair[]`. Eliminates the bug where the user could see
correlation numbers computed on patches above the ink limit.

`limitsAnalyzer.computeRampErrors` rewritten to use Yule-Nielsen `n = 2` between paper
and primary instead of linear Neugebauer (`n = 1`). For real Epson P9000 inks, `n = 1`
gave max ΔE76 ≈ 17.8 on a normal primary ramp — false-positive ink limit at level 192/255.
With `n = 2`, max ΔE drops to 5.3. Threshold raised from 2.0 to 6.0 accordingly. Detailed
write-up in `docs/EXPERIMENTS.md` (2026-05-22).

## 2026-05-21 — `refactor(frontend): code quality, English UI, responsive charts, project cleanup` (d745a8c)

Rebuilt frontend layout: gray-950 dark theme, responsive sidebar, English copy throughout.
D3 charts (`LabScatterPlot`, `SpectralCurves`) made responsive with `useMeasure`.
Removed stale fixtures and unused utilities. No analyser changes.

## 2026-05-21 — `feat(frontend): implement advanced color profile analysis and spectral prediction` (00c1cba)

Added `spectralPredictor.ts` (per-wavelength polynomial / YN / XYZ-affine model machinery,
`SpectralModelComparison` row), `inkRatioAnalyzer.ts` (T(λ) = R_ink / R_paper), and the
`PredictionAccuracyView` + `InkRatioTable` UI components. `groupAnalyzer.ts` introduced
to break patches into primaries / neutrals / mixed for the breakdown table.

## 2026-05-14 — `feat(frontend): add CxF and ZXML support for ICC profile parsing` (40b3645)

Real ICC parsing landed: `iccTagScanner.ts` locates the X-Rite `CxF` private tag,
identifies the `ZXML` data-type, skips the 12-byte header (4 data-type + 4 reserved +
4 unknown), inflates with `pako`. `parseCxf3Xml` walks the `cc:CxF` namespace and
extracts per-patch RGB device values + 36-band spectra. ICM parser refactored to
delegate to these.

## 2026-05-14 — `feat(frontend): implement color profile analysis dashboard` (f854d4a)

Two-pane dashboard: sidebar with `ProfileUploader` + `ProfileList`, main area with
`ComparisonView`. Zustand store added (`useProfileStore`) with profiles / selection /
results / loading state. ΔE colour-coding in `LabScatterPlot`.

## 2026-05-13 — `Add test infrastructure and fix parser/analyzer tests` (ea1ded1)

Vitest + jsdom + `@testing-library/jest-dom`. Fixed flaky parser tests around
percentage normalisation and default ID generation.

## 2026-05-13 — `Implement parsers and analyzers with tests, update documentation` (0eff24c)

First real CxF parser (XML), early `linearityAnalyzer` with Pearson r / R² / slope
stability / mean ΔE00 after correction / residual correlation. CMYK fuzzy match
(tolerance 2 %) for patch alignment — later superseded by the `Row:Col:Page` join when
RGB ZXML data came in.

## 2026-05-12 — `implement color profile analysis dashboard` (e3edd5f)

Initial scaffolding. React + Vite + TypeScript + Tailwind + Zustand.

## 2026-05-12 — `first commit` (a5a03c7)

Repository initialised.
