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
- [x] **Scheduled Tasks** — Wire `ScheduleService` backend to `/schedule` command ([#7](https://github.com/Danielmelody/ClawGravity/issues/7))
- [x] **Usage Stats & Rate Limiting** — `/stats` command and per-user rate limits ([#8](https://github.com/Danielmelody/ClawGravity/issues/8))
- [ ] **External Webhooks** — Notify Slack, LINE Notify, etc. on task completion ([#9](https://github.com/Danielmelody/ClawGravity/issues/9))

## Advanced Features

- [ ] **Template Import / Export** — Portable prompt templates ([#10](https://github.com/Danielmelody/ClawGravity/issues/10))
- [ ] **Auto Update Check** — Notify on new npm version at startup ([#11](https://github.com/Danielmelody/ClawGravity/issues/11))

## Response Extraction Architecture ([#23](https://github.com/Danielmelody/ClawGravity/issues/23))

Migrated from DOM-based extraction to gRPC trajectory-based response monitoring. All detection and response extraction now uses `GetCascadeTrajectory` API calls — zero DOM dependency.

- [x] **Phase 1: Structured DOM Extraction + HTML-to-Markdown** — [PR #27](https://github.com/Danielmelody/ClawGravity/pull/27) *(legacy, superseded)*
- [x] **Phase 2: gRPC Trajectory-Based Detection** — All detectors (approval, planning, error, run command, user message) migrated to trajectory data
- [x] **Phase 3: LS API Message Injection** — `injectMessage()` uses LS direct API, bypassing DOM entirely
- [x] **Phase 4: GrpcResponseMonitor** — Response monitoring via `GetCascadeTrajectory` polling (replaces DOM-based `ResponseMonitor`)
- [ ] **Phase 5: Bundle-Based Trajectory Rendering** — Replace mounted-tree renderer with detached `chat.js` bundle rendering (see `ANTIGRAVITY_TRAJECTORY_RENDERER_HANDOFF.md`)

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
- [x] Structured response extraction — trajectory-based extraction with HTML-to-Markdown conversion
- [x] Planning mode detection — surface planning decisions in Discord ([#25](https://github.com/Danielmelody/ClawGravity/pull/25))
- [x] Error popup detection — detect and report Antigravity error popups ([#26](https://github.com/Danielmelody/ClawGravity/pull/26))
- [x] Quota error detection — improved popup and inline pattern matching ([#22](https://github.com/Danielmelody/ClawGravity/issues/22))
- [x] Project list pagination — support for >25 projects ([#21](https://github.com/Danielmelody/ClawGravity/pull/21))
- [x] Dialog exclusion — exclude role="dialog" containers from activity scan ([#32](https://github.com/Danielmelody/ClawGravity/pull/32))
- [x] Scheduled tasks — `/schedule` command wiring for Discord + Telegram with cron persistence ([#7](https://github.com/Danielmelody/ClawGravity/issues/7))
- [x] Event-driven trajectory monitoring — gRPC trajectory polling via TrajectoryStreamRouter (replaces DOM MutationObserver)
- [x] Passive PC→Telegram notifications — mirror locally-typed prompts and AI responses to Telegram
