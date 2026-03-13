# 🦞 ClawGravity Roadmap

> An OpenClaw-compatible Agent Gateway built on Google Antigravity.

---

## v0.1.0 — Foundation ✅ *Current*

The initial release. ClawGravity bridges Telegram/Discord to Antigravity via CDP + gRPC, providing remote access to agentic coding capabilities.

### Core
- [x] CDP → gRPC trajectory-based architecture (zero DOM dependency)
- [x] `StartCascade` / `SendUserCascadeMessage` / `GetCascadeTrajectory` full integration
- [x] Telegram + Discord dual-platform support
- [x] Rich trajectory rendering (tool calls, thinking blocks, status icons)
- [x] Artifact forwarding to Telegram as expandable blockquotes

### Session Management
- [x] Multi-workspace binding (`/project`)
- [x] Chat session create / switch / restore
- [x] Passive PC→Telegram mirroring (locally-typed prompts forwarded)
- [x] Mode / Model sync between IM and Antigravity UI

### Agent Autonomy
- [x] `@claw` command protocol (schedule, agent delegation)
- [x] `ScheduleService` + cron persistence
- [x] `AgentRouter` cross-workspace task delegation
- [x] Dedicated `__claw__` agent workspace with `GEMINI.md` / `HEARTBEAT.md` / `CLAW.md`

### Interactive Controls
- [x] Approval / Planning / Error / Run Command detection → interactive buttons
- [x] `/stop` generation interrupt
- [x] `/screenshot` capture
- [x] Auto-accept mode
- [x] Template system (`/template`)
- [x] Inspect mode (self-analysis loop)

---

## v0.2.0 — Shadow Memory

Persistent user memory across sessions. The agent remembers who you are, your preferences, and past decisions — even in brand new cascades.

### Shadow Memory Store
- [ ] `user_preferences.memory` column + `getMemory()` / `setMemory()`
- [ ] Auto-inject memory into new cascade prompts as `[System Context]`
- [ ] `/memory show|set|clear` Telegram command

### Context Compaction
- [ ] Trajectory step count monitor with configurable threshold
- [ ] Auto-trigger summary prompt → persist key facts to memory
- [ ] Seamless cascade rollover (new cascade with memory injected)

---

## v0.3.0 — Skills Integration

Leverage Antigravity's native `SKILL.md` system from the IM layer. Users can discover, trigger, and manage agent skills without touching the IDE.

### Skill Discovery
- [ ] Scan workspace `{.agents,.agent}/skills/` directories
- [ ] `SkillDiscoveryService` — list, read, cache skill metadata
- [ ] `/skill` command — list available skills with descriptions

### Skill Execution
- [ ] `/skill <name>` — parse `SKILL.md` body → inject as prompt payload
- [ ] `@claw:skill_run` — agent-initiated skill execution
- [ ] `/skill install <url>` — download skill packages from GitHub

---

## v0.4.0 — Multi-Agent Enhancement

Evolve the existing `AgentRouter` from basic delegation to a full multi-agent coordination system.

### Agent Awareness
- [ ] `agent_status` — query each workspace's connection state and active task
- [ ] Agent capability registry (what each workspace specializes in)
- [ ] `@claw:memory_set|memory_get` — agents read/write user shadow memory

### Async Task Coordination
- [ ] Shared task board (`__claw__/task_board.md`)
- [ ] Non-blocking `agent_send` — fire and forget, callback on completion
- [ ] `task_post` / `task_poll` protocol for loose agent coordination

### Future: A2A Compatibility
- [ ] Evaluate Google A2A protocol adoption when SDK stabilizes
- [ ] Agent Card (`/.well-known/agent.json`) for capability advertisement
- [ ] JSON-RPC 2.0 task delegation interface

---

## v0.5.0 — Security & Sandboxing

Harden ClawGravity for public-facing deployment. Terminal commands currently execute directly on the host — this must change.

### Command Guardrails
- [ ] `CommandSandbox` service with `claw_security.json` deny-list
- [ ] Regex pattern matching against `run_command` trajectory steps
- [ ] Auto-reject + notify on dangerous command detection

### Execution Isolation
- [ ] `execMode: 'host' | 'docker'` configuration
- [ ] Docker-based command sandboxing for untrusted operations
- [ ] Per-workspace security policy profiles

---

## Future

Items under consideration, not yet scheduled:

- [ ] **Multi-editor support** — adapter abstraction for Cursor, Windsurf, etc.
- [ ] **Plugin system** — user-defined hooks and event listeners
- [ ] **External webhooks** — Slack, LINE Notify on task completion
- [ ] **Web dashboard** — browser-based management UI
- [ ] **Bundle-based trajectory rendering** — detached `chat.js` renderer
