# ClawGravity Roadmap

> An OpenClaw implementation built on Antigravity's Agent capabilities.
> Tracking upcoming work and known issues.
> Items link to GitHub Issues — contributions welcome!

---

## Known Issues

- [x] **Error Retry UI** — Display a Retry button in Discord on model errors ([#1](https://github.com/Danielmelody/ClawGravity/issues/1))
- [x] **Planning Mode Flow** — Surface Open / Proceed decision points in Discord ([#2](https://github.com/Danielmelody/ClawGravity/issues/2))
- [x] **Output Streaming** — Re-enable real-time streaming of final output ([#3](https://github.com/Danielmelody/ClawGravity/issues/3))

## CLI & Management

- [x] **`/status` command** — Show bot connection state, active projects, and current mode
- [x] **Invite Link Generator** — Auto-generate a bot invite URL during `claw-gravity setup`
- [x] **`doctor` enhancements** — Colored output and expanded checks ([#4](https://github.com/Danielmelody/ClawGravity/issues/4))

## UX & Notifications

- [x] **Startup Dashboard** — Rich embed on bot launch with system info ([#5](https://github.com/Danielmelody/ClawGravity/issues/5))
- [ ] **Heartbeat** — Optional periodic alive-check notification ([#6](https://github.com/Danielmelody/ClawGravity/issues/6))
- [ ] **Scheduled Tasks** — Wire `ScheduleService` backend to `/schedule` command ([#7](https://github.com/Danielmelody/ClawGravity/issues/7))
- [x] **Usage Stats & Rate Limiting** — `/stats` command and per-user rate limits ([#8](https://github.com/Danielmelody/ClawGravity/issues/8))
- [ ] **External Webhooks** — Notify Slack, LINE Notify, etc. on task completion ([#9](https://github.com/Danielmelody/ClawGravity/issues/9))

## Advanced Features

- [ ] **Template Import / Export** — Portable prompt templates ([#10](https://github.com/Danielmelody/ClawGravity/issues/10))
- [ ] **Auto Update Check** — Notify on new npm version at startup ([#11](https://github.com/Danielmelody/ClawGravity/issues/11))

## DOM Extraction Overhaul ([#23](https://github.com/Danielmelody/ClawGravity/issues/23))

Replace `innerText`-based extraction with structured DOM walking and HTML-to-Discord-Markdown conversion. Improves output fidelity, activity log separation, and resilience to AG DOM updates.

- [x] **Phase 1: Structured DOM Extraction + HTML-to-Markdown** — [PR #27](https://github.com/Danielmelody/ClawGravity/pull/27)
  - Structured segment extraction (assistant-body / thinking / tool-call / feedback)
  - HTML → Discord Markdown (headings, lists, code blocks, bold, file mentions)
  - Broad activity scan with word-boundary matching, content-body exclusion, ancestor dedup
  - Activity emoji classification (🧠 thinking, 📄 file ops, 🔍 active ops, 🛠️ MCP tools)
  - Default extraction mode changed to `structured`
- [ ] **Phase 2: Activity Log Dedicated DOM Selectors** — Target activity containers directly to reduce regex dependency
- [ ] **Phase 3a: Network Traffic Discovery** — Diagnostic tool to capture AG ↔ LLM API traffic patterns
- [ ] **Phase 3b: Network Response Capture** — Intercept API responses pre-DOM rendering (based on 3a findings)
- [ ] **Phase 4: Event-Driven DOM Monitoring** — `MutationObserver` + `Runtime.addBinding` to replace polling
- [ ] **Phase 5: Selector Health Monitoring** — Sliding-window failure tracking and graceful degradation

## Scalability & Architecture

- [X] **Logger Improvements** — File output, rotation, `--verbose` / `--quiet` flags ([#12](https://github.com/Danielmelody/ClawGravity/issues/12))
- [ ] **Multi-Editor Support** — Adapter abstraction for Cursor, Windsurf, etc. ([#13](https://github.com/Danielmelody/ClawGravity/issues/13))
- [ ] **Plugin System** — User-defined hooks and commands ([#14](https://github.com/Danielmelody/ClawGravity/issues/14))

## Public Release

- [x] **Assets** — Demo video, banner image, and Mermaid architecture diagram (all in README)
- [x] **npm Publish** — Published as `claw-gravity`
- [x] **GitHub Infrastructure** — Issue/PR templates, `CONTRIBUTING.md`, Discussions ([#15](https://github.com/Danielmelody/ClawGravity/issues/15))
- [ ] **v1.0 Stable Release** — First production-ready version ([#16](https://github.com/Danielmelody/ClawGravity/issues/16))

---

## Completed

- [x] Session sync — fixed sessions drifting when Antigravity UI is used directly
- [x] Media support — image attachment receiving and content extraction
- [x] Process log filtering — strip terminal output from final responses
- [x] Channel naming — LLM-powered high-precision channel titles
- [x] Output buffering — show complete output after generation finishes
- [x] Approval routing — confirmation buttons sent to the correct channel
- [x] `/stop` command — fixed accidental voice recording trigger
- [x] Channel isolation — messages in old channels no longer leak to latest session
- [x] Completion detection — improved end-of-response detection (previously timeout-based)
- [x] Structured DOM extraction — HTML-to-Discord-Markdown conversion with segment classification (Phase 1, [#27](https://github.com/Danielmelody/ClawGravity/pull/27))
- [x] Planning mode detection — surface planning decisions in Discord ([#25](https://github.com/Danielmelody/ClawGravity/pull/25))
- [x] Error popup detection — detect and report Antigravity error popups ([#26](https://github.com/Danielmelody/ClawGravity/pull/26))
- [x] Quota error detection — improved popup and inline pattern matching ([#22](https://github.com/Danielmelody/ClawGravity/issues/22))
- [x] Project list pagination — support for >25 projects ([#21](https://github.com/Danielmelody/ClawGravity/pull/21))
- [x] Dialog exclusion — exclude role="dialog" containers from activity scan ([#32](https://github.com/Danielmelody/ClawGravity/pull/32))
