# Tech.md — Технологический стек

## Frontend (Phase 0–1)
- **TypeScript 5+**
- **Vite** (build tool)
- **React 18** + React Router v7
- **TailwindCSS** + shadcn/ui или Headless UI
- **D3.js v7** — основная библиотека визуализации
- **Zustand** — state management
- **TanStack Query** — работа с данными
- **math.js** / **simple-statistics** — клиентские расчёты

## Форматы данных
- Вход: `.icm`, `.cxf`
- Промежуточный: JSON (с типизацией)
- Архив: Parquet (будет на Python backend)

## Будущий стек (Phase 2+)
- Python FastAPI backend
- colour-science + scipy + scikit-learn
- PyTorch (для VAE)
- ArgyllCMS integration

## Coding Standards
- Strict mode TypeScript
- ESLint + Prettier + Husky
- Feature-based структура папок
- Компоненты с хорошей типизацией

## Local tooling (frontend)
- Dev: `npm run dev` (в папке `frontend`)
- Build: `npm run build` (frontend)
- Lint: `npm run lint` (frontend)
- Tests (Vitest): `npm test` / `npm run test:watch` (frontend)
- Format: `npx prettier . --check` / `npx prettier . --write` (frontend)
