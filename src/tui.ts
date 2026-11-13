import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createSignal, onCleanup } from "solid-js";
import { watchUsage, type UsageState } from "./controller.js";
import { compact, reportText } from "./format.js";

export default Plugin.define({
  id: "turn-usage",
  setup(ctx) {
    const [state, setState] = createSignal<UsageState>({ loading: false });
    let refresh = () => {};
    createEffect(() => {
      const route = ctx.ui.router.current();
      setState({ loading: false });
      if (route.type !== "session") return;
      const watcher = watchUsage({ client: ctx.client, sessionID: route.sessionID,
        subscribe: listener => ctx.data.listen(event => listener(event.details)), changed: setState });
      refresh = watcher.refresh;
      onCleanup(() => { watcher.dispose(); refresh = () => {}; });
    });
    const off = ctx.ui.slot({ append: "sidebar.footer", render: input => {
      const value = state();
      const route = ctx.ui.router.current();
      if (route.type !== "session" || route.sessionID !== input.sessionID) return "";
      if (!value.report) return value.error ? "Turn usage: unavailable" : "Turn usage: loading…";
      if (value.report.rootID !== input.sessionID) return "";
      return value.error ? "Turn usage: stale/unavailable" : compact(value.report.turns.at(-1));
    } });
    ctx.keymap.layer(() => ({ commands: [{ id: "turn-usage.show", title: "Show per-turn token usage", palette: true,
      slash: { name: "turn-usage" }, run: () => {
        const value = state();
        void ctx.ui.dialog.alert({ title: "Token usage by turn and model", message: value.report ? reportText(value.report) + (value.error ? `\n\n${value.error}` : "") : (value.error ?? "Usage has not loaded yet.") });
      } }, { id: "turn-usage.refresh", title: "Refresh token usage", palette: true, run: () => refresh() }] }));
    return off;
  },
});
