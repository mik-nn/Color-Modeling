# NEXT_STEPS.md — Рекомендуемые следующие шаги

## Приоритет 1: Исправление тестов (High Priority) 🔴

### 1.1 Настройка vitest для работы с File API
**Проблема**: Тесты `cxfParser.test.ts` падают с ошибкой `file.text is not a function`

**Решение**: Добавить mock для File API в vitest config или setup file

```typescript
// src/test/setup.ts
import { vi } from 'vitest';

vi.mock('./File', () => ({
  File: class File extends Blob {
    name: string;
    lastModified: number;
    
    constructor(parts: Array<Blob | BufferSource | string>, filename: string, options?: any) {
      super(parts, options);
      this.name = filename;
      this.lastModified = options?.lastModified || Date.now();
    }
    
    text(): Promise<string> {
      return new Response(this).text();
    }
  }
}));
```

**Файлы для изменения**:
- `frontend/vitest.config.ts` - добавить environment: 'jsdom'
- `src/test/setup.ts` - создать файл с моками
- `package.json` - обновить test script с --setupFiles

### 1.2 Исправление тестов linearityAnalyzer
**Проблема**: Порог `minPatches: 50` слишком высок для юнит-тестов

**Решение**: 
1. Уменьшить `minPatches` в тестах до 3-5
2. Или увеличить количество тестовых данных
3. Добавить опциональный параметр для тестирования

```typescript
// В тестах использовать:
const result = analyzeLinearity(refProfile, targetProfile, { minPatches: 3 });
```

---

## Приоритет 2: Data Cleaning Pipeline (Medium Priority) 🟡

### 2.1 Реализация Savitzky-Golay фильтра
**Цель**: Сглаживание спектральных кривых для уменьшения шума

**Задачи**:
- [ ] Implement Savitzky-Golay filter in `src/utils/smoothing.ts`
- [ ] Add polynomial order and window size parameters
- [ ] Write unit tests with known input/output pairs
- [ ] Integrate into dataLoader pipeline

### 2.2 Outlier Detection
**Цель**: Автоматическое выявление и обработка аномальных измерений

**Методы**:
- Statistical: Z-score > 3σ
- IQR (Interquartile Range) method
- Mahalanobis distance for multivariate outliers

**Файл**: `src/utils/outlierDetection.ts`

---

## Приоритет 3: Расширение функциональности (Low Priority) 🟢

### 3.1 Batch Processing
- [ ] Multiple profile upload
- [ ] Pairwise comparison matrix
- [ ] Export results to CSV/JSON

### 3.2 Enhanced Visualizations
- [ ] Interactive D3 scatter plots with zoom/pan
- [ ] Spectral curve overlay with normalization
- [ ] Residual heatmaps

### 3.3 Advanced Metrics
- [ ] CIECAM02 color appearance model
- [ ] Spectral RMS error
- [ ] Metamerism index calculation

---

## Приоритет 4: Подготовка к публикации (Future) 📝

### 4.1 Scientific Article Structure
1. Introduction & Motivation
2. Related Work (CYNSN, YNSN, ink spreading models)
3. Methodology (linear transfer hypothesis)
4. Experimental Setup (datasets, substrates)
5. Results & Analysis
6. Discussion & Limitations
7. Conclusion & Future Work

### 4.2 Dataset Documentation
- [ ] Create sample dataset with 5+ substrate pairs
- [ ] Document measurement conditions
- [ ] Provide ground truth data

---

## Технические долги

| Компонент | Проблема | Приоритет |
|-----------|----------|-----------|
| cxfParser | Нет обработки ошибок XML | Medium |
| icmParser | Approximate CMYK→Lab conversion | High |
| linearityAnalyzer | Hard-coded minPatches | Medium |
| DeltaE00 | Simplified implementation | Medium |
| Tests | File API mocks missing | High |

---

## Рекомендация на следующую итерацию

**Фокус**: Исправление тестов (Приоритет 1)

**Обоснование**: Без работающих тестов невозможно безопасно развивать проект и рефакторить код. Это блокирует все дальнейшие улучшения.

**План действий**:
1. Создать `vitest.config.ts` с jsdom окружением
2. Добавить setup file с моками File API
3. Исправить тесты cxfParser
4. Уменьшить minPatches в тестах linearityAnalyzer
5. Запустить `npm run test` и убедиться что все тесты проходят

**Ожидаемое время**: 2-3 часа
