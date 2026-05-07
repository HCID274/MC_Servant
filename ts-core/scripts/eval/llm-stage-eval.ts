import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  createConversationLlmClient,
  createConversationLlmConfig,
  runConversationLlmEvalCases,
} from "../../src/conversation/llm/index.js";
import type { EvalRunConfigSummary } from "../../src/data/contracts/index.js";
import {
  parseEvalCaseJsonlLines,
  serializeEvalJsonlLine,
} from "../../src/diagnostics/index.js";

const DEFAULT_CASES_PATH = "scripts/eval/cases/llm-stage-cases.jsonl";
const DEFAULT_BASE_URL = "http://127.0.0.1:8045/v1";
const DEFAULT_API_KEY = "sk-local-dev";
const DEFAULT_MODEL = "bl-auto";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const casesPath = resolve(args.cases ?? DEFAULT_CASES_PATH);
  const baseUrl = args.base_url ?? process.env.LLM_BASE_URL ?? DEFAULT_BASE_URL;
  const apiKey = args.api_key ?? process.env.LLM_API_KEY ?? DEFAULT_API_KEY;
  const model = args.model ?? process.env.LLM_MODEL ?? DEFAULT_MODEL;
  const runId = args.run_id ?? createRunId(new Date());
  const outputPath = resolve(args.out ?? `logs/eval/${new Date().toISOString().slice(0, 10)}/${runId}.jsonl`);
  const cases = parseEvalCaseJsonlLines(await readFile(casesPath, "utf8"));
  const config = createConversationLlmConfig({
    base_url: baseUrl,
    api_key: apiKey,
    model,
    bot_name: "Bot",
    owner_name: "主人",
    timeout_ms: Number.parseInt(args.timeout_ms ?? process.env.LLM_TIMEOUT_MS ?? "15000", 10),
  });
  const runConfig: EvalRunConfigSummary = {
    base_url: config.base_url,
    model: config.model,
    api_key: "<redacted>",
    cases_ref: casesPath,
  };
  const lines = await runConversationLlmEvalCases({
    cases,
    client: createConversationLlmClient(config),
    run_id: runId,
    config: runConfig,
  });
  const content = `${lines.map((line) => serializeEvalJsonlLine(line, [apiKey])).join("\n")}\n`;

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, "utf8");
  process.stdout.write(`eval_run_id=${runId}\n`);
  process.stdout.write(`eval_cases=${cases.length}\n`);
  process.stdout.write(`eval_output=${outputPath}\n`);
}

function parseArgs(args: readonly string[]): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2).replace(/-/g, "_");
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      result[key] = "true";
      continue;
    }

    result[key] = next;
    index += 1;
  }

  return result;
}

function createRunId(now: Date): string {
  return `eval-${now.toISOString().replace(/[:.]/g, "-")}`;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`eval_failed=${message}\n`);
  process.exitCode = 1;
});
