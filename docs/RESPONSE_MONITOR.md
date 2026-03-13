# Response Monitor Architecture

> gRPC trajectory API を経由して Antigravity の AI 応答をリアルタイム監視し、
> Discord / Telegram に**アウトプット**と**プロセスログ**を分離配信する仕組み。

---

## 1. System Overview

```
Discord / Telegram User
    |  prompt
    v
WorkspaceRuntime.sendPrompt()
    |  cdpService.injectMessage(prompt)  ← LS direct API (no DOM)
    v
Antigravity (Language Server)  --- AI generates response ---
    ^
    |  gRPC: GetCascadeTrajectory (polled by TrajectoryStreamRouter)
    |
GrpcResponseMonitor
    |
    +---> onProgress(text)      --> Platform "generating" embed (output)
    +---> onProcessLog(text)    --> Platform "process log" embed (activity)
    +---> onPhaseChange(phase)  --> phase tracking
    +---> onComplete(text)      --> Platform "complete" embed (final)
```

### Key Files

| File | Role |
|------|------|
| `src/services/grpcResponseMonitor.ts` | gRPC trajectory polling, phase state machine, response extraction |
| `src/services/trajectoryStreamRouter.ts` | Central polling dispatcher — fans out trajectory data to all detectors |
| `src/services/antigravityTrajectoryRenderer.ts` | Trajectory → HTML rendering for rich output |
| `src/utils/discordFormatter.ts` | Text formatting for Discord (table/tree code blocks, UI chrome filtering) |
| `src/utils/htmlToDiscordMarkdown.ts` | HTML → Discord Markdown conversion |
| `src/utils/htmlToTelegramHtml.ts` | HTML → Telegram HTML conversion |
| `src/utils/logger.ts` | ANSI colored logger with level-based methods |

> **Legacy file**: `src/services/responseMonitor.ts` was the original CDP DOM-polling implementation.
> It has been superseded by `GrpcResponseMonitor` + `TrajectoryStreamRouter`.

---

## 2. Dual Output Streams

GrpcResponseMonitor produces **two independent streams** from cascade trajectory data:

| Stream | Data Source | Content | Platform Embed |
|--------|-------------|---------|----------------|
| **Output** | Trajectory step `assistantMessage` items | Natural language AI response | "generating" / "complete" |
| **Process Log** | Trajectory step `toolCall` / `toolExecution` items | Activity messages + tool output | "process log" |

This separation happens **at the trajectory data level** — each step in the cascade trajectory has a typed classification (`assistantMessage`, `toolCall`, `toolExecution`, `userInput`, etc.). No DOM scraping or CSS selectors are involved.

### Why Trajectory Data?

The gRPC `GetCascadeTrajectory` API returns structured step data:

```
trajectory.steps[]
  ├── assistantMessage   → AI response text (the "output")
  ├── toolCall           → MCP tool invocations
  ├── toolExecution      → Tool results and status
  ├── userInput          → User messages
  └── plannerResponse    → Planning mode decisions
```

Each step type is already classified by Antigravity's backend, eliminating the need for heuristic DOM classification.

---

## 3. Trajectory-Based Detection

### 3.1 Response Text Extraction

Extracts the **newest AI response text** from trajectory steps.

**Algorithm:**
1. Fetch trajectory via `GetCascadeTrajectory` gRPC call
2. Iterate steps to find `assistantMessage` items
3. Extract text content from message items
4. Render via `AntigravityTrajectoryRenderer` for rich HTML output (optional)

### 3.2 Process Log Extraction

Extracts tool call and execution information.

**Algorithm:**
1. Same trajectory data as response text
2. Scan steps for `toolCall` and `toolExecution` types
3. Extract tool names, arguments, and results
4. Format as activity log entries

### 3.3 Completion Detection

Detects whether AI generation is complete by checking the cascade run status:

```
GetCascadeTrajectory response includes:
  - cascadeRunStatus: CASCADE_RUN_STATUS_RUNNING | CASCADE_RUN_STATUS_IDLE
```

No stop-button detection or DOM polling needed.

---

## 4. Polling & Phase State Machine

### 4.1 Poll Cycle (TrajectoryStreamRouter)

```
TrajectoryStreamRouter.fetchAndDispatch()
  |
  +-- 1. GetCascadeTrajectory  -> trajectory steps + runStatus
  |
  +-- Fan out to registered detectors:
       +-- GrpcResponseMonitor.evaluate()
       +-- ApprovalDetector.evaluate()
       +-- ErrorPopupDetector.evaluate()
       +-- PlanningDetector.evaluate()
       +-- RunCommandDetector.evaluate()
  |
  +-- 2. GetAllCascadeTrajectories  -> summaries (for UserMessageDetector)
```

Default polling interval: **300ms**. TrajectoryStreamRouter is lazy-connected — it only polls after `connectToCascade(id)` is called.

### 4.2 Phase Transitions

```
waiting --> thinking --> generating --> complete
   |           |            |             |
   +--timeout--+--timeout---+--timeout----+
```

| Transition | Trigger |
|------------|---------|
| waiting → thinking | `CASCADE_RUN_STATUS_RUNNING` detected |
| thinking → generating | New assistant message steps appear in trajectory |
| generating → complete | `CASCADE_RUN_STATUS_IDLE` detected |
| any → timeout | `maxDurationMs` elapsed |

### 4.3 Baseline Suppression

At `start()`, the monitor captures the current trajectory step count as the baseline.
During polling, only steps **beyond the baseline** are processed as new content.
This prevents previous conversation turns from appearing in the current response.

---

## 5. Detector Architecture

All detectors follow a **passive evaluation** pattern — they don't poll independently.
The `TrajectoryStreamRouter` fetches trajectory data once per tick and dispatches to all detectors.

| Detector | Data Source | Detection Logic |
|----------|-------------|-----------------|
| `GrpcResponseMonitor` | Trajectory steps | Assistant message extraction, run status |
| `ApprovalDetector` | Trajectory steps | `toolCall` steps with approval-required status |
| `PlanningDetector` | Trajectory steps | `plannerResponse` steps with decision points |
| `ErrorPopupDetector` | Trajectory steps | Error status in step results |
| `RunCommandDetector` | Trajectory steps | `runCommand` type steps |
| `UserMessageDetector` | Trajectory summaries | `lastUserInputTime` changes across cascades |

> **Zero DOM operations** — all detectors analyze cascade trajectory data exclusively.

---

## 6. Logging Architecture

### 6.1 Log Levels (src/utils/logger.ts)

| Level | ANSI Color | Use Case |
|-------|------------|----------|
| `logger.error` | Red | Failures, exceptions |
| `logger.warn` | Yellow | Quota detection, timeout |
| `logger.info` | Cyan | Monitoring start |
| `logger.phase` | Magenta | Phase transitions (Thinking, Generating) |
| `logger.done` | Green | Completion event |
| `logger.divider` | Green+Dim | Section separators for finalize content blocks |
| `logger.debug` | Dim | Verbose diagnostic (not output in production) |

### 6.2 Log Output During Normal Operation

A typical successful run produces this structured output:

```
[INFO]  ── Monitoring started | poll=300ms cascade=abc123...
[PHASE] Thinking
[PHASE] Generating (186 chars)
[DONE]  Complete (236 chars)
[DONE]  ── Process Log ──────────────────────────────────
jina-mcp-server / search_web
title: 東京都の天気 url: ... snippet: ...
[DONE]  ── Output (236 chars) ──────────────────────────
2026年2月24日の東京の天気は、以下のようになっています...
[DONE]  ──────────────────────────────────────────────────
```

**Design principles:**
- **3 phases visible**: Monitoring started → Thinking → Generating → Complete
- **Process Log before Output**: Chronological order (tool use happens before response)
- **Full content in divider blocks**: Terminal reviewers see exactly what the platform displays
- **No intermediate noise**: Trajectory diffs, partial previews, and status polling counts are silent

---

## 7. Message Injection

Prompt injection uses the **LS (Language Server) direct API** — zero DOM dependency.

```
CdpService.injectMessage(text)
  → getLSClient()         // Discover LS via CDP Runtime.evaluate
  → client.sendMessage()  // gRPC: SendUserCascadeMessage
    or
  → client.createCascade()  // gRPC: CreateCascade (new conversation)
```

The LS client communicates with Antigravity's Language Server backend directly.
No DOM input field manipulation, no keyboard simulation, no button clicking.

The only remaining DOM operation in the entire system is **image file attachment**
(`DOM.setFileInputFiles`), which requires CDP DOM access to locate the `<input type="file">` element.

---

## 8. Testing Strategy

### Test Files

| File | Tests | Coverage |
|------|-------|----------|
| `tests/services/grpcResponseMonitor.test.ts` | Phase state machine, completion, trajectory evaluation |
| `tests/services/trajectoryStreamRouter.test.ts` | Polling lifecycle, detector dispatch, cascade switching |
| `tests/services/approvalDetector.test.ts` | Approval step detection from trajectory data |
| `tests/services/planningDetector.test.ts` | Planning decision point detection |
| `tests/utils/discordFormatter.lean.test.ts` | UI chrome detection, splitOutputAndLogs, formatForDiscord |

### Mock Strategy

Tests mock the `CdpService.getLSClient()` to return a stub `GrpcCascadeClient` that provides
predetermined trajectory responses. No CDP connection or DOM interaction needed for testing.

---

## 9. Troubleshooting

### "Collecting Process Logs..." stays forever (logLen=0)

**Cause:** Trajectory data is not being fetched or contains no tool call steps. Check:
1. gRPC client connection (`cdpService.getLSClient()` returns non-null)
2. Cascade ID is valid and the cascade is actively running
3. Trajectory contains `toolCall` / `toolExecution` steps

### Response text is empty despite AI generating

**Cause:** Trajectory polling may not be connected to the correct cascade. Check:
1. `TrajectoryStreamRouter.connectToCascade(id)` was called with the correct cascade ID
2. The cascade run status is `CASCADE_RUN_STATUS_RUNNING` (not `IDLE`)
3. The LS client can successfully call `GetCascadeTrajectory`

### Old conversation entries appear in output

**Cause:** Baseline step count wasn't captured correctly at `start()`.
The monitor should skip all steps up to the baseline count captured at initialization.
