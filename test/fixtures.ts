import type { SessionInfo, SessionMessageInfo, SessionMessageAssistant, TokenUsageInfo } from "@opencode/client/promise";
import type { SessionSnapshot } from "../src/accounting.js";
import type { UsageClient } from "../src/collector.js";
export const usage = (input = 10, output = 2): TokenUsageInfo => ({ input, output, reasoning: 3, cache: { read: 100, write: 5 } });
export const sol = { providerID: "openai", id: "gpt-6.1-sol" };
export const qwen = { providerID: "lmstudio", id: "qwen" };
export function user(id: string, at: number): SessionMessageInfo { return { type: "user", id, time: { created: at }, text: "PRIVATE PROMPT" }; }
export function assistant(id: string, at: number, tokens: TokenUsageInfo | undefined = usage(), model = sol, content: SessionMessageAssistant["content"] = []): SessionMessageAssistant {
  return { type: "assistant", id, agent: "fixture", time: { created: at, completed: at + 1 }, tokens, model, content };
}
export function tool(id: string, childID: string, at: number): SessionMessageAssistant["content"][number] {
  return { type: "tool", id, name: "subagent", time: { created: at, completed: at + 2 }, state: { status: "completed", input: { prompt: "PRIVATE TOOL INPUT" }, metadata: { sessionID: childID }, content: [{ type: "text", text: "PRIVATE OUTPUT" }] } };
}
export function idle(id: string, at: number, outcome: "succeeded" | "failed" | "interrupted" = "succeeded"): SessionMessageInfo {
  return { id, type: "idle", time: { created: at }, outcome };
}
export function info(id: string, parentID?: string): SessionInfo {
  return { id, parentID, projectID: "project_fixture", cost: 0, tokens: usage(0, 0), location: { directory: "/fixture" }, time: { created: 0, updated: 999, busy: 0, idle: 999 } };
}
export function snapshot(id: string, messages: SessionMessageInfo[], parentID?: string): SessionSnapshot { return { info: info(id, parentID), messages }; }
export function fakeClient(snapshots: SessionSnapshot[], pageSize = 100) {
  const calls: string[] = [];
  const index = new Map(snapshots.map(s => [s.info.id, s]));
  const client = {
    session: {
      async get({ sessionID }: { sessionID: string }) {
        calls.push(`get:${sessionID}`); const s = index.get(sessionID); if (!s) throw new Error("missing"); return s.info;
      },
      async list({ parentID, cursor }: { parentID: string; cursor?: string }) {
        calls.push(`children:${parentID}`); const rows = snapshots.filter(s => s.info.parentID === parentID).map(s => s.info);
        const start = Number(cursor ?? 0); const data = rows.slice(start, start + pageSize);
        return { data, cursor: { next: start + pageSize < rows.length ? String(start + pageSize) : undefined } };
      },
    },
    message: { async list({ sessionID, cursor }: { sessionID: string; cursor?: string }) {
      calls.push(`messages:${sessionID}`); const rows = index.get(sessionID)!.messages;
      const start = Number(cursor ?? 0); const data = rows.slice(start, start + pageSize);
      return { data, cursor: { next: start + pageSize < rows.length ? String(start + pageSize) : undefined } };
    } },
  } as unknown as UsageClient;
  return { client, calls };
}
