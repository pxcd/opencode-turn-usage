import test from "node:test";
import assert from "node:assert/strict";
import { createRoot } from "solid-js";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fakeClient, snapshot as s, user as u, assistant as a, idle } from "./fixtures.js";

test("built terminal entry contributes a live footer and usage command without writing chat messages", async () => {
  const entry = process.env.OPENCODE_TURN_USAGE_PACKAGE_ROOT
    ? pathToFileURL(path.join(process.env.OPENCODE_TURN_USAGE_PACKAGE_ROOT, 'dist/tui.js')).href
    : new URL('../dist/tui.js', import.meta.url).href;
  const { default: plugin } = await import(entry);
  const { client } = fakeClient([s("ses_root", [u("msg_u", 1), a("msg_a", 2), idle("msg_i", 3)])]);
  let off = false; let removed = false; let slot: any; let layer: any; let alert: any;
  const ctx = { client, data: { listen: () => () => { off = true; } },
    ui: { router: { current: () => ({ type: "session", sessionID: "ses_root" }) },
      slot: (value: unknown) => { slot = value; return () => { removed = true; }; },
      dialog: { alert: async (value: unknown) => { alert = value; } } },
    keymap: { layer: (fn: () => unknown) => { layer = fn(); } } };
  let dispose!: () => void; let cleanup!: () => void;
  try {
    createRoot(stop => { dispose = stop; cleanup = plugin.setup(ctx); });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(slot.append, "sidebar.footer");
    assert.match(slot.render({ sessionID: "ses_root" }), /Turn 1.*succeeded/);
    assert.equal(slot.render({ sessionID: "ses_other" }), "");
    layer.commands[0].run(); assert.match(alert.message, /Session totals/);
    assert.match(alert.message, /Cache read: 100/);
  } finally { cleanup?.(); dispose?.(); }
  assert.ok(off); assert.ok(removed);
});
