# ROADMAP.md

## Phase 0: Foundation (Май 2026) ✅ ЗАВЕРШЕНО
- [x] Document-Driven структура
- [x] Filename Parser + Metadata extraction (TypeScript)
- [x] Data Loader (.icm / CxF)
- [x] Raw vs Clean pipeline + Savitzky-Golay
- [x] **Базовая реализация парсеров** (cxfParser, icmParser)
- [x] **Linearity Analyzer с метриками**
- [x] **Data Cleaning Pipeline** (Savitzky-Golay, Outlier Detection, Noise Reduction)

### Текущий статус тестов ✅
- ✅ filenameParser.test.ts (1 test passing)
- ✅ cxfParser.test.ts (6 tests passing)
- ✅ linearityAnalyzer.test.ts (6 tests passing)
- ✅ dataCleaningPipeline.test.ts (13 tests passing)
- ✅ debug_cxf.test.ts (1 test passing)

**Итого**: 27/27 тестов проходят (100% coverage) ✅

## Phase 1: Core Analysis (Май–Июнь 2026)
- [x] Исправление тестов и настройка vitest окружения ✅
- [ ] Интеграция Data Cleaning Pipeline в основной workflow
- [ ] Интерактивный дашборд сравнения профилей
- [ ] Корреляции + линейная регрессия
- [ ] Residual analysis
- [ ] Baseline отчёты

## Phase 2: Advanced Modeling
- Реализация CYNSN модели
- Ink Spreading stability analysis
- CIE-based corrections (XYZ, CIECAM)

## Phase 3: Generative & ML
- VAE / β-VAE прототип для disentanglement
- Few-shot адаптация

## Phase 4: Scientific Output
- Подготовка статьи для Substack + возможно journal
- Open-source инструмент