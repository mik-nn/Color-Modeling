# Implementation Plan — Substrate Dataset Generator (финальное приложение)

> **Цель.** Production TypeScript-приложение (без экспериментального обвеса).
> Вход: **один или несколько референсных профилей одного режима печати** +
> **минимальный чарт измеренных патчей** на новом субстрате. Выход: полный
> предсказанный датасет (905 × 36) для нового субстрата → **экспорт CGATS.17**.
> При риске **Hue/Saturation Bias** — предупреждение с указанием области и
> рекомендацией референса.

Статус: **PLAN** · Дата: 2026-06-17 · База: D1 + coverage-6 (H31/H31b),
spreadCurv-флаг (H36/H37/H38), pool-PCA (B3). Без H22/CAE.

---

## 1. Решения пользователя (зафиксировано)

| # | Решение | Следствие в плане |
|---|---|---|
| 1 | Чарт: 6 патчей, но если 6-й не добавляет точности — 5 | **6 (coverage-6)**: 6-й = mid-gray даёт и coverage-анкер (ink≈1.5), и 3-й нейтраль для spreadCurv-флага. Удалять нельзя (см. §2.2) |
| 2 | Метод | **D1** (paper-ratio + rank-5 PCA residual). НЕ H22/CAE |
| 3 | Форма | Финальное приложение: 1+ референса одного режима → предсказать датасет при минимуме патчей. Без experiment-кода |
| 4 | Экспорт | **только CGATS.17** |

---

## 2. Метод — D1 + coverage-6 chart (обоснование)

### 2.1 Почему coverage-6, а не S1-corners

H31/H31b/диагностика d1_lowk: провал D1 на малом k — это **placement** анкеров
на оси ink-coverage, не count.

| Набор k | Pass (104 пары) |
|---|---|
| S1 k=5 (paper+R+G+B+C) | 45.2% |
| S1 k=6 | 49.0% |
| **coverage-6** {white, C, M, Y, black, gray128} | **76.9%** |
| S1 adaptive k=12 | 88.5% (потолок) |

`coverage-6` **target-agnostic**: фиксированный чарт, без эвристики и без знания
target-профиля. +27.9 pp над S1 k=6 при том же k — чисто за счёт того, ГДЕ
стоят 6 анкеров (full-CMY ink=3 + mid-gray ink=1.5 закрывают heavy-ink зону,
где k=5 экстраполирует и взрывается).

### 2.2 Почему именно 6, а не 5 (ответ на решение #1)

6-й патч (**mid-gray 128**) несёт двойную нагрузку:

1. **Coverage-анкер** на ink≈1.5 — заполняет среднюю плотность.
2. **3-я нейтраль** (white / mid-gray / black) → `computeSpreadCurv`
   (квадратичный fit `1+c1·a+c2·a²`, хорошо обусловлен на 3 точках, H37).
   Без неё **детектор Hue/Sat bias не считается вовсе**.

H37: spreadCurv с 3 нейтралей AUC=0.848 ≥ полная рампа 0.841. → 6-й патч
добавляет и точность coverage, и весь флаг-детектор. **Вывод: используем 6.**
5 патчей (без gray) = деградация placement + потеря предупреждения.

### 2.3 Coverage-6 чарт

```text
1. white   RGB(255,255,255)  ink 0    субстрат + OBA + spreadCurv-anchor a=0
2. Cyan    RGB(  0,255,255)  ink 1    гамут-направление
3. Magenta RGB(255,  0,255)  ink 1
4. Yellow  RGB(255,255,  0)  ink 1
5. black   RGB(  0,  0,  0)  ink 3    heavy-ink (full CMY) + spreadCurv a=max
6. gray128 RGB(128,128,128)  ink~1.5  mid-coverage + spreadCurv a=mid
```

### 2.4 Лестница чартов 6 / 8 / 12 (выбираемая, H41/H42)

Разрыв cov6→S1-12 (76.9→88.5%) = **heavy-ink P95-хвост** на 12 «FLIP» парах
(spreading-совместимых): медиана уже в норме, торчит P95 на тяжёлой краске
(heavy-tercile ΔE 3.07 vs 1.53 у проходящих). Лечится **нейтральной рампой**,
не gamut-углами (H42: 2 нейтрали > 3 secondaries).

| Чарт | Патчи | Pass | FLIP recovered | Когда |
|---|---|---|---|---|
| **cov6** | 6 | 76.9% | — | минимум измерений |
| **cov8n** = cov6 + gray64 + gray192 | 8 | **82.7%** | 6/12 | sweet spot patch/accuracy |
| **S1-12** | 12 | 88.5% | 12/12 | пик; нужна тяжёлая/насыщенная точность |

UI: чарт **6/8/12 выбираемый**. cov8n добавляет 2 нейтрали (gray64 ink≈2.25,
gray192 ink≈0.75) — целит ровно heavy-ink хвост. Структурные 12 (high dCurv)
не лечатся числом патчей → ловятся spreadCurv-флагом (§4).

---

## 3. Несколько референсов одного режима (ответ на решение #3)

| Случай | Путь |
|---|---|
| **1 референс** | D1: `runOBASeparatedTransfer` → `runPaperRatioResidualTransfer` |
| **N референсов** | `fitPoolBasis(N профилей)` → `runPoolPCATransfer` — pool-PCA basis богаче residual-подпространства; D1-перенос в нём |
| **Выбор лучшего** | `rankReferencesByProximity` (spreadCurv) → рекомендатор: какой референс ближе к target по spreading-кривизне (H37: nearest-vs-farthest 13/14) |

Поток для N референсов: построить pool-basis из всех refs режима → если в наборе
есть несколько кандидатов, рекомендатор подсвечивает ближайший по spreadCurv;
перенос — pool-PCA по coverage-6 анкерам.

---

## 4. Hue/Saturation Bias — детектор (готовый, не изобретаем)

Природа провала (H40, анатомия 12 структурных failers): **80% чарта верны**
(ΔE≤3), хвост ~20% = **гладкий направленный хроматический биас** — сжатие/
раздувание chroma + поворот hue на хроматических экстремумах (orange ±13–14°,
dark-green −18 ΔC +17°). НЕ постеризация, НЕ соляризация (gradient ratio ≈1,
L*-инверсий ≈0). Знак ΔC задаётся направлением переноса.

Это **ровно тот** Hue/Saturation bias, что нужно предупреждать. Предиктор —
**spreadCurv-флаг** (a-priori, до полной генерации):

```text
ref_curv    = computeSpreadCurv(ref)        // из 3 нейтралей референса
target_curv = computeSpreadCurv(coverage6)  // из white/gray128/black анкеров
compat      = classifyPairCompatibility(ref_curv, target_curv)
если |Δcurv560| большой → WARNING: предсказан структурный хроматический биас
```

H33: r(fail, spreadCurv) = −0.64 — единственный коррелят отказа (b*, paper-curv,
chroma — нет). H38: spreading-коррекцию НЕ применяем (ломает passers, не чинит
failers; биас хроматический, нейтральная рампа его не правит). spreadCurv —
**только флаг + рекомендатор**, не корректор.

### Формат предупреждения (UI)

```ts
interface BiasWarning {
  level: 'ok' | 'hue-sat-bias' | 'incompatible'
  deltaCurv560: number
  message: string            // напр. «Риск хроматич. биаса (Δcurv 0.21): возможно
                             //  пере/недосыщение в насыщенных зонах»
  recommendedReference?: string   // из rankReferencesByProximity
}
```

`incompatible` → честно: доп. патчи не помогут (структурный потолок ~11.5%,
H40 — биас хроматический, нейтральные данные его не исправляют).

---

## 5. Архитектура финального приложения

Новых алгоритмов нет. Сборка существующего `frontend/src/lib/predict/` +
тонкий слой генератора + UI. Experiment-скрипты (`scripts/experiments/*`,
`h2x_train`) в приложение **не входят**.

```text
Generate flow (новый, тонкий):
  core/coverage6Chart.ts     ← НОВЫЙ — определение чарта + маппинг device→anchorIdx
  core/generateDataset.ts    ← НОВЫЙ — оркестратор: 1 ref → D1 | N refs → pool-PCA
  core/biasWarning.ts        ← НОВЫЙ — обёртка spreadCurv-флага + recommender → BiasWarning

Переиспользуем как есть:
  predict/obaSeparator.ts        runOBASeparatedTransfer · subtractOBA · addOBA
  predict/paperRatioResidual.ts  runPaperRatioResidualTransfer   (D1, 1 ref)
  predict/poolPCATransfer.ts     fitPoolBasis · runPoolPCATransfer (N refs)
  predict/spreadCurv.ts          computeSpreadCurv · classifyPairCompatibility · rankReferencesByProximity
  colormath.ts                   spectraToXYZ · xyzToLab · deltaE00
  cgatsExport.ts                 экспорт результата (только CGATS)

UI: упростить/выделить из components/TransferView.tsx чистый «Generate» экран:
  загрузка 1+ референсов режима → ввод coverage-6 измерений →
  [рекомендатор референса] → Generate → BiasWarning баннер → Export CGATS.
```

---

## 6. Поток данных

```text
[refs A1..An: 905×36] ──┐
                        ├─► D7 OBA separation (per ref + per coverage-6 анкер)
[coverage-6 B: 6 anchor]┘        subtract → clean
                              │
              ┌───────────────┴───────────────┐
              ▼ n=1                            ▼ n>1
   runPaperRatioResidual              fitPoolBasis(refs) →
   (Layer1 paper-ratio +              runPoolPCATransfer
    Layer2 rank-min(k-1,5) PCA)       (per-PC diagonal affine на 6 анкерах)
              └───────────────┬───────────────┘
                              ▼  addOBA
                    [B_pred: 905×36] ──► spectraToLab ──► ProfileData
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
   biasWarning       Export CGATS17     (опц.) error-map
   (spreadCurv)
```

---

## 7. Build sequence (TDD, тесты рядом)

| # | Шаг | Критерий теста |
|---|---|---|
| 1 | `coverage6Chart.ts` — чарт + device→anchorIdx маппинг | отвергает набор без white/gray/black; находит ближайшие патчи |
| 2 | `biasWarning.ts` — обёртка spreadCurv → `BiasWarning` | синтетич. большой Δcurv → `hue-sat-bias`; рекомендатор возвращает ближайший ref |
| 3 | `generateDataset.ts` — оркестратор (1 ref → D1; N → pool-PCA) | реальная пара → 905×36 ProfileData; N-ref путь использует pool-basis |
| 4 | Валидация на реальных профилях (1 ref) | median ΔE₀₀ ≤1.5 на coverage-6 (целимся в ~77%) |
| 5 | CGATS-экспорт результата | round-trip парсится обратно |
| 6 | UI «Generate» (выделить из TransferView) + баннер + export | Playwright screenshot |

CI = source of truth (Node 20); локальный Node v12 не гоняет vitest.

---

## 8. Вне области (по решениям пользователя)

- ❌ H22 / CAE нейро-путь (метод = D1).
- ❌ Experiment-скрипты в приложении (финальный продукт).
- ❌ Spreading-коррекция (H38: не чинит, ломает — только флаг).
- ❌ Экспорт кроме CGATS (CxF/ICM round-trip не нужен).
- ❌ 5-патчевый чарт по умолчанию (6-й нужен для флага и mid-coverage).

---

## 9. DDD-следы (по завершении)

- `docs/IMPLEMENTATION.md` — модули `core/coverage6Chart|generateDataset|biasWarning`.
- `docs/progress-log.md` — запись на сессию.
- `docs/ROADMAP.md` — фаза «few-patch generation» → done.
- `docs/EXPERIMENTS.md` строки не нужны (продакшн-сборка, не эксперимент).
