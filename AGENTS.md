# Repository Guidelines

## Project Structure & Module Organization
The project follows a **Document-Driven Development** approach, focused on validating linear ink behavior across substrates for ICC profile adaptation. The codebase is organized as a React-based frontend that contains the core analytical logic.

- **`./src/lib/parsers/`**: Parsers for `.icm` (ICC profiles) and `.cxf` (Color Exchange Format) files.
- **`./src/lib/analyzers/`**: Core statistical analysis, including `linearityAnalyzer` for Pearson correlation, R², and slope stability.
- **`./src/store/`**: Application state management using **Zustand**.
- **`./src/components/`**: UI components for visualization, leveraging **D3.js** for interactive charting.
- **`./docs/`**: Extensive project documentation, including research hypotheses and implementation details.

## Build, Test, and Development Commands
Commands should be executed from the `./frontend` directory.

- **`npm install`**: Install dependencies.
- **`npm run dev`**: Start the Vite development server.
- **`npm run build`**: Build the production application.
- **`npm run lint`**: Run ESLint checks (TypeScript-strict).
- **`npm run test`**: Execute the Vitest suite.
- **`npx vitest <file_path>`**: Run a specific test file.

## Coding Style & Naming Conventions
- **Language**: TypeScript with strict typing.
- **Linting/Formatting**: ESLint (standard React/TS rules) and Prettier.
- **UI Framework**: React 18 with TailwindCSS for styling.
- **Architecture**: Functional components with hooks and centralized state via Zustand.

## Testing Guidelines
- **Framework**: Vitest with `jsdom`.
- **Location**: Tests are co-located with implementation (e.g., `*.test.ts`) or in `./frontend/src/test/`.
- **Focus**: Unit tests are required for all parsers (`./src/lib/parsers/`) and analyzers (`./src/lib/analyzers/`).

## Commit & Pull Request Guidelines
- **Commit Style**: Concise, imperative messages (e.g., "Add test infrastructure", "Implement parsers").
- **Workflow**: Document changes in `./README.md` and `./docs/` as part of the implementation cycle.
