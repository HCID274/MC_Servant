import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  type ProductionMetricReport,
  type ProductionMetricReportFilters,
  type ProductionMetricReportGroup,
  createProductionMetricReport,
  parseProductionMetricJsonlLines,
} from "../../src/diagnostics/index.js";

const DEFAULT_METRICS_DIR = "logs/metrics";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const filters = createFilters(args);
  const metricsDir = resolve(DEFAULT_METRICS_DIR);
  const files = await listProductionMetricFiles(metricsDir);
  const events = (
    await Promise.all(
      files.map(async (filePath) =>
        parseProductionMetricJsonlLines(await readFile(filePath, "utf8"), filePath),
      ),
    )
  ).flat();
  const report = createProductionMetricReport({
    events,
    filters,
  });

  printReport(report);

  if (args.out !== undefined) {
    const outputPath = resolve(args.out);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`summary_json=${outputPath}\n`);
  }
}

function createFilters(args: Readonly<Record<string, string>>): ProductionMetricReportFilters {
  return {
    ...(args.from === undefined ? {} : { from: args.from }),
    ...(args.to === undefined ? {} : { to: args.to }),
    ...(args.bot_id === undefined ? {} : { bot_id: args.bot_id }),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.prompt_version === undefined ? {} : { prompt_version: args.prompt_version }),
  };
}

async function listProductionMetricFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (isNodeErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        return listProductionMetricFiles(fullPath);
      }
      if (!entry.isFile() || entry.name !== "production-metrics.jsonl") {
        return [];
      }
      const fileStat = await stat(fullPath);
      return fileStat.size === 0 ? [] : [fullPath];
    }),
  );

  return Object.freeze(files.flat().sort((left, right) => left.localeCompare(right)));
}

function printReport(report: ProductionMetricReport): void {
  process.stdout.write(`production_metric_events=${report.event_count}\n`);
  process.stdout.write(`generated_at=${report.generated_at}\n`);
  process.stdout.write(`resume_summary_zh=${report.resume_summary_zh}\n\n`);

  console.table(createMetricRows(report.groups));
}

function createMetricRows(
  groups: readonly ProductionMetricReportGroup[],
): readonly Record<string, string | number>[] {
  return groups.flatMap((group) => [
    ...group.metrics.llm.map((metric) => ({
      group_by: group.group_by,
      group_value: group.group_value,
      event_count: group.event_count,
      metric: metric.name,
      value: formatMetricValue(metric.value),
      numerator: metric.numerator,
      denominator: metric.denominator,
    })),
    ...group.metrics.execution.map((metric) => ({
      group_by: group.group_by,
      group_value: group.group_value,
      event_count: group.event_count,
      metric: metric.name,
      value: formatMetricValue(metric.value),
      numerator: metric.numerator,
      denominator: metric.denominator,
    })),
    ...group.metrics.recovery.map((metric) => ({
      group_by: group.group_by,
      group_value: group.group_value,
      event_count: group.event_count,
      metric: metric.name,
      value: formatMetricValue(metric.value),
      numerator: metric.numerator,
      denominator: metric.denominator,
    })),
  ]);
}

function formatMetricValue(value: number | null): string {
  return value === null ? "null" : Number(value.toFixed(6)).toString();
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

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code: unknown }).code === code
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`production_metrics_summary_failed=${message}\n`);
  process.exitCode = 1;
});
