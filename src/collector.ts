import type { OpenCodeClient, SessionMessageInfo } from "@opencode/client/promise";
import { summarize, type SessionSnapshot, type UsageReport } from "./accounting.js";
export type UsageClient = Pick<OpenCodeClient, "session" | "message">;

// Keep only accounting and causal-link fields. No prompts, responses, files, credentials or tool output are persisted.
function redact(m: SessionMessageInfo): SessionMessageInfo {
  if (m.type === "user") return { id: m.id, type: m.type, time: m.time, text: "" };
  if (m.type === "assistant") return {
    id: m.id, type: m.type, time: m.time, agent: m.agent, model: m.model, tokens: m.tokens,
    content: m.content.flatMap(p => {
      if (p.type !== "tool" || p.name !== "subagent" || p.state.status === "streaming") return [];
      const metadata = "metadata" in p.state ? p.state.metadata : undefined;
      const input: Record<string, string> = {};
      const link: Record<string, string> = {};
      if (typeof p.state.input.sessionID === "string") input.sessionID = p.state.input.sessionID;
      if (typeof metadata?.sessionID === "string") link.sessionID = metadata.sessionID;
      return [{ ...p, native: undefined, state: { status: "running" as const, input, metadata: link } }];
    }),
  };
  if (m.type === "compaction") return { ...m, summary: "", native: undefined } as SessionMessageInfo;
  if (m.type === "idle") return { id: m.id, type: m.type, time: m.time, outcome: m.outcome };
  return { id: m.id, type: "synthetic", time: m.time, text: "" };
}

export async function collect(client: UsageClient, rootID: string, signal?: AbortSignal): Promise<UsageReport> {
  const snapshots: SessionSnapshot[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let pages = 0;
  async function visit(id: string) {
    signal?.throwIfAborted();
    if (seen.has(id)) return;
    if (seen.size >= 64) { warnings.push("Session-family limit reached; totals are partial."); return; }
    seen.add(id);
    try {
      const info = await client.session.get({ sessionID: id }, { signal });
      const messages: SessionMessageInfo[] = [];
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        if (++pages > 500) { warnings.push("History-page limit reached; totals are partial."); break; }
        const page = await client.message.list({ sessionID: id, limit: 100, order: "asc", cursor }, { signal });
        messages.push(...page.data.map(redact));
        cursor = page.cursor.next ?? undefined;
        if (cursor && cursors.has(cursor)) throw new Error("Repeated history cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      snapshots.push({ info, messages });
      cursor = undefined;
      cursors.clear();
      do {
        if (++pages > 500) { warnings.push("Family-page limit reached; totals are partial."); break; }
        const page = await client.session.list({ parentID: id, limit: 200, order: "asc", cursor }, { signal });
        for (const child of page.data) {
          if (child.parentID === id) await visit(child.id);
        }
        cursor = page.cursor.next ?? undefined;
        if (cursor && cursors.has(cursor)) throw new Error("Repeated family cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
    } catch (error) {
      if (signal?.aborted || id === rootID) throw error;
      warnings.push("A child session could not be read completely; totals are partial.");
    }
  }
  await visit(rootID);
  return summarize(rootID, snapshots, warnings);
}
