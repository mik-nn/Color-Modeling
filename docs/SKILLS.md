    # SKILLS.md — Компетенции и навыки проекта

## Core Expertise

### Color Science & Management (Высокий уровень)
- ICC-профили, A2B/B2A таблицы, CxF формат
- Спектральное цветоведение (ISO 13655)
- Модели Neugebauer, Yule-Nielsen, Ink Spreading
- ΔE метрики (ΔE00, ΔE76, CIEDE2000)
- Media White Point, Chromatic Adaptation (Bradford, CAT02)

### ICC Profile Specifications
- ICC.1 v4 (ISO 15076-1:2022) - Profile format v4.4.0.0
- ICC.2 iccMAX - Extended profile format with CxF support
- Private tags for CxF embedding (ZXML 0x5a584d4c, zxml 0x7a786d6c)
- Header structure: 128 bytes + tag table at byte 128
- Tag record: signature(4) + offset(4) + size(4) = 12 bytes each

### CxF (Color eXchange Format) Specifications
- CxF/X3 (ISO 17972-3) - Output target data for printer characterization
- CxF/X4 (ISO 17972-4) - Spot color characterization data
- ZXML format - ZIP-compressed XML for CxF embedding in ICC profiles
- Standard format: `wavelength value` pairs (e.g., "380 0.10\n390 0.20")

### ICC Profile Specifications
- ICC.1 v4 (ISO 15076-1:2022) - Profile format v4.4.0.0
- ICC.2 iccMAX - Extended profile format with CxF support
- Private tag embedding (tag 34675/8773h for ICC in TIFF-style)
- Header structure: 128 bytes + tag table at byte 128
- Tag record: signature(4) + offset(4) + size(4) = 12 bytes each

### CxF (Color eXchange Format) Specifications
- CxF/X3 (ISO 17972-3) - Output target data for printer characterization
- CxF/X4 (ISO 17972-4) - Spot color characterization data
- CxF embedding in ICC: @data block extraction, wavelength/reflection format
- Standard format: `wavelength value` pairs (e.g., "380 0.10\n390 0.20")

### Data Science & Analysis
- Корреляционный и регрессионный анализ
- Residual analysis
- Savitzky-Golay filtering
- Outlier detection
- Linear and Canonical Correlation Analysis

### Programming & Engineering
- TypeScript / React / D3.js (текущий фокус)
- Data parsing и ETL pipelines
- Научная визуализация больших датасетов
- Document-Driven Development

### Advanced (в разработке)
- Variational Autoencoders (VAE, β-VAE)
- Disentangled representation learning
- Transfer learning между доменами (substrate adaptation)

## Требуемый уровень команды/агентов
- Research Scientist: PhD-level understanding цветовых моделей CIE
- Data Engineer: Strong TypeScript + data processing
- Visualization: Expert D3.js + scientific plotting