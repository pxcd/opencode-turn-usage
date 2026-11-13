import { tokenKinds, type Counter, type ModelUsage, type UsageReport, type Turn } from "./accounting.js";
export const labels = { input: "Uncached in", cacheRead: "Cache read", cacheWrite: "Cache write", output: "Output", reasoning: "Reasoning" };
export function count(c: Counter): string {
  if (!c.missing) return c.known.toLocaleString("en-US");
  return c.known ? `${c.known.toLocaleString("en-US")} + ?` : "unknown";
}
export function inputTotal(row: ModelUsage): Counter {
  const a = row.tokens;
  return { known: a.input.known + a.cacheRead.known + a.cacheWrite.known,
    missing: a.input.missing + a.cacheRead.missing + a.cacheWrite.missing };
}
export function modelName(row: ModelUsage): string { return `${row.provider}/${row.model}`.replace(/[\x00-\x1f\x7f]/g, ""); }
export function compact(turn?: Turn): string {
  if (!turn) return "No recorded user turns";
  return `Turn ${turn.number} · ${turn.status} · ` + turn.models.map(row => `${modelName(row)}: ${count(inputTotal(row))} in / ${count(row.tokens.output)} out / ${count(row.tokens.reasoning)} reasoning`).join(" · ");
}
export function table(rows: readonly ModelUsage[]): string {
  return rows.map(row => `${modelName(row)} (${row.calls} calls)\n` + tokenKinds.map(k => `  ${labels[k]}: ${count(row.tokens[k])}`).join("\n")).join("\n\n") || "No recorded calls";
}
export function reportText(report: UsageReport): string {
  return [...report.turns.map(turn => `Turn ${turn.number} · ${turn.status}\n${table(turn.models)}`),
    `Session totals\n${table(report.totals)}`,
    ...(report.unattributed.length ? [`Unattributed calls (included in session totals)\n${table(report.unattributed)}`] : []),
    ...report.warnings].join("\n\n");
}
