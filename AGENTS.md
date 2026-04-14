# AGENTS.md

## Cursor Cloud specific instructions

### Overview

Panel Manager ("Watcher") is a single-product **Electron desktop application** for managing Microsoft webmail panels/accounts. It consists of:

- **Main process** (`src/main/`): Electron main, IPC handlers, OAuth token refresh, state persistence
- **Renderer process** (`src/renderer/`): React 19 + Vite + Tailwind CSS UI
- **Shared** (`src/shared/`): Cookie format parsing, Microsoft auth diagnostics
- **Types** (`src/types/`): TypeScript type definitions

### Development commands

All standard commands are in `package.json`:

| Task | Command |
|------|---------|
| Dev mode (Vite + Electron) | `npm run dev` |
| Build (TS + Vite) | `npm run build` |
| TypeScript only | `npm run build:ts` |
| Vite only | `npm run build:vite` |
| Tests (OAuth) | `npm run test:oauth` |
| Tests (Cookie) | `npm run test:cookie` |
| Start built app | `npm run start` |

### Cloud VM caveats

- The VM already has a display (`:1`) available — no need for `xvfb-run`. Electron runs directly.
- D-Bus errors (`Failed to connect to the bus`) appear in console output but are harmless — the app functions normally without D-Bus.
- WebGL blocklist warnings (`ContextResult::kFatalFailure: WebGL1 blocklisted`) are expected in the container environment and do not affect app functionality.
- There is no linter script configured in `package.json`. TypeScript type-checking via `tsc -b` serves as the primary static analysis tool.
- The app has no external database or Docker dependencies — it stores state locally in Electron's encrypted store via `safeStorage`.
- Token refresh and session validity checks are disabled in development mode (logged as `DISABLED for debugging`).
- No `.env` file is needed — all configuration is managed through the app's Settings UI and persisted in the encrypted local store.
