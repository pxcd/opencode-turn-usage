import { collect, type UsageClient } from "./collector.js";
import type { UsageReport } from "./accounting.js";

export interface UsageEvent { type: string; data?: unknown }
export interface UsageState { report?: UsageReport; loading: boolean; error?: string }
export function watchUsage(input: {
  client: UsageClient;
  sessionID: string;
  subscribe: (listener: (event: UsageEvent) => void) => () => void;
  changed: (state: UsageState) => void;
  delay?: number;
}) {
  const abort = new AbortController();
  let family = new Set([input.sessionID]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let working = false;
  let report: UsageReport | undefined;
  async function refresh() {
    if (abort.signal.aborted) return;
    if (working) { pending = true; return; }
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
      if (pending && !abort.signal.aborted) { pending = false; schedule(); }
    }
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), input.delay ?? 250);
  }
  const off = input.subscribe(event => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    const id = "sessionID" in data && typeof data.sessionID === "string" ? data.sessionID : undefined;
    const parent = "parentID" in data && typeof data.parentID === "string" ? data.parentID : undefined;
    if (!id || (!family.has(id) && (!parent || !family.has(parent)))) return;
    if (parent && family.has(parent)) family.add(id);
    // No polling or refresh on streamed tokens. One debounced read after step/execution changes.
    if (/^session\.(execution\.|step\.(ended|failed)$|compaction\.(ended|failed)$|created$|revert\.|deleted$)/.test(event.type)) schedule();
  });
  void refresh();
  return {
    refresh: () => { clearTimeout(timer); void refresh(); },
    dispose: () => { abort.abort(); clearTimeout(timer); off(); },
  };
}
