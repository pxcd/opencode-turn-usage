import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { createComponent, createRoot } from "solid-js";
import type { Plugin as GuiPlugin } from "@opencode/plugin/gui";
import { fakeClient, snapshot as s, user as u, assistant as a, idle, usage } from "./fixtures.js";

// Execute the shipped CJS entry with the same SDK external modules the Desktop host supplies.
test("built Desktop bundle renders automatic summary and per-turn panel, then cleans up", async () => {
  const dom = new JSDOM('<!doctype html><div id="footer"></div><div id="panel"></div>');
  const previous = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator };
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  const provided = new Map<string, unknown>([
    ["@opencode/plugin/gui", await import("@opencode/plugin/gui")],
    ["solid-js", await import("solid-js")], ["solid-js/web", await import("solid-js/web")],
  ]);
  const hostRequire = (id: string) => {
    if (!provided.has(id)) throw new Error(`Unexpected bundle external: ${id}`);
    return provided.get(id);
  };
  const module = { exports: {} as { default: GuiPlugin.Definition } };
  new Function("require", "module", "exports", readFileSync(process.env.OPENCODE_TURN_USAGE_PACKAGE_ROOT ? resolve(process.env.OPENCODE_TURN_USAGE_PACKAGE_ROOT, 'dist/gui-experimental.cjs') : new URL('../dist/gui-experimental.cjs', import.meta.url), 'utf8'))(hostRequire, module, module.exports);
  const { render } = await import("solid-js/web");
  const root = s("ses_root", [u("msg_u", 1), a("msg_a", 2, usage(1234, 56)), idle("msg_i", 3)]);
  const { client } = fakeClient([root]);
  let listener: ((event: { details: unknown }) => void) | undefined;
  let subscribed = false;
  const session = { key: "server\nses_root", id: "ses_root", pending: false, server: { client, data: {
    listen(fn: typeof listener) { listener = fn; subscribed = true; return () => { subscribed = false; }; },
  } } };
  const additions: any[] = [];
  let opened = "";
  const ctx = { id: "opencode-turn-usage", sessions: { current: () => session },
    layout: { open: (key: string) => { opened = key; } }, add: (_registry: unknown, item: unknown) => { additions.push(item); } };
  let dispose!: () => void;
  let footerDispose: (() => void) | undefined;
  let panelDispose: (() => void) | undefined;
  try {
    createRoot(stop => { dispose = stop; module.exports.default.setup!(ctx as never); });
    const footer = additions.find(x => x.at === "window.bottom");
    const panel = additions.find(x => x.id === "usage");
    assert.ok(footer); assert.ok(panel);
    assert.equal(panel.list({ open: ["usage"] })[0].title, "Turn usage");
    footerDispose = render(() => footer.render(), dom.window.document.getElementById("footer")!);
    panelDispose = render(() => panel.render({ session }), dom.window.document.getElementById("panel")!);
    await new Promise(resolve => setTimeout(resolve, 30));
    const text = dom.window.document.body.textContent!;
    assert.match(text, /Turn 1/); assert.match(text, /succeeded/); assert.match(text, /openai\/gpt-6.1-sol/);
    assert.match(text, /1,234/); assert.match(text, /56/); assert.doesNotMatch(text, /PRIVATE PROMPT/);
    (dom.window.document.querySelector('#footer button') as HTMLButtonElement).click();
    assert.equal(opened, "opencode-turn-usage:usage");
    assert.ok(subscribed);
  } finally {
    panelDispose?.(); footerDispose?.(); dispose?.(); assert.equal(subscribed, false);
    dom.window.close();
    for (const [key, value] of Object.entries(previous)) Object.defineProperty(globalThis, key, { configurable: true, value });
  }
});
