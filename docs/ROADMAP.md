# ROADMAP.md

## Phase 0: Foundation (Май 2026)
- [x] Document-Driven структура
- [x] Filename Parser + Metadata extraction (TypeScript)
- [x] Data Loader (.icm / CxF)
- [ ] Raw vs Clean pipeline + Savitzky-Golay
- [x] **Базовая реализация парсеров** (cxfParser, icmParser)
- [x] **Linearity Analyzer с метриками**

### Текущий статус тестов ⚠️
- ✅ filenameParser.test.ts (1 test passing)
- ❌ cxfParser.test.ts (6 tests failing - File API mock issue)
- ❌ linearityAnalyzer.test.ts (4 tests failing - minPatches threshold too high for test data)

## Phase 1: Core Analysis (Май–Июнь 2026)
- [ ] Исправление тестов и настройка vitest окружения
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