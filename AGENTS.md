# Repository Guidelines

## User Mandatory Rule
- 未经用户明确允许，禁止擅自新增功能、扩展实现、改动需求范围。
- 默认只执行用户明确要求的最小改动；任何额外实现必须先提问并获得确认。
- 若需求存在歧义，先澄清再改代码。

## Project Structure & Module Organization
- `backend/`: Python FastAPI + WebSocket backend, task engine, state machine, LLM integration, persistence, and tests.
- `backend/tests/`: pytest test suite for runner, planner, memory, recovery, and action integration.
- `plugin/`: Java Paper/Spigot plugin (command handling, WS client, holograms, GUI).
- `scripts/`: utility scripts (notably knowledge base generation).
- `00Docs/`, `Docs/`: architecture and evolution documents.
- Root entrypoints: `start.bat` (backend launch), `README.md` (overview).

## Build, Test, and Development Commands
- Backend dependencies:
  - `cd backend && pip install -r requirements.txt`
  - `cd backend && npm install` (Mineflayer/node dependencies)
- Run backend locally:
  - `.\start.bat` (from repo root), or `cd backend && python main.py`
- Run tests:
  - `cd backend && pytest -q`
  - Single test file example: `cd backend && pytest tests/test_universal_runner.py -q`
- Build plugin JAR:
  - `cd plugin && .\mvnw.cmd clean package -DskipTests`
- DB migration (if schema changes):
  - `cd backend && alembic upgrade head`

## Coding Style & Naming Conventions
- Python: follow existing type-hinted style, 4-space indentation, `snake_case` for functions/variables, `PascalCase` for classes.
- Java: standard 4-space indentation, `camelCase` methods/fields, `PascalCase` classes.
- Keep modules responsibility-focused (avoid adding new “god classes”).
- Backend comments/docstrings are predominantly Chinese; keep language consistent within edited files.

## Testing Guidelines
- Framework: `pytest` (backend). Add tests under `backend/tests/` with names `test_*.py`.
- Prefer focused unit tests for new logic and regression tests for bug fixes.
- For task/recovery changes, include at least one failure-path test and one success-path test.

## Commit & Pull Request Guidelines
- History shows useful prefixes like `feat(...)`, `fix(...)`, `docs:`. Prefer this style consistently.
- Good commit example: `fix(task): prevent repeated explore loop in recovery`.
- Avoid vague messages (`debug`, `123`, `还行`).
- PRs should include:
  - concise problem/solution summary,
  - affected modules (e.g., `backend/task`, `plugin/websocket`),
  - test evidence (`pytest` output or manual verification steps),
  - screenshots/log snippets for UI/hologram/WS behavior changes.

## Security & Configuration Tips
- Never commit real secrets (`MC_SERVANT_WS_ACCESS_TOKEN`, API keys, DB password).
- Use `.env` / local config values and keep plugin/backend WebSocket token aligned.
