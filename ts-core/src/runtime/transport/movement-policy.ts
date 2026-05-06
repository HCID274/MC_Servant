/** Pathfinder movement policy for terrain-aware runtime actions. */

export const TERRAIN_ACTION_COST = 20;
export const PRECISE_DIG_APPROACH_COST = 100;

export interface TerrainMovementPolicyOptions {
  readonly canDig: boolean;
  readonly digCost?: number;
  readonly placeCost?: number;
}

/**
 * Applies the shared pathfinder movement guardrails used by online actions.
 *
 * The important invariant is `allow1by1towers = false`: mineflayer-pathfinder's
 * jump-place scaffold path is unreliable in live worlds, so runtime actions may
 * dig or fill terrain with an explicit cost, but must not depend on jumping and
 * placing a block under the bot.
 */
export function configureTerrainAwareMovements(
  movements: unknown,
  options: TerrainMovementPolicyOptions,
): void {
  if (movements === null || typeof movements !== "object") {
    return;
  }

  Object.assign(movements, {
    canDig: options.canDig,
    digCost: options.digCost ?? TERRAIN_ACTION_COST,
    placeCost: options.placeCost ?? TERRAIN_ACTION_COST,
    allow1by1towers: false,
  });
}
