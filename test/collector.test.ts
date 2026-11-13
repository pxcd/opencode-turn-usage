import test from "node:test";
import assert from "node:assert/strict";
import { collect } from "../src/collector.js";
import { watchUsage, type UsageEvent, type UsageState } from "../src/controller.js";
import { assistant as a, user as u, snapshot as s, tool, usage, idle, fakeClient, qwen } from "./fixtures.js";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const root = () => s("ses_root", [u("msg_u", 1), a("msg_a", 2, usage(), undefined, [tool("t", "ses_c", 3)]), idle("msg_i", 7)]);
const child = () => s("ses_c", [u("msg_cu", 4), a("msg_ca", 5, usage(100), qwen)], "ses_root");

test("read-only collector paginates root/children and returns no prompt/tool text", async () => {
  const { client, calls } = fakeClient([root(), child()], 1);
  const report = await collect(client, "ses_root");
  assert.equal(report.totals.length, 2); assert.equal(report.turns[0]!.models.length, 2);
  assert.ok(calls.filter(c => c === "messages:ses_root").length === 3);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
  assert.ok(calls.every(c => /^(get|messages|children):/.test(c)));
});

test("unreadable child produces partial warning; root failures reject", async () => {
  const { client } = fakeClient([root(), child()]);
  const get = client.session.get; client.session.get = async (input, options) => { if (input.sessionID === "ses_c") throw new Error("private backend details"); return get(input, options); };
  const report = await collect(client, "ses_root"); assert.match(report.warnings.join(" "), /partial/);
  await assert.rejects(collect(client, "ses_missing"));
});

test("abort is respected before making any API read", async () => {
  const { client, calls } = fakeClient([root()]); const abort = new AbortController(); abort.abort();
  await assert.rejects(collect(client, "ses_root", abort.signal)); assert.equal(calls.length, 0);
});

test("repeated pagination cursors cannot cause an infinite loop", async () => {
  const { client } = fakeClient([root()]);
  client.message.list = async () => ({ data: [], cursor: { next: "same" } });
  await assert.rejects(collect(client, "ses_root"), /Repeated history cursor/);
});

test("controller ignores token streaming and unrelated sessions, batches terminal events, disposes", async () => {
  const { client, calls } = fakeClient([root(), child()]); let listener!: (event: UsageEvent) => void;
  let off = false; const states: UsageState[] = [];
  const watcher = watchUsage({ client, sessionID: "ses_root", subscribe: fn => { listener = fn; return () => { off = true; }; }, changed: v => states.push(v), delay: 5 });
  await sleep(20); const initial = calls.length;
  for (let i = 0; i < 100; i++) listener({ type: "session.text.delta", data: { sessionID: "ses_root" } });
  listener({ type: "session.execution.succeeded", data: { sessionID: "ses_unrelated" } });
  await sleep(15); assert.equal(calls.length, initial);
  for (let i = 0; i < 20; i++) listener({ type: "session.step.ended", data: { sessionID: "ses_c" } });
  await sleep(20); assert.equal(calls.length, initial * 2);
  watcher.dispose(); assert.ok(off); const count = states.length;
  listener({ type: "session.execution.succeeded", data: { sessionID: "ses_root" } });
  await sleep(15); assert.equal(states.length, count);
});


test("child-session pagination follows cursor without repeating order", async () => {
  const children = Array.from({ length: 3 }, (_, i) => s(`ses_child${i}`, [u(`msg_cu${i}`, i + 3), a(`msg_ca${i}`, i + 4, usage(), qwen)], "ses_root"));
  const { client, calls } = fakeClient([s("ses_root", [u("msg_u", 1)]), ...children], 1);
  const report = await collect(client, "ses_root");
  assert.equal(report.sessionIDs.length, 4);
  assert.equal(calls.filter(c => c === "children:ses_root").length, 3);
  assert.equal(report.totals[0]!.calls, 3);
  assert.ok(!report.warnings.some(w => /could not be read/.test(w)));
});

test("long multi-page chats include every recorded call exactly once", async () => {
  const messages = [u("msg_u", 1), ...Array.from({ length: 205 }, (_, i) => a(`msg_a${String(i).padStart(4, "0")}`, i + 2)), idle("msg_i", 208)];
  const { client, calls } = fakeClient([s("ses_root", messages)], 100);
  const report = await collect(client, "ses_root");
  assert.equal(report.totals[0]!.calls, 205);
  assert.equal(report.totals[0]!.tokens.input.known, 2050);
  assert.equal(calls.filter(c => c === "messages:ses_root").length, 3);
});
