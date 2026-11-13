import test from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../src/accounting.js";
import { compact, count, inputTotal, reportText } from "../src/format.js";
import { assistant as a, user as u, snapshot as s, tool, usage, idle, qwen } from "./fixtures.js";

test("separates cache/visible output/reasoning, sums tool loops, and groups by user turn", () => {
  const report = summarize("ses_root", [s("ses_root", [u("msg_u1", 1), a("msg_a1", 2), a("msg_a2", 3), idle("msg_i1", 4), u("msg_u2", 5), a("msg_a3", 6), idle("msg_i2", 7)])]);
  assert.equal(report.turns.length, 2);
  const row = report.turns[0]!.models[0]!;
  assert.equal(row.calls, 2); assert.equal(row.tokens.input.known, 20); assert.equal(row.tokens.cacheRead.known, 200);
  assert.equal(row.tokens.cacheWrite.known, 10); assert.equal(row.tokens.output.known, 4); assert.equal(row.tokens.reasoning.known, 6);
  assert.equal(inputTotal(row).known, 230); assert.equal(report.totals[0]!.calls, 3);
  assert.equal(report.turns[0]!.status, "succeeded");
});

test("resumed child and nested QA stay with their initiating turns, not completion timestamps", () => {
  const root = s("ses_root", [u("msg_u1", 1), a("msg_a1", 2, usage(), undefined, [tool("t1", "ses_child", 3)]), idle("msg_i1", 6),
    u("msg_u2", 10), a("msg_a2", 11, usage(), undefined, [tool("t2", "ses_child", 12)]), idle("msg_i2", 20)]);
  const child = s("ses_child", [u("msg_cu1", 4), a("msg_ca1", 5, usage(100, 20), qwen, [tool("t3", "ses_qa", 5)]),
    u("msg_cu2", 13), a("msg_ca2", 14, usage(200, 30), qwen)], "ses_root");
  const qa = s("ses_qa", [u("msg_qu", 6), a("msg_qa", 19, usage(50, 5), qwen)], "ses_child");
  const report = summarize("ses_root", [root, child, qa]);
  assert.equal(report.turns[0]!.models.find(r => r.provider === "lmstudio")!.tokens.input.known, 150);
  assert.equal(report.turns[1]!.models.find(r => r.provider === "lmstudio")!.tokens.input.known, 200);
  assert.equal(report.totals.find(r => r.provider === "lmstudio")!.calls, 3);
});

test("duplicate IDs are replacements; retries with distinct recorded IDs are separate calls", () => {
  const report = summarize("ses_root", [s("ses_root", [u("msg_u", 1), a("msg_a", 2, usage(3)), a("msg_a", 2, usage(9)), a("msg_retry", 3, usage(5))])]);
  assert.equal(report.totals[0]!.calls, 2); assert.equal(report.totals[0]!.tokens.input.known, 14);
});

test("missing/invalid counters remain unknown, never silently zero", () => {
  const missing = a("msg_missing", 3); delete missing.tokens;
  const bad = usage(-10, NaN);
  const report = summarize("ses_root", [s("ses_root", [u("msg_u", 1), a("msg_known", 2), missing, a("msg_bad", 4, bad)])]);
  const row = report.totals[0]!;
  assert.equal(count(row.tokens.input), "10 + ?"); assert.equal(row.tokens.input.missing, 2);
  assert.equal(count({ known: 0, missing: 1 }), "unknown"); assert.equal(count({ known: 0, missing: 0 }), "0");
});

test("pre-prompt maintenance, failed compaction without model, and unlinked children are explicit", () => {
  const root = s("ses_root", [a("msg_orphan", 0), u("msg_u", 1), { type: "compaction", id: "msg_compact", time: { created: 2 }, status: "completed", reason: "auto", summary: "", tokens: usage(12), model: qwen }, idle("msg_i", 3, "interrupted")]);
  const child = s("ses_unlinked", [u("msg_cu", 2), a("msg_ca", 3, usage(99), qwen)], "ses_root");
  const report = summarize("ses_root", [root, child]);
  assert.equal(report.unattributed.reduce((n, r) => n + r.calls, 0), 2);
  assert.equal(report.turns[0]!.status, "interrupted");
  assert.equal(report.turns[0]!.models[0]!.tokens.input.known, 12);
  assert.match(reportText(report), /Unattributed calls/);
});

test("overlapping dispatches from different user turns are unattributed", () => {
  const root = s("ses_root", [u("msg_u1", 1), a("msg_a1", 2, usage(), undefined, [tool("t1", "ses_c", 3)]), u("msg_u2", 4), a("msg_a2", 5, usage(), undefined, [tool("t2", "ses_c", 6)])]);
  const report = summarize("ses_root", [root, s("ses_c", [u("msg_cu", 7), a("msg_ca", 8, usage(), qwen)], "ses_root")]);
  assert.equal(report.unattributed[0]!.provider, "lmstudio"); assert.match(report.warnings.join(" "), /ambiguous/);
});

test("fork-inherited history is excluded and model identity includes provider", () => {
  const root = s("ses_root", [u("msg_old_u", 1), a("msg_old_a", 2), u("msg_u", 11), a("msg_a", 12), a("msg_b", 13, usage(), { providerID: "proxy", id: "gpt-6.1-sol" })]);
  root.info.fork = { sessionID: "ses_old", boundary: { messageID: "msg_old_a" } } as NonNullable<typeof root.info.fork>;
  root.info.time.created = 10;
  const report = summarize("ses_root", [root]); assert.equal(report.turns.length, 1); assert.equal(report.totals.length, 2);
  assert.equal(report.totals.reduce((n, r) => n + r.calls, 0), 2);
});

test("background child keeps its initiating turn provisional", () => {
  const child = s("ses_c", [u("msg_cu", 4), a("msg_ca", 5, usage(), qwen)], "ses_root");
  child.info.time.busy = 4; child.info.time.idle = undefined;
  const report = summarize("ses_root", [s("ses_root", [u("msg_u", 1), a("msg_a", 2, usage(), undefined, [tool("t", "ses_c", 3)]), idle("msg_i", 6)]), child]);
  assert.equal(report.turns[0]!.status, "running"); assert.match(compact(report.turns[0]), /running/);
});
