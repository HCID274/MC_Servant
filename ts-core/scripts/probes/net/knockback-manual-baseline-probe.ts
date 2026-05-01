import process from "node:process";
import {
  parseBooleanText,
  readFlags,
  readOptionalStringFlag,
  readStringFlag,
} from "./knockback-probe-common.js";

const flags = readFlags(process.argv.slice(2));
const caseName = readStringFlag(flags, process.env, "case", "MC_BASELINE_CASE", "vanilla-client");
const worldLabel = readStringFlag(flags, process.env, "world-label", "MC_WORLD_LABEL", "unknown");
const dimension = readStringFlag(flags, process.env, "dimension", "MC_DIMENSION", "unknown");
const attacker = readStringFlag(flags, process.env, "attacker", "MC_ATTACKER", "player");
const observedBack = parseBooleanText(
  readOptionalStringFlag(flags, process.env, "observed-back", "MC_OBSERVED_BACK"),
);
const notes = readOptionalStringFlag(flags, process.env, "notes", "MC_BASELINE_NOTES") ?? "";

console.log("[probe] 我在排除哪一环: A 伤害判定与 B 服务端 knockback（击退）计算的人工对照。");
console.log(
  "[probe] 该脚本不连接 Mineflayer（Minecraft 协议客户端），只把原版客户端/怪物攻击对照固化为结构化证据。",
);

const evidence = {
  kind: "knockback_manual_baseline",
  case_id: caseName,
  world_label: worldLabel,
  dimension,
  attacker_type: attacker,
  observed_back: observedBack ?? null,
  pass_fail:
    observedBack === undefined ? "UNKNOWN（未知）" : observedBack ? "PASS（通过）" : "FAIL（失败）",
  notes,
  recorded_at: new Date().toISOString(),
};

console.log(JSON.stringify(evidence, null, 2));
if (observedBack === undefined) {
  console.log("[probe] verdict（判定） 缺少 --observed-back true|false，不能作为最终证据。");
  process.exitCode = 2;
} else {
  process.exitCode = observedBack ? 0 : 1;
}
