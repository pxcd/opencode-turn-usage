// src/tui.ts
import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createSignal, onCleanup } from "solid-js";

// src/accounting.ts
var tokenKinds = ["input", "cacheRead", "cacheWrite", "output", "reasoning"];
var empty = () => Object.fromEntries(tokenKinds.map((k) => [k, { known: 0, missing: 0 }]));
var valid = (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
function add(rows, model, tokens) {
  const provider = model?.providerID ?? "unknown";
  const id = model?.id ?? "unattributed model";
  let row = rows.find((r) => r.provider === provider && r.model === id);
  if (!row) {
    row = { provider, model: id, calls: 0, tokens: empty() };
    rows.push(row);
  }
  row.calls++;
  const values = {
    input: tokens?.input,
    cacheRead: tokens?.cache?.read,
    cacheWrite: tokens?.cache?.write,
    output: tokens?.output,
    reasoning: tokens?.reasoning
  };
  for (const kind of tokenKinds) {
    const n = values[kind];
    if (valid(n)) row.tokens[kind].known += n;
    else row.tokens[kind].missing++;
  }
}
function messages(snapshot) {
  return [...new Map(snapshot.messages.map((m) => [m.id, m])).values()].filter((m) => !snapshot.info.fork || m.time.created >= snapshot.info.time.created).sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id));
}
function dispatches(m, turnID) {
  return m.content.flatMap((part) => {
    if (part.type !== "tool" || part.name !== "subagent" || part.state.status === "streaming") return [];
    const state = part.state;
    const metadata = "metadata" in state ? state.metadata : void 0;
    const childID = metadata?.sessionID ?? state.input.sessionID;
    if (typeof childID !== "string" || !childID.startsWith("ses_")) return [];
    return [{ childID, at: part.time.created, turnID }];
  });
}
function summarize(rootID, snapshots, initialWarnings = []) {
  const sessions = new Map(snapshots.map((s) => [s.info.id, s]));
  const root = sessions.get(rootID);
  if (!root) throw new Error("Root session is missing");
  const warnings = new Set(initialWarnings);
  const turns = [];
  const totals = [];
  const unattributed = [];
  const visited = /* @__PURE__ */ new Set();
  const links = /* @__PURE__ */ new Map();
  const byTurn = /* @__PURE__ */ new Map();
  const record = (m, turnID) => {
    if (m.type !== "assistant" && (m.type !== "compaction" || m.status === "running")) return;
    const model = "model" in m ? m.model : void 0;
    add(totals, model, m.tokens);
    const turn2 = turnID && byTurn.get(turnID);
    add(turn2 ? turn2.models : unattributed, model, m.tokens);
    if (!turn2) warnings.add("Some recorded calls could not be attributed to a user turn.");
    if (!m.tokens) warnings.add("Some calls have no recorded usage; totals are partial.");
    if (!model) warnings.add("Some recorded calls have no model identity.");
  };
  const link = (m, turnID) => {
    if (m.type !== "assistant") return;
    for (const d of dispatches(m, turnID)) {
      const child = sessions.get(d.childID);
      if (!child || child.info.parentID !== currentSessionID) {
        warnings.add("A subagent link is missing or does not match its parent; attribution is partial.");
        continue;
      }
      const rows = links.get(d.childID) ?? [];
      rows.push(d);
      links.set(d.childID, rows);
    }
  };
  let currentSessionID = rootID;
  let turn;
  for (const m of messages(root)) {
    if (m.type === "user") {
      if (turn?.status === "running") turn.status = "continued";
      turn = { id: m.id, number: turns.length + 1, started: m.time.created, status: "running", models: [] };
      turns.push(turn);
      byTurn.set(turn.id, turn);
    }
    if (m.type === "idle" && turn) turn.status = m.outcome;
    if ((m.type === "assistant" || m.type === "compaction") && turn) turn.status = "running";
    record(m, turn?.id);
    link(m, turn?.id);
  }
  if (turn && (root.info.time.busy ?? 0) > (root.info.time.idle ?? 0)) turn.status = "running";
  visited.add(rootID);
  function visit(parentID) {
    for (const child of snapshots.filter((s) => s.info.parentID === parentID)) {
      const id = child.info.id;
      if (visited.has(id)) {
        warnings.add("A cyclic session family was ignored.");
        continue;
      }
      visited.add(id);
      const calls = (links.get(id) ?? []).sort((a, b) => a.at - b.at);
      let owner;
      let previousPrompt = -Infinity;
      let lastOwner;
      currentSessionID = id;
      for (const m of messages(child)) {
        if (m.type === "user") {
          const candidates = calls.filter((d) => d.at > previousPrompt && d.at <= m.time.created);
          const owners = new Set(candidates.map((d) => d.turnID));
          owner = owners.size === 1 ? candidates[0]?.turnID : void 0;
          if (owners.size > 1) warnings.add("Concurrent follow-ups have ambiguous ownership; their usage is unattributed.");
          previousPrompt = m.time.created;
          lastOwner = owner;
        }
        record(m, owner);
        link(m, owner);
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
  for (const rows of [totals, unattributed, ...turns.map((t) => t.models)]) rows.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  return { rootID, turns, totals, unattributed, warnings: [...warnings], sessionIDs: [...visited] };
}

// src/collector.ts
function redact(m) {
  if (m.type === "user") return { id: m.id, type: m.type, time: m.time, text: "" };
  if (m.type === "assistant") return {
    id: m.id,
    type: m.type,
    time: m.time,
    agent: m.agent,
    model: m.model,
    tokens: m.tokens,
    content: m.content.flatMap((p) => {
      if (p.type !== "tool" || p.name !== "subagent" || p.state.status === "streaming") return [];
      const metadata = "metadata" in p.state ? p.state.metadata : void 0;
      const input = {};
      const link = {};
      if (typeof p.state.input.sessionID === "string") input.sessionID = p.state.input.sessionID;
      if (typeof metadata?.sessionID === "string") link.sessionID = metadata.sessionID;
      return [{ ...p, native: void 0, state: { status: "running", input, metadata: link } }];
    })
  };
  if (m.type === "compaction") return { ...m, summary: "", native: void 0 };
  if (m.type === "idle") return { id: m.id, type: m.type, time: m.time, outcome: m.outcome };
  return { id: m.id, type: "synthetic", time: m.time, text: "" };
}
async function collect(client, rootID, signal) {
  const snapshots = [];
  const warnings = [];
  const seen = /* @__PURE__ */ new Set();
  let pages = 0;
  async function visit(id) {
    signal?.throwIfAborted();
    if (seen.has(id)) return;
    if (seen.size >= 64) {
      warnings.push("Session-family limit reached; totals are partial.");
      return;
    }
    seen.add(id);
    try {
      const info = await client.session.get({ sessionID: id }, { signal });
      const messages2 = [];
      let cursor;
      const cursors = /* @__PURE__ */ new Set();
      do {
        if (++pages > 500) {
          warnings.push("History-page limit reached; totals are partial.");
          break;
        }
        const page = await client.message.list({ sessionID: id, limit: 100, ...cursor ? { cursor } : { order: "asc" } }, { signal });
        messages2.push(...page.data.map(redact));
        cursor = page.cursor.next ?? void 0;
        if (cursor && cursors.has(cursor)) throw new Error("Repeated history cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      snapshots.push({ info, messages: messages2 });
      cursor = void 0;
      cursors.clear();
      do {
        if (++pages > 500) {
          warnings.push("Family-page limit reached; totals are partial.");
          break;
        }
        const page = await client.session.list({ parentID: id, limit: 200, ...cursor ? { cursor } : { order: "asc" } }, { signal });
        for (const child of page.data) {
          if (child.parentID === id) await visit(child.id);
        }
        cursor = page.cursor.next ?? void 0;
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

// src/controller.ts
function watchUsage(input) {
  const abort = new AbortController();
  let family = /* @__PURE__ */ new Set([input.sessionID]);
  let timer;
  let pending = false;
  let working = false;
  let report;
  async function refresh() {
    if (abort.signal.aborted) return;
    if (working) {
      pending = true;
      return;
    }
    working = true;
    input.changed({ report, loading: true });
    try {
      const next = await collect(input.client, input.sessionID, abort.signal);
      if (!abort.signal.aborted) {
        report = next;
        family = new Set(next.sessionIDs);
        input.changed({ report, loading: false });
      }
    } catch {
      if (!abort.signal.aborted) input.changed({ report, loading: false, error: "Usage could not be refreshed; any displayed totals may be stale." });
    } finally {
      working = false;
      if (pending && !abort.signal.aborted) {
        pending = false;
        schedule();
      }
    }
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), input.delay ?? 250);
  }
  const off = input.subscribe((event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    const id = "sessionID" in data && typeof data.sessionID === "string" ? data.sessionID : void 0;
    const parent = "parentID" in data && typeof data.parentID === "string" ? data.parentID : void 0;
    if (!id || !family.has(id) && (!parent || !family.has(parent))) return;
    if (parent && family.has(parent)) family.add(id);
    if (/^session\.(execution\.|step\.(ended|failed)$|compaction\.(ended|failed)$|created$|revert\.|deleted$)/.test(event.type)) schedule();
  });
  void refresh();
  return {
    refresh: () => {
      clearTimeout(timer);
      void refresh();
    },
    dispose: () => {
      abort.abort();
      clearTimeout(timer);
      off();
    }
  };
}

// src/format.ts
var labels = { input: "Uncached in", cacheRead: "Cache read", cacheWrite: "Cache write", output: "Output", reasoning: "Reasoning" };
function count(c) {
  if (!c.missing) return c.known.toLocaleString("en-US");
  return c.known ? `${c.known.toLocaleString("en-US")} + ?` : "unknown";
}
function inputTotal(row) {
  const a = row.tokens;
  return {
    known: a.input.known + a.cacheRead.known + a.cacheWrite.known,
    missing: a.input.missing + a.cacheRead.missing + a.cacheWrite.missing
  };
}
function modelName(row) {
  return `${row.provider}/${row.model}`.replace(/[\x00-\x1f\x7f]/g, "");
}
function compact(turn) {
  if (!turn) return "No recorded user turns";
  return `Turn ${turn.number} \xB7 ${turn.status} \xB7 ` + turn.models.map((row) => `${modelName(row)}: ${count(inputTotal(row))} in / ${count(row.tokens.output)} out / ${count(row.tokens.reasoning)} reasoning`).join(" \xB7 ");
}
function table(rows) {
  return rows.map((row) => `${modelName(row)} (${row.calls} calls)
` + tokenKinds.map((k) => `  ${labels[k]}: ${count(row.tokens[k])}`).join("\n")).join("\n\n") || "No recorded calls";
}
function reportText(report) {
  return [
    ...report.turns.map((turn) => `Turn ${turn.number} \xB7 ${turn.status}
${table(turn.models)}`),
    `Session totals
${table(report.totals)}`,
    ...report.unattributed.length ? [`Unattributed calls (included in session totals)
${table(report.unattributed)}`] : [],
    ...report.warnings
  ].join("\n\n");
}

// src/tui.ts
var tui_default = Plugin.define({
  id: "turn-usage",
  setup(ctx) {
    const [state, setState] = createSignal({ loading: false });
    let refresh = () => {
    };
    createEffect(() => {
      const route = ctx.ui.router.current();
      setState({ loading: false });
      if (route.type !== "session") return;
      const watcher = watchUsage({
        client: ctx.client,
        sessionID: route.sessionID,
        subscribe: (listener) => ctx.data.listen((event) => listener(event.details)),
        changed: setState
      });
      refresh = watcher.refresh;
      onCleanup(() => {
        watcher.dispose();
        refresh = () => {
        };
      });
    });
    const off = ctx.ui.slot({ append: "sidebar.footer", render: (input) => {
      const value = state();
      const route = ctx.ui.router.current();
      if (route.type !== "session" || route.sessionID !== input.sessionID) return "";
      if (!value.report) return value.error ? "Turn usage: unavailable" : "Turn usage: loading\u2026";
      if (value.report.rootID !== input.sessionID) return "";
      return value.error ? "Turn usage: stale/unavailable" : compact(value.report.turns.at(-1));
    } });
    ctx.keymap.layer(() => ({ commands: [{
      id: "turn-usage.show",
      title: "Show per-turn token usage",
      palette: true,
      slash: { name: "turn-usage" },
      run: () => {
        const value = state();
        void ctx.ui.dialog.alert({ title: "Token usage by turn and model", message: value.report ? reportText(value.report) + (value.error ? `

${value.error}` : "") : value.error ?? "Usage has not loaded yet." });
      }
    }, { id: "turn-usage.refresh", title: "Refresh token usage", palette: true, run: () => refresh() }] }));
    return off;
  }
});
export {
  tui_default as default
};
