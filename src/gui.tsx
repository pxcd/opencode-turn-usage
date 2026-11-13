import { Command, Panel, Plugin, Slot, createKeyed } from "@opencode/plugin/gui";
import { For, Show, createSignal, onCleanup } from "solid-js";
import { watchUsage, type UsageState } from "./controller.js";
import { tokenKinds, type ModelUsage } from "./accounting.js";
import { compact, count, inputTotal, labels, modelName } from "./format.js";

const tab = { id: "usage", title: "Turn usage" };
const cell = { padding: "6px 10px", "text-align": "right", "white-space": "nowrap", "font-variant-numeric": "tabular-nums" } as const;
function UsageTable(props: { rows: readonly ModelUsage[] }) {
  return <div style={{ "overflow-x": "auto" }}><table style={{ width: "100%", "border-collapse": "collapse", "font-size": "12px" }}>
    <thead><tr><th style={{ ...cell, "text-align": "left" }}>Model</th><th style={cell}>Calls</th><th style={cell}>Total input</th>
      <For each={tokenKinds}>{kind => <th style={cell}>{labels[kind]}</th>}</For></tr></thead>
    <tbody><For each={props.rows}>{row => <tr>
      <td style={{ ...cell, "text-align": "left" }}>{modelName(row)}</td><td style={cell}>{row.calls}</td>
      <td style={cell}>{count(inputTotal(row))}</td><For each={tokenKinds}>{kind => <td style={cell}>{count(row.tokens[kind])}</td>}</For>
    </tr>}</For></tbody>
  </table><Show when={!props.rows.length}><p>No recorded calls.</p></Show></div>;
}

export default Plugin.define({
  setup(ctx) {
    const [state, setState] = createSignal<UsageState>({ loading: false });
    let refresh = () => {};
    createKeyed(() => {
      const session = ctx.sessions.current();
      return session && !session.pending ? { key: session.key, id: session.id, client: session.server.client, data: session.server.data } : undefined;
    }, source => {
      setState({ loading: true });
      const watcher = watchUsage({ client: source.client, sessionID: source.id,
        subscribe: listener => source.data.listen(event => listener(event.details)), changed: setState });
      refresh = watcher.refresh;
      onCleanup(() => { watcher.dispose(); refresh = () => {}; });
    }, { equals: (a, b) => a.key === b.key && a.client === b.client, otherwise: () => setState({ loading: false }) });
    const open = () => {
      const session = ctx.sessions.current();
      if (session) ctx.layout.open(`${ctx.id}:usage`, session, { tab: "select" });
    };
    ctx.add(Command, () => ({ id: "open", title: "Show per-turn token usage", slash: { name: "turn-usage" },
      enabled: !!ctx.sessions.current(), run: open }));
    ctx.add(Slot, { at: "window.bottom", render: () => <Show when={ctx.sessions.current()}>
      <div style={{ padding: "5px 12px", "font-size": "12px", display: "flex", gap: "12px", "align-items": "center" }}>
        <button type="button" onClick={open} style={{ "flex-shrink": 0 }}>Turn usage</button>
        <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }} title={state().error ?? compact(state().report?.turns.at(-1))}>
          {state().error ? "Usage unavailable or stale" : state().report ? compact(state().report?.turns.at(-1)) : "Loading usage…"}
        </span><Show when={state().loading}><span>Updating…</span></Show>
      </div>
    </Show> });
    ctx.add(Panel, { id: "usage", region: "side", width: 640,
      list: input => input.open.includes("usage") ? [tab] : [],
      render: input => <div style={{ padding: "16px", height: "100%", overflow: "auto", "font-family": "inherit" }}>
        <h2>Token usage by turn and model</h2>
        <p>Recorded calls only. Input includes uncached input, cache reads and cache writes. Output excludes separately reported reasoning.</p>
        <button type="button" onClick={() => refresh()}>Refresh</button>
        <Show when={state().error}><p role="alert">{state().error}</p></Show>
        <Show when={state().loading}><p role="status">Updating recorded usage…</p></Show>
        <Show when={state().report?.rootID === input.session.id ? state().report : undefined}>{report => <>
          <h3>Session totals</h3><UsageTable rows={report().totals} />
          <For each={[...report().turns].reverse()}>{turn => <details open={turn.id === report().turns.at(-1)?.id}>
            <summary style={{ padding: "12px 0", cursor: "pointer" }}>Turn {turn.number} · {turn.status} · {new Date(turn.started).toLocaleString()}</summary>
            <UsageTable rows={turn.models} />
          </details>}</For>
          <Show when={report().unattributed.length}><h3>Unattributed calls</h3><p>Included in session totals; not assigned to a turn.</p><UsageTable rows={report().unattributed} /></Show>
          <For each={report().warnings}>{warning => <p role="note">{warning}</p>}</For>
          <p>Missing counters appear as unknown or “known + ?”. Provider-normalized zero counters cannot be distinguished from unreported usage. Unrecorded requests and billing adjustments are outside this report.</p>
        </>}</Show>
      </div>,
    });
  },
});
