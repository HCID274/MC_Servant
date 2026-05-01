import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import {
  createProbeBot,
  fail,
  formatPoint,
  formatWorld,
  getMutableVelocity,
  getPosition,
  getVelocity,
  horizontalDistance,
  prepareBot,
  readBaseConfig,
  readFlags,
  readNumberFlag,
} from "./knockback-probe-common.js";

const baseConfig = readBaseConfig(process.argv.slice(2), process.env);
const flags = readFlags(process.argv.slice(2));
const impulse = {
  x: readNumberFlag(flags, process.env, "vx", "MC_PROBE_VX", 0.55),
  y: readNumberFlag(flags, process.env, "vy", "MC_PROBE_VY", 0),
  z: readNumberFlag(flags, process.env, "vz", "MC_PROBE_VZ", 0),
};
const bot = createProbeBot(baseConfig);

try {
  console.log(
    "[probe] 我在排除哪一环: F velocity（速度）写入之外的 G physics tick（物理帧）推进。",
  );
  console.log(
    "[probe] 该控制变量不依赖玩家/怪物攻击，只验证手动 velocity（速度） 是否能推动 position（位置）。",
  );
  await prepareBot(bot, baseConfig);

  const beforePosition = getPosition(bot);
  const beforeVelocity = getVelocity(bot);
  const velocity = getMutableVelocity(bot);
  if (velocity === undefined) {
    throw new Error("bot.entity.velocity unavailable; cannot run velocity（速度） control probe");
  }

  console.log(
    `[probe] before（注入前） ${formatWorld(bot, baseConfig)} pos=${formatPoint(beforePosition)} vel=${formatPoint(beforeVelocity)}`,
  );
  velocity.x += impulse.x;
  velocity.y += impulse.y;
  velocity.z += impulse.z;
  console.log(
    `[probe] injected（已注入） velocity_delta=${formatPoint(impulse)} current_vel=${formatPoint(getVelocity(bot))}`,
  );

  const startedAt = Date.now();
  while (Date.now() - startedAt < baseConfig.durationMs) {
    await delay(100);
    const elapsed = Date.now() - startedAt;
    if (elapsed % 1000 < 100) {
      console.log(
        `[probe] sample（采样） t=${elapsed}ms ${formatWorld(bot, baseConfig)} pos=${formatPoint(getPosition(bot))} vel=${formatPoint(getVelocity(bot))}`,
      );
    }
  }

  const afterPosition = getPosition(bot);
  const movedDistance = horizontalDistance(beforePosition, afterPosition);
  console.log(
    `[probe] verdict（判定） G physics tick（物理帧）推进: ${movedDistance > 0.05 ? "PASS（通过）" : "FAIL（失败）"} horizontal_distance=${movedDistance.toFixed(3)} start=${formatPoint(beforePosition)} end=${formatPoint(afterPosition)}`,
  );
  process.exitCode = movedDistance > 0.05 ? 0 : 2;
} catch (error) {
  fail(error);
} finally {
  if (typeof bot.quit === "function") {
    bot.quit("knockback physics control probe finished");
  } else {
    bot.end("knockback physics control probe finished");
  }
}
