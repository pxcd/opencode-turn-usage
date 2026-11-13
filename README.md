# OpenCode Turn Usage

Per-user-turn token accounting by provider/model, including native subagent sessions and recorded compaction calls. Targets **OpenCode 2.2.7**. Desktop GUI plugins use an experimental API; other versions require verification.

The plugin adds a compact Desktop bottom strip and an expandable **Turn usage** side panel. Open it from the strip, command palette, or `/turn-usage`. The terminal entry adds a sidebar footer and `/turn-usage` dialog. These are supported extension locations; this does not inject a footer into the conversation timeline.

## Install from Git (after publishing a release)

```sh
opencode plugin add 'github:pxcd/opencode-turn-usage#v0.1.0'
```

The command requires the repository and `v0.1.0` tag to have been pushed. Install into your own OpenCode only when its current work is finished: configuration changes can reload plugins. Follow the documented [package installer](https://opencode.ai/docs/plugins/). Pin a reviewed release or full commit; OpenCode's package installer manages its installed copy separately from a development checkout. Private repos use your existing Git access; the plugin stores no credentials.

The Git repository must include **dist/** with the built GUI bundle, terminal entry and accounting library. No build/install lifecycle script is required on the workstation consuming it. Do not use a filesystem path when you want an independently installed package. Remove an installed package with `opencode plugin remove <the-installed-package-spec>`.

## Development

Node 22.12+ (or a supported newer Node release), npm and Git are sufficient.

```sh
npm ci
npm run check
```

`check` type-checks against the pinned SDK, builds both entries, runs offline tests (including a DOM host fixture for the actual Desktop bundle), packs the release artifact, and installs that tarball in `.artifacts/installed` without network, lifecycle scripts, or OpenCode registration. Test evidence and the tarball are under `.artifacts/`. These checks do **not** establish acceptance inside a running OpenCode Desktop/TUI or verify Git-remote installation; those are deferred until the active build finishes and the release exists.

After changing source, rebuild and include matching `dist/` files in the release commit. The lockfile pins development dependencies. Runtime host modules stay external using OpenCode's official GUI bundler.

## What the counters mean

- **Total input** = uncached input + cache reads + cache writes.
- **Output** is visible output; **Reasoning** is separate. The OpenCode v2.2.7 schema normalizes these categories separately. Do not add reasoning twice.
- **Calls** counts unique recorded assistant/compaction messages. Tool loops are multiple calls; replayed snapshots with the same message ID replace rather than add. Unrecorded retry attempts cannot be recovered.
- A user prompt starts a turn. Assistant steps belong to the preceding recorded prompt. Native `subagent` tool metadata links child sessions; dispatch and child-prompt timestamps associate reused workers and nested workers with the initiating turn. Synthetic completion notifications do not start turns.
- Ambiguous concurrent follow-ups and missing links are **unattributed**, included once in session totals. No ownership is guessed from the worker's completion time. Mid-step steering can span user turns; this is recorded prompt/step attribution, not a reconstruction of provider request admission.
- A worker still running keeps its originating turn provisional. Reverted or incomplete histories are flagged. Inherited fork messages are excluded by creation time.
- Missing or invalid counters show **unknown** or **known + ?**. OpenCode/provider normalization can already turn missing native fields into zero; those zeros cannot be distinguished afterwards. This is recorded usage, not an authoritative billing/quota ledger. Calls absent from the transcript, such as unrecorded title generation, are outside its scope.

## Isolation and performance

Only documented read APIs are used: session get/list and message list. No database access, chat writes, prompt hooks, tools, model calls, provider configuration, global settings or telemetry. Nothing is added to model context. Transcript reads discard prompts and ordinary tool output from the retained report, which stays in memory. Loading/reopening reconstructs reports from server history; no separate usage database is created.

Refresh is event-driven and debounced, not polled and not triggered by token deltas. A refresh currently rereads the selected session family, with 64-session and 500-page limits; reaching a limit or failing a child read flags partial totals. Large histories can cost local API traffic even though they consume no inference tokens. Switching sessions or disabling the plugin cancels its reads and subscriptions.

## References

- [GUI plugin API and supported slots](https://opencode.ai/docs/build/plugins/gui/)
- [Terminal plugin API](https://opencode.ai/docs/build/plugins/cli/)
- Pinned upstream source: [`v2.2.7`](https://github.com/anomalyco/opencode/tree/v2.2.7), especially `packages/schema/src/token-usage.ts`, `session-message.ts`, and `packages/core/src/tool/plugin/subagent.ts`.
