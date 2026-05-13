# Color Modeling Project

**Document-Driven Development**

Исследование и подтверждение гипотезы линейной переносимости поведения красок между разными субстратами для быстрой адаптации ICC-профилей с минимальными измерениями.

### Цель проекта
Разработать метод, позволяющий строить качественные цветовые профили на новых материалах, используя существующий профиль + минимальный набор измерений (white point + solids + 50% ramps).

### Статус реализации ✅

Все основные компоненты реализованы:

- ✅ **CXF Parser** - Парсер файлов Color Exchange Format с поддержкой спектральных данных
- ✅ **ICM Parser** - Парсер бинарных ICC профилей с извлечением A2B таблиц
- ✅ **Linearity Analyzer** - Полный набор метрик для анализа линейности переноса
- ✅ **DeltaE00 Calculation** - Расчёт цветовых различий CIEDE2000
- ✅ **Fuzzy Matching** - Сопоставление патчей с допуском 2%
- ✅ **Confidence Scoring** - Автоматическая оценка качества (high/medium/low)
- ✅ **Visual Dashboard** - Интерфейс для отображения результатов анализа
- ⚠️ **Unit Tests** - Требуют исправления (проблемы с моками File API и порогом minPatches)

### Текущие проблемы 🛠️

1. **Тесты CXF Parser**: Ошибка `file.text is not a function` - требуется настройка vitest окружения для работы с File API
2. **Тесты Linearity Analyzer**: Порог `minPatches: 50` слишком высок для тестовых данных
3. **Отсутствует pipeline очистки данных**: Savitzky-Golay фильтр и outlier detection не реализованы

### Быстрый старт

```bash
cd frontend
npm install
npm run dev
```

### Запуск тестов

```bash
npm install --save-dev vitest jsdom
npx vitest run
```

### Основные документы проекта
- [AGENTS.md](docs/AGENTS.md) — роли и агенты
- [workflow.md](docs/workflow.md) — процессы и пайплайны
- [Tech.md](docs/Tech.md) — технологический стек
- [SKILLS.md](docs/SKILLS.md) — компетенции
- [ROADMAP.md](docs/ROADMAP.md) — план развития
- [RESEARCH_HYPOTHESIS.md](docs/RESEARCH_HYPOTHESIS.md) — научные гипотезы
- [IMPLEMENTATION.md](docs/IMPLEMENTATION.md) — **полная документация по реализации**
- [PROMPTS.md](docs/PROMPTS.md) — промпты для LLM
- [EXPERIMENTS.md](docs/EXPERIMENTS.md) — логи экспериментов

### Архитектура

**Frontend:** React 18 + TypeScript + Vite + TailwindCSS + Zustand + D3.js

**Основные модули:**
- `/src/lib/parsers/` - Парсеры форматов (.icm, .cxf)
- `/src/lib/analyzers/` - Анализаторы (linearityAnalyzer)
- `/src/components/` - UI компоненты
- `/src/store/` - State management (Zustand)

**Ключевые метрики анализа:**
- Pearson Correlation (LAB)
- R² (Coefficient of Determination)
- Slope Stability Score
- Mean ΔE00 After Correction
- Residual Correlation
- Confidence Level

**Репозиторий:** https://github.com/mik-nn/Color_Modeling.git