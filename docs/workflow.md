# workflow.md — Рабочие процессы

## Основной цикл исследования

1. **Data Ingestion**
   - Добавление новых `.icm` файлов в `data/profiles/`

2. **Parsing & Extraction**
   - Разбор имени файла
   - Извлечение метаданных и спектральных данных (CxF)

3. **Data Preparation**
   - Создание Raw версии
   - Cleaning pipeline (валидация → outliers → Savitzky-Golay → interpolation)
   - Alignment таблиц между разными профилями

4. **Analysis**
   - Pairwise comparison
   - Корреляции (LAB + Spectral + Residuals)
   - Линейная регрессия и stability analysis

5. **Visualization**
   - Загрузка результатов в дашборд

6. **Documentation**
   - Обновление `EXPERIMENTS.md`
   - Обновление `Context.md`
   - Сохранение ключевых графиков

## Рекомендация
После каждого значимого запуска анализа создавать запись в `EXPERIMENTS.md` с датой и выводами.