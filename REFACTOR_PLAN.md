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
- [ ] Capture current contract drift:
  - List all actions used in meta-actions and runner.
  - Compare with `IBotActions` methods.
- [ ] Identify direct Mineflayer calls in systems (bot/pathfinder/blockAt/etc.).
- [ ] Decide naming conventions for adapter APIs (NavigationAPI, WorldAPI, etc.).

Phase 1 - Interface Corrections (No Behavior Change)
- [ ] Update `IBotActions` to include missing actions currently in use:
  - `smelt`, `mine_tree`, optional `get_player_position`.
- [ ] Align meta-actions and tests with the updated interface.
- [ ] Add a small contract test to ensure interface completeness (optional).

Phase 2 - Driver Adapter API (Core Boundary)
- [ ] Expand `IDriverAdapter` to expose explicit methods instead of raw handles:
  - Navigation: set_goal, stop, is_moving, goal, set_movements, goals.
  - World: block_at, dig, place_block, find_blocks.
  - Entity: get_position, look_at, players, entities.
- [ ] Implement these in `MineflayerDriver`.
- [ ] Remove direct `.bot` exposure where possible (or keep as private escape hatch).

Phase 3 - System Layer Refactor
- [ ] `MovementSystem` uses only adapter APIs (no `self._bot.*`).
- [ ] `MiningSystem` uses adapter APIs for block access and digging.
- [ ] `InventorySystem` uses adapter APIs for entities and item ops.
- [ ] Introduce `UnstuckPolicy` (or `MovementRecovery`) under movement.
- [ ] Move `climb_to_surface` into movement recovery module.

Phase 4 - Runner Recovery Policy
- [ ] Create `RecoveryPolicy` object with:
  - rule: when to trigger recovery vs retry vs LLM planner.
  - no hardcoded action strings in `UniversalRunner`.
- [ ] `UniversalRunner` depends on `RecoveryPolicy` for recovery steps.

Phase 5 - Cleanup & Documentation
- [ ] Remove unused fields or adapters after migration.
- [ ] Update module docs to reflect new boundaries.
- [ ] Verify with existing tests; add new ones if needed.

Progress Log
- 2025-02-__ : Plan created.
