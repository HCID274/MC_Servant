# Backend (Minimal Baseline)

`backend/` has been reset to a minimal runtime core.
This version keeps only low-level communication and bot control foundations.

## Structure

```text
backend/
├── main.py                      # FastAPI + WebSocket entry
├── config.py                    # Minimal env config
├── protocol.py                  # WS message schema
├── websocket/connection_manager.py
├── bot/interfaces.py
├── bot/mineflayer_adapter.py    # Mineflayer bridge
└── data/                         # Static data files (kept for rebuild)
```

Removed from runtime baseline:
- database layer (`db/`)
- llm/memory layer (`llm/`)
- state/task/perception orchestration (`state/`, `task/`, `perception/`)

## What This Minimal Backend Does

- Authenticated WebSocket endpoint: `/ws/{client_id}`
- Protocol compatibility with Java plugin:
  - receives: `player_message`, `servant_command`, `heartbeat`, sync events
  - sends: `init_config`, `request_sync`, `npc_response`, `hologram_update`, `bot_owner_update`, `error`
- Basic bot actions (no LLM planning):
  - `hello`, `status`, `jump`, `say ...`, `look ...`
- In-memory ownership state for `claim` / `release` / `list`

## Run

From repository root:

```powershell
.\start.bat
```

Or manually:

```powershell
cd backend
uv run --with-requirements requirements.txt python main.py
```

Required `.env` keys:

```ini
MC_SERVANT_WS_ACCESS_TOKEN=your_token
MC_SERVANT_MC_HOST=127.0.0.1
MC_SERVANT_MC_PORT=25565
MC_SERVANT_BOT_PASSWORD=your_authme_password
```

## Notes

- Ownership and player sync are memory-only (reset on backend restart).
- No database migration or LLM API setup is needed in this baseline.
