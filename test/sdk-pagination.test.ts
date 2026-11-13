import test from "node:test";
import assert from "node:assert/strict";
import { OpenCode } from "@opencode/client/promise";
import { collect } from "../src/collector.js";
import { user, assistant, idle, info } from "./fixtures.js";

test("real SDK serializes valid first-page and cursor-page queries for history and families", async () => {
  const queries: string[] = [];
  const client = OpenCode.make({ baseUrl: "http://fixture.invalid", fetch: async (input, init) => {
    assert.equal(init?.method ?? "GET", "GET");
    const url = new URL(input instanceof Request ? input.url : String(input));
    queries.push(url.pathname + url.search);
    if (url.searchParams.has('cursor') && url.searchParams.has('order')) {
      return Response.json({ _tag: "InvalidCursorError", message: "Cursor cannot be combined with order" }, { status: 400 });
    }
    const cursor = url.searchParams.get('cursor');
    if (url.pathname.endsWith('/message')) {
      return Response.json(cursor ? { data: [assistant("msg_a", 2), idle("msg_i", 3)], cursor: {} }
        : { data: [user("msg_u", 1)], cursor: { next: "history-page-2" } });
    }
    if (url.pathname === '/api/session') return Response.json({ data: [], cursor: cursor ? {} : { next: "family-page-2" } });
    return Response.json({ data: info("ses_root") });
  } });
  const report = await collect(client, 'ses_root');
  assert.equal(report.totals[0]!.calls, 1);
  assert.equal(queries.length, 5);
  assert.ok(queries.some(q => q.includes('order=asc')));
  assert.ok(queries.some(q => q.includes('cursor=history-page-2')));
  assert.ok(queries.some(q => q.includes('cursor=family-page-2')));
});
