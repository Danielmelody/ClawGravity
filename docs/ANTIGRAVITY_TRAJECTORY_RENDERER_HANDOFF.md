# Antigravity Trajectory Renderer Handoff

Date: 2026-03-10

## Goal

Replace the current mounted-tree-based `AntigravityTrajectoryRenderer` with a bundle-first detached renderer.

Requirements from the current discussion:

- No fallback to mounted tree lookup.
- Do not depend on the currently visible Antigravity panel DOM.
- Support background / parallel conversations by rendering from the passed trajectory data.
- Keep Telegram streaming on the rendered timeline path only.

## Current User-Facing Failure

Telegram now routes streaming through the detached timeline renderer, but live rendering currently fails and the user sees `(Empty response from Antigravity)`.

Observed runtime logs:

- `Timeline render skipped`
- `The Antigravity trajectory renderer is not mounted in this execution context`

That error comes from the old implementation in [antigravityTrajectoryRenderer.ts](/C:/Users/Daniel/Projects/antigravity-tunnel/src/services/antigravityTrajectoryRenderer.ts), which still assumes:

- `.antigravity-agent-side-panel`
- mounted Preact tree traversal
- a renderer component named `aBe`
- live node context from `rendererNode.__c.context`

Those assumptions are stale.

## Git History Result

There is no prior bundle-direct implementation in repo history.

- `d934d8f` introduced the mounted-tree renderer approach.
- `fb303b2` cleaned it up but kept the same strategy.

So there is nothing useful to restore from git. The fix needs a new implementation.

## Important Workspace State

These changes are already in the worktree and should be preserved:

- [telegramMessageHandler.ts](/C:/Users/Daniel/Projects/antigravity-tunnel/src/bot/telegramMessageHandler.ts)
  - Telegram active/passive monitors now pass `trajectoryRenderer`.
  - Telegram user-visible streaming is render-only, not raw progress text.
- [antigravityTrajectoryRenderer.ts](/C:/Users/Daniel/Projects/antigravity-tunnel/src/services/antigravityTrajectoryRenderer.ts)
  - Data fallback to current panel `trajectory` props was already removed.
  - But the file still uses mounted-tree discovery and must be replaced.

Do not revert unrelated worktree changes.

## Where The Real Bundle Is

The useful installed Antigravity bundle is:

- `C:\Users\Daniel\AppData\Local\Programs\Antigravity\resources\app\extensions\antigravity\out\media\chat.js`

`jetskiAgent.js` is not the renderer payload you want.

## Key Discovery

Trusted Types and CSP block normal DOM/script injection into the Antigravity workbench page.

What failed:

- `document.write`
- `eval`
- script tag injection
- custom Trusted Types policy

What works:

- CDP `Runtime.compileScript`
- CDP `Runtime.runScript`

This successfully injects `chat.js` into the workbench execution context without relying on mounted UI nodes.

## Proven Live Probe

In the `antigravity-tunnel` workbench page, after `compileScript/runScript` against execution context `1`, these globals are available:

- `uCe`
- `USe`
- `mCe`
- `w6`
- `F6`
- `p`
- `u`
- `d`
- `T6`

Important correction:

- `aBe` is not the trajectory renderer component.
- In the current bundle, global `aBe` is just an integer helper: `function aBe(e,t){return{lo:0|e,hi:0|t}}`

So the old assumption about `aBe` is definitely wrong.

## Most Promising Renderer Entry Point

The best candidate discovered so far is:

- `uCe`

Its live signature is:

```ts
({trajectory, status, queuedSteps, debugMode = false, sectionVirtualizer, isSubtrajectory = false, failedToSendOptimisticStep = () => false, viewportHeight = 0, forceScrollToBottom})
```

This strongly suggests `uCe` is the detached trajectory timeline renderer we should call directly.

## Supporting Bundle Findings

The bundle also contains:

- `w6`
  - provider for the internal renderer context
- `F6`
  - hook that reads that provider
- `USe`
  - planner response step renderer
- `mCe`
  - tool-call card renderer

The step renderer config map exists in bundle source as `fpt`, with entries such as:

- `plannerResponse -> USe`
- `viewFile -> xNe`
- `listDirectory -> tSe`
- `runCommand -> tNe`

But `fpt` was not available as a direct global after injection, so do not assume you can read it from `globalThis`.

## Enum Findings

These globals were confirmed live after injection:

- `M$`
  - cascade run status enum
  - `IDLE = 1`, `RUNNING = 2`
- `X$`
  - step status enum
  - `DONE = 3`, `RUNNING = 2`, etc.

Some names used by the current implementation are wrong or not globally available in the live bundle:

- `Don` -> not available
- `HA` -> not available
- `al` / `Zb` / `Vhe` are not the helpers the old code assumed

This is another reason to stop carrying the current mounted-tree code forward.

## Current Technical Unknown

The remaining unfinished piece is not bundle injection. That part is solved.

The open problem is:

- what is the minimum valid provider payload for `w6`
- and whether `uCe` can render with a lightweight synthetic `cascadeContext` / `renderers` / `getStepRendererConfig`

`uCe` uses `F6()`, and downstream code touches:

- `cascadeContext.state.cascadeStateProvider`
- `cascadeContext.events.sendMessage`
- `renderers.markdown`
- `getStepRendererConfig`
- `inputBoxRef`
- other provider fields may be read by nested components

So the next step is to build the smallest working detached provider contract around `uCe`.

## Recommended Next Step

Implement the new renderer in [antigravityTrajectoryRenderer.ts](/C:/Users/Daniel/Projects/antigravity-tunnel/src/services/antigravityTrajectoryRenderer.ts) as:

1. Read `chat.js` from the installed Antigravity path.
2. For each chosen CDP execution context, bootstrap bundle globals via `Runtime.compileScript/runScript`.
3. Cache successful bootstrap per context.
4. Evaluate a detached render expression that:
   - constructs a minimal provider with `w6`
   - renders `uCe` into a detached container via `u.H(container).render(...)`
   - returns `container.innerHTML`
5. Delete the mounted-tree lookup path entirely.

## Suggested Probe To Finish Before Patching

Run a live CDP eval that attempts:

```js
const container = document.createElement('div');
const root = u.H(container);
root.render(
  p.jsx(w6, {
    cascadeContext: /* minimal stub */,
    workspaceInfo: /* minimal stub */,
    unleashState: {},
    stepHandler: {},
    chatParams: { artifactsDir: '', knowledgeDir: '', hasDevExtension: false },
    renderers: { markdown: ({ children }) => p.jsx('div', { children }) },
    restartUserStatusUpdater: () => {},
    getStepRendererConfig: /* minimal step config function */,
    userStatus: {},
    trajectorySummariesProvider: /* stub */,
    inputBoxRef: { current: null },
    tokenizationService: /* stub */,
    metadata: {},
    children: p.jsx(uCe, {
      trajectory,
      status: M$.RUNNING,
      queuedSteps: [],
      debugMode: false,
      isSubtrajectory: false,
      viewportHeight: 0,
      failedToSendOptimisticStep: () => false,
    }),
  }),
);
```

The first goal is not perfect HTML. The first goal is to discover the minimum stub contract that prevents runtime throws.

## Useful Live Facts For The Next Person

- Workbench execution context `1` is usable for `compileScript/runScript`.
- The workbench page URL is `vscode-file://.../workbench.html`.
- No visible chat webview DOM is needed for the successful bundle injection path.
- The old `aBe` assumption is false in the current Antigravity build.
- Telegram-side routing changes are already in place; the missing piece is the renderer implementation.

## Validation After Patch

At minimum, rerun:

- `npx tsc -p tsconfig.json --noEmit`
- `npx jest tests/services/antigravityTrajectoryRenderer.test.ts --runInBand`
- targeted Telegram tests around detached renderer injection and streamed HTML timeline updates

For live validation:

- send a short Telegram prompt into the `antigravity-tunnel` workspace
- confirm the stream updates with rendered HTML timeline/tool calls instead of `(Empty response from Antigravity)`

