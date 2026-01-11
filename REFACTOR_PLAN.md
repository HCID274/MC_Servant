# Refactor Plan - Mineflayer-Only, Clean Abstractions

Goal: keep Mineflayer as the only backend while enforcing clear boundaries and
stable interfaces so the codebase stays easy to understand and refactor.

Principles
- Simple interfaces, deep behavior (systems hide complexity).
- Depend on abstractions, not concrete objects.
- Mineflayer-specific details live behind driver adapters.
- Keep changes incremental and reviewable.

Outcomes
- System layer stops touching `bot.*` and `pathfinder.*` directly.
- `IBotActions` reflects the actual action surface used by the codebase.
- Movement recovery (`climb_to_surface`) lives under movement, not mining.
- UniversalRunner relies on a recovery policy object instead of hardcoding steps.

Status Legend
- [ ] pending
- [x] done
- [~] in progress

Phase 0 - Baseline & Alignment
- [x] Capture current contract drift:
  - List all actions used in meta-actions and runner.
  - Compare with `IBotActions` methods.
- [x] Identify direct Mineflayer calls in systems (bot/pathfinder/blockAt/etc.).
- [x] Decide naming conventions for adapter APIs (NavigationAPI, WorldAPI, etc.).

Phase 0 Findings
- Meta-actions (names): `navigate`, `gather_block`, `craft_item`, `smelt_item`,
  `retreat_safe`, `scan_environment`.
- UniversalRunner action names: `climb_to_surface`, `craft`, `explore`,
  `find_location`, `give`, `goto`, `look_around`, `mine`, `mine_tree`, `patrol`,
  `pickup`, `place`, `scan`.
- `IBotActions` methods: `get_state`, `goto`, `mine`, `climb_to_surface`,
  `place`, `craft`, `give`, `equip`, `scan`, `pickup`, `find_location`,
  `patrol`, `chat`.
- Gaps to fix in Phase 1:
  - Missing in interface but used: `smelt`, `mine_tree`, `get_player_position`.
  - Runner references `explore`, `look_around` without meta-action or interface.
- Direct Mineflayer usage counts in systems (self._bot / self._pathfinder):
  - `backend/bot/systems/crafting.py`: 27
  - `backend/bot/systems/inventory.py`: 15
  - `backend/bot/systems/mining.py`: 54
  - `backend/bot/systems/movement.py`: 54
  - `backend/bot/systems/perception.py`: 13
- Adapter naming convention: use capability facets (e.g., `nav`, `world`,
  `entity`, `inventory`) under `IDriverAdapter`, each exposing explicit methods.

Phase 1 - Interface Corrections (No Behavior Change)
- [x] Update `IBotActions` to include missing actions currently in use:
  - `smelt`, `mine_tree`, optional `get_player_position`.
- [x] Align meta-actions and tests with the updated interface.
- [x] Resolve `explore` / `look_around` by adding meta-action aliases.
- [ ] Add a small contract test to ensure interface completeness (optional).

Phase 2 - Driver Adapter API (Core Boundary)
- [x] Expand `IDriverAdapter` to expose explicit methods instead of raw handles:
  - Navigation: set_goal, stop, is_moving, current_goal, goals.
  - World: block_at, dig, find_blocks.
  - Entity + control: get_position, look_at, get_player(s), set_control_state.
- [x] Implement these in `MineflayerDriver`.
- [x] Remove direct `.bot` exposure where possible (or keep as private escape hatch).

Phase 3 - System Layer Refactor
- [x] `MovementSystem` uses only adapter APIs (no `self._bot.*`).
- [x] `MiningSystem` uses adapter APIs for block access and digging.
- [x] `InventorySystem` uses adapter APIs for entities and item ops.
- [x] `CraftingSystem` uses adapter APIs for crafting/window access.
- [x] `PerceptionSystem` uses adapter APIs for scans and queries.
- [x] Introduce `UnstuckPolicy` (or `MovementRecovery`) under movement.
- [x] Move `climb_to_surface` into movement recovery module.

Phase 4 - Runner Recovery Policy
- [x] Create `RecoveryPolicy` object with:
  - rule: when to trigger recovery vs retry vs LLM planner.
  - no hardcoded action strings in `UniversalRunner`.
- [x] `UniversalRunner` depends on `RecoveryPolicy` for recovery steps.

Phase 5 - Cleanup & Documentation
- [x] Remove unused fields or adapters after migration.
- [x] Update module docs to reflect new boundaries.
- [x] Verify with existing tests; add new ones if needed.
- [x] Migrate perception utilities (scanner/inventory) to adapter APIs.

Progress Log
- 2025-02-__ : Plan created.
- 2026-01-11 : Phase 0 baseline completed and findings recorded.
- 2026-01-11 : Phase 1 interface update (IBotActions) completed.
- 2026-01-11 : Meta-actions/tests aligned with sync `get_state`.
- 2026-01-11 : Added `explore`/`look_around` meta-actions and tests.
- 2026-01-11 : Adapter APIs added; MovementSystem migrated.
- 2026-01-11 : InventorySystem and MiningSystem migrated to adapter APIs.
- 2026-01-11 : CraftingSystem/PerceptionSystem migrated; UnstuckPolicy added.
- 2026-01-11 : RecoveryPolicy introduced and wired into UniversalRunner.
- 2026-01-11 : Perception utilities and MineflayerActions state access moved to adapter APIs.
- 2026-01-11 : Removed raw bot/pathfinder adapter escape hatches; chat now uses driver API.
- 2026-01-11 : Updated bot module docs and re-verified pytest suite.
- 2026-01-11 : Enforced strict abstraction for goals and data lookups via driver APIs.
