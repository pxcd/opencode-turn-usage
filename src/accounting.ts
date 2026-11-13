import type { SessionInfo, SessionMessageInfo, SessionMessageAssistant, TokenUsageInfo } from "@opencode/client/promise";

export const tokenKinds = ["input", "cacheRead", "cacheWrite", "output", "reasoning"] as const;
export type TokenKind = typeof tokenKinds[number];
export type Counter = { known: number; missing: number };
export type Counters = Record<TokenKind, Counter>;
export interface ModelUsage { provider: string; model: string; calls: number; tokens: Counters }
export interface Turn {
  id: string;
  number: number;
  started: number;
  status: "running" | "continued" | "succeeded" | "failed" | "interrupted";
  models: ModelUsage[];
}
export interface SessionSnapshot {
  info: Pick<SessionInfo, "id" | "parentID" | "time" | "fork" | "tokens" | "revert">;
  messages: readonly SessionMessageInfo[];
}
export interface UsageReport {
  rootID: string;
  turns: Turn[];
  totals: ModelUsage[];
  unattributed: ModelUsage[];
  warnings: string[];
  sessionIDs: string[];
}
interface Dispatch { childID: string; at: number; turnID?: string }
const empty = (): Counters => Object.fromEntries(tokenKinds.map(k => [k, { known: 0, missing: 0 }])) as Counters;
const valid = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

function add(rows: ModelUsage[], model: { id: string; providerID: string } | undefined, tokens: TokenUsageInfo | undefined) {
  const provider = model?.providerID ?? "unknown";
  const id = model?.id ?? "unattributed model";
  let row = rows.find(r => r.provider === provider && r.model === id);
  if (!row) { row = { provider, model: id, calls: 0, tokens: empty() }; rows.push(row); }
  row.calls++;
  const values = { input: tokens?.input, cacheRead: tokens?.cache?.read, cacheWrite: tokens?.cache?.write,
    output: tokens?.output, reasoning: tokens?.reasoning };
  for (const kind of tokenKinds) {
    const n = values[kind];
    if (valid(n)) row.tokens[kind].known += n;
    else row.tokens[kind].missing++;
  }
}

function messages(snapshot: SessionSnapshot): SessionMessageInfo[] {
  // Pagination can repeat a boundary. The latest snapshot for an ID wins, never sums.
  return [...new Map(snapshot.messages.map(m => [m.id, m])).values()]
    .filter(m => !snapshot.info.fork || m.time.created >= snapshot.info.time.created)
    .sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id));
}

function dispatches(m: SessionMessageAssistant, turnID?: string): Dispatch[] {
  return m.content.flatMap(part => {
    if (part.type !== "tool" || part.name !== "subagent" || part.state.status === "streaming") return [];
    const state = part.state;
    const metadata = "metadata" in state ? state.metadata : undefined;
    const childID = metadata?.sessionID ?? state.input.sessionID;
    if (typeof childID !== "string" || !childID.startsWith("ses_")) return [];
    return [{ childID, at: part.time.created, turnID }];
  });
}

export function summarize(rootID: string, snapshots: readonly SessionSnapshot[], initialWarnings: readonly string[] = []): UsageReport {
  const sessions = new Map(snapshots.map(s => [s.info.id, s]));
  const root = sessions.get(rootID);
  if (!root) throw new Error("Root session is missing");
  const warnings = new Set(initialWarnings);
  const turns: Turn[] = [];
  const totals: ModelUsage[] = [];
  const unattributed: ModelUsage[] = [];
  const visited = new Set<string>();
  const links = new Map<string, Dispatch[]>();
  const byTurn = new Map<string, Turn>();
  const record = (m: SessionMessageInfo, turnID?: string) => {
    if (m.type !== "assistant" && (m.type !== "compaction" || m.status === "running")) return;
    const model = "model" in m ? m.model : undefined;
    add(totals, model, m.tokens);
    const turn = turnID && byTurn.get(turnID);
    add(turn ? turn.models : unattributed, model, m.tokens);
    if (!turn) warnings.add("Some recorded calls could not be attributed to a user turn.");
    if (!m.tokens) warnings.add("Some calls have no recorded usage; totals are partial.");
    if (!model) warnings.add("Some recorded calls have no model identity.");
  };
  const link = (m: SessionMessageInfo, turnID?: string) => {
    if (m.type !== "assistant") return;
    for (const d of dispatches(m, turnID)) {
      const child = sessions.get(d.childID);
      if (!child || child.info.parentID !== currentSessionID) {
        warnings.add("A subagent link is missing or does not match its parent; attribution is partial.");
        continue;
      }
      const rows = links.get(d.childID) ?? [];
      rows.push(d); links.set(d.childID, rows);
    }
  };
  let currentSessionID = rootID;
  let turn: Turn | undefined;
  for (const m of messages(root)) {
    if (m.type === "user") {
      if (turn?.status === "running") turn.status = "continued";
      turn = { id: m.id, number: turns.length + 1, started: m.time.created, status: "running", models: [] };
      turns.push(turn); byTurn.set(turn.id, turn);
    }
    if (m.type === "idle" && turn) turn.status = m.outcome;
    if ((m.type === "assistant" || m.type === "compaction") && turn) turn.status = "running";
    record(m, turn?.id); link(m, turn?.id);
  }
  if (turn && (root.info.time.busy ?? 0) > (root.info.time.idle ?? 0)) turn.status = "running";
  visited.add(rootID);

  function visit(parentID: string) {
    for (const child of snapshots.filter(s => s.info.parentID === parentID)) {
      const id = child.info.id;
      if (visited.has(id)) { warnings.add("A cyclic session family was ignored."); continue; }
      visited.add(id);
      const calls = (links.get(id) ?? []).sort((a, b) => a.at - b.at);
      let owner: string | undefined;
      let previousPrompt = -Infinity;
      let lastOwner: string | undefined;
      currentSessionID = id;
      for (const m of messages(child)) {
        if (m.type === "user") {
          // Resumed workers are attributed per dispatch, not by child lifetime or completion time.
          const candidates = calls.filter(d => d.at > previousPrompt && d.at <= m.time.created);
          const owners = new Set(candidates.map(d => d.turnID));
          owner = owners.size === 1 ? candidates[0]?.turnID : undefined;
          if (owners.size > 1) warnings.add("Concurrent follow-ups have ambiguous ownership; their usage is unattributed.");
          previousPrompt = m.time.created;
          lastOwner = owner;
        }
        record(m, owner); link(m, owner);
      }
      if ((child.info.time.busy ?? 0) > (child.info.time.idle ?? 0) && lastOwner) {
        const active = byTurn.get(lastOwner);
        if (active) active.status = "running";
      }
      visit(id);
      currentSessionID = parentID;
    }
  }
  visit(rootID);
  if (root.info.revert) warnings.add("A reverted transcript may omit earlier usage; this is recorded visible-history usage, not a billing ledger.");
  for (const rows of [totals, unattributed, ...turns.map(t => t.models)]) rows.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  return { rootID, turns, totals, unattributed, warnings: [...warnings], sessionIDs: [...visited] };
}
