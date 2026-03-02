# Codebase Report: Git Merge Conflict Analysis (upstream/main into HEAD)
Generated: 2026-02-23

## Summary

8 files have merge conflicts between the fork (HEAD, wilco customizations) and upstream/main (the-companion upstream). The conflicts cluster around two themes:
1. The fork removed the update-trigger mechanism and replaced it with an informational-only model
2. The fork added resume-external-session support and removed UpdateBanner

---

## Conflict Analysis Per File

---

### 1. `web/server/routes.ts`

**Two conflict blocks:**

**Block 1 (lines 22–31) — Imports:**
- HEAD adds: `import { DEFAULT_OPENROUTER_MODEL, getSettings, updateSettings } from "./settings-manager.js"` and `import { getUpdateState, checkForUpdate, isUpdateAvailable } from "./update-checker.js"` plus `import { getUsageLimits } from "./usage-limits.js"`
- upstream/main: These imports are removed (empty — moved to sub-route files)

**Block 2 (lines 1031–1896) — Route handlers:**
- HEAD: Retains a massive inline route block including: `/fs/home`, `/fs/tree`, `/fs/read`, `/fs/write`, `/fs/diff`, `/fs/claude-md`, `/envs/*`, `/envs/:slug/build*`, `/prompts/*`, `/docker/*`, `/images/*`, `/settings` GET/PUT, `/git/*`, `/usage-limits`, `/sessions/:id/usage-limits`, `/update-check` GET/POST, `/terminal`, `/sessions/:id/message`, `/skills/*`, `/cron/*`
- upstream/main: Only `registerSkillRoutes(api, cronScheduler)` and `registerCronRoutes(api, cronScheduler)` — everything else has been moved to the registered sub-route files already in scope

**What this means:** Upstream refactored all those routes into separate `routes/*.ts` files. The fork is still carrying the old inline versions. The upstream's `registerSystemRoutes()` (already called at line 1024) now handles update-check AND terminal AND cross-session messaging. The fork's HEAD has duplicated all this below.

**Recommendation:**
- Take upstream (drop the entire HEAD inline block, keep `registerSkillRoutes` + `registerCronRoutes`)
- BUT: The fork's update-check routes in routes.ts (lines 1626–1653) use the fork's simplified version without `isServiceMode` and `updateInProgress`. Since `system-routes.ts` already has the full upstream update-check implementation (lines 58–89 with `isServiceMode`, `updateInProgress`, `POST /update`), the fork's stripped-down inline version is redundant.
- The fork also has `/settings` GET/PUT inline (lines 1456–1491) using `getSettings`/`updateSettings` imported from `settings-manager.js`. Check if `registerSettingsRoutes` (line 1017) covers this.
- Action: Take upstream block, verify `registerSettingsRoutes` covers the settings API. Drop the dead imports in Block 1.

---

### 2. `web/src/App.tsx`

**Two conflict blocks:**

**Block 1 (lines 13–22) — Imports:**
- HEAD: Eager imports of `Playground`, `SettingsPage`, `PromptsPage`, `EnvManager`, `CronManager`, `TerminalPage` (direct named imports)
- upstream/main: Imports `UpdateBanner` component

**Block 2 (lines 128–164) — useEffect hooks:**
- HEAD: Empty block (no diff tracking or update polling in the component)
- upstream/main: Two useEffects added:
  1. Git changed-files count sync (runs even when diff tab is closed)
  2. Update polling every 5 minutes via `api.checkForUpdate()`

**Important context:** Lines 29–36 (after the conflict) show upstream already has the lazy-loaded versions of Playground/SettingsPage/etc. The HEAD conflict block tries to import them eagerly, which conflicts with the lazy versions already defined below the conflict marker.

**Recommendation:**
- For Block 1: Take upstream (import `UpdateBanner`)... BUT the fork deleted UpdateBanner from HEAD. Since the fork intentionally removed UpdateBanner, take neither — drop the `UpdateBanner` import and instead keep the lazy imports that are already defined below line 29. The HEAD eager imports are superseded by the lazy ones below.
- For Block 2: The update polling `useEffect` from upstream should be DROPPED because the fork's model is informational-only (no auto-polling in App). The git changed-files count sync effect from upstream is a useful feature addition — TAKE it.
- However: The git changed-files effect references `api.checkForUpdate()` pattern; the fork's `api.ts` may not have `checkForUpdate`. Verify this.

---

### 3. `web/src/api.ts`

**One conflict block (lines 201–215) — `CreateSessionOpts` interface:**
- HEAD adds: `resumeSessionId?: string` field AND defines `CliSessionInfo` interface with `sessionId`, `project`, `cwd`, `lastModified`
- upstream/main adds: `resumeSessionAt?: string` and `forkSession?: boolean` fields

**Critical observation:** The fork uses `resumeSessionId` (a custom field for external Claude session resumption). Upstream uses `resumeSessionAt` and `forkSession` (the official upstream fields). Looking at `routes.ts`, the server already uses `resumeSessionAt` and `forkSession` throughout session creation (lines 72–75, 333–336). The fork's `resumeSessionId` in api.ts doesn't match what the server expects.

Also: The fork declares `CliSessionInfo` inside the HEAD conflict block, and line 770 calls `listCliSessions: () => get<CliSessionInfo[]>("/sessions/cli-sessions")`. The `CliSessionInfo` type needs to be preserved.

**Recommendation:**
- Take upstream fields (`resumeSessionAt`, `forkSession`) — the server already uses them
- Separately preserve `CliSessionInfo` interface (move it outside the conflict zone — it's an independent addition for the resume-session feature)
- The `resumeSessionId` custom field should be dropped since the server uses `resumeSessionAt`

---

### 4. `web/src/components/Playground.tsx`

**One conflict block (line 14–17) — import:**
- HEAD: `import type { GitHubPRInfo } from "../api.js"`
- upstream/main: `import type { UpdateInfo, GitHubPRInfo, LinearIssue, LinearComment } from "../api.js"`

**Recommendation:**
- Take upstream (it adds `UpdateInfo`, `LinearIssue`, `LinearComment` to the import)
- BUT: Since the fork removed UpdateBanner and the informational-only model doesn't use `UpdateInfo` in the Playground, check if `UpdateInfo` is actually used in the Playground component body. If not, can safely drop `UpdateInfo` from the import.
- `LinearIssue` and `LinearComment` are likely used in mock data — keep those.

---

### 5. `web/src/components/SettingsPage.test.tsx`

**Two conflict blocks:**

**Block 1 (lines 12–17) — `MockStoreState` interface:**
- HEAD: No additional fields
- upstream/main: Adds `setUpdateInfo`, `setUpdateOverlayActive`, `setEditorTabEnabled` mock functions

**Block 2 (lines 30–35) — `createMockState` factory:**
- HEAD: No additional mock implementations
- upstream/main: Adds implementations for the three new fields

**Block 3 (lines 324–335) — test body for "shows auto-update info in settings":**
- HEAD: Asserts `screen.getByText("Updates")` exists and contains `wilco update` copy
- upstream/main: Asserts clicking "Update & Restart" triggers `mockApi.triggerUpdate` and `mockState.setUpdateOverlayActive(true)`

**Recommendation:**
- For Blocks 1 & 2: The fork's SettingsPage uses `setEditorTabEnabled` from the store (line 45 of SettingsPage.tsx references `setStoreEditorTabEnabled`). So `setEditorTabEnabled` mock IS needed. Take upstream for those fields.
- For Block 3: The fork's SettingsPage shows an informational "Updates" section (not a trigger button). The upstream test expects a trigger button. Take HEAD version of the test — it matches the fork's actual SettingsPage implementation.
- BUT: The mock state needs `setUpdateInfo` and `setUpdateOverlayActive` even if unused in the test body, because SettingsPage.tsx in HEAD doesn't use them... wait — SettingsPage.tsx in HEAD (lines 28–34) shows upstream adds `updateInfo`, `setUpdateInfo`, `setUpdateOverlayActive`. The fork's SettingsPage.tsx does NOT import those. So the mock state fields are only needed if the component under test uses them.

---

### 6. `web/src/components/SettingsPage.tsx`

**Two conflict blocks:**

**Block 1 (lines 28–34) — store selectors:**
- HEAD: No update-related store selectors
- upstream/main: Adds `updateInfo`, `setUpdateInfo`, `setUpdateOverlayActive`, `setStoreEditorTabEnabled`

**Note:** `setStoreEditorTabEnabled` appears in the upstream block at line 33, but it's ALSO used below at lines 45 and 69 in code that's outside conflict markers. This means the fork's HEAD is broken — those lines 45 and 69 reference `setStoreEditorTabEnabled` which is only defined in the upstream conflict block.

**Block 2 (lines 80–115) — onCheckUpdates/onTriggerUpdate functions:**
- HEAD: Empty
- upstream/main: Adds `onCheckUpdates()` and `onTriggerUpdate()` functions that call `api.forceCheckForUpdate()` and `api.triggerUpdate()`

**BUT:** The fork's SettingsPage JSX (after line 116) has an "Updates" section (lines 256–260) that says "Updates are applied automatically via wilco update..." — this is the fork's informational text. It does NOT use `onCheckUpdates` or `onTriggerUpdate`. So the fork intentionally removed the interactive update functions.

**Recommendation:**
- Block 1: MUST take `setStoreEditorTabEnabled` from upstream (it's referenced in lines 45/69 outside the conflict). The update-related fields (`updateInfo`, `setUpdateInfo`, `setUpdateOverlayActive`) can be dropped since the fork's JSX doesn't use them.
- Block 2: Take HEAD (empty) — the fork intentionally removed the trigger functions.

---

### 7. `web/src/components/UpdateBanner.tsx` (MODIFY/DELETE conflict)

- HEAD: Deleted this file
- upstream/main: Modified it (adds `api.triggerUpdate()`, `isServiceMode` check, `UpdateOverlay` reference)

**Recommendation:** Take HEAD (keep deleted). The fork intentionally removed UpdateBanner. The upstream changes to UpdateBanner are not needed since the fork's update model is informational-only. UpdateBanner is no longer imported anywhere in the fork's App.tsx.

---

### 8. `web/src/store.ts`

**Four conflict blocks:**

**Block 1 (lines 3–24) — imports:**
- HEAD: `import type { PRStatusResponse, CreationProgressEvent } from "./api.js"`
- upstream/main: Also imports `UpdateInfo`, `LinearIssue`; adds helper functions `deleteFromMap` and `deleteFromSet`; adds imports from `task-panel-sections.js`

**Block 2 (lines 95–101) — AppState interface:**
- HEAD: Empty (no update fields)
- upstream/main: Adds `updateInfo: UpdateInfo | null`, `updateDismissedVersion: string | null`, `updateOverlayActive: boolean`

**Block 3 (lines 199–206) — Action interface:**
- HEAD: Empty
- upstream/main: Adds `setUpdateInfo`, `dismissUpdate`, `setUpdateOverlayActive`, `setEditorTabEnabled` action signatures

**Block 4 (lines 334–339) — Initial state:**
- HEAD: Empty
- upstream/main: Adds initial values: `updateInfo: null`, `updateDismissedVersion: getInitialDismissedVersion()`, `updateOverlayActive: false`

**Block 5 (lines 744–754) — Action implementations:**
- HEAD: Empty
- upstream/main: Implements `setUpdateInfo`, `dismissUpdate` (with localStorage), `setUpdateOverlayActive`, `setEditorTabEnabled`

**Critical:** The `deleteFromMap` / `deleteFromSet` helpers from upstream are used throughout the `removeSession` action below (lines 476–507) which is outside conflict markers. If you take HEAD (no helpers), `removeSession` will be broken since it references those functions.

Also: `TaskPanelConfig` types and `task-panel-sections.js` import from upstream are used in the `taskPanelConfig` state and related actions (lines 119, 412, 416, etc.) — those references exist outside conflict markers.

**Recommendation:**
- Block 1: Take upstream — the helpers and additional imports are required by code outside the conflict markers
- Block 2: Take HEAD for the update fields (fork doesn't need `updateInfo`, `updateDismissedVersion`, `updateOverlayActive` in store since it's informational-only)
- Block 3: Keep `setEditorTabEnabled` from upstream (SettingsPage uses it). Drop `setUpdateInfo`, `dismissUpdate`, `setUpdateOverlayActive` unless needed.
- Block 4: Drop update initial state (keep HEAD empty)
- Block 5: Keep `setEditorTabEnabled` implementation. Drop update action implementations.

---

## Resolution Strategy Summary

| File | Strategy |
|------|----------|
| `routes.ts` | Take upstream block: drop dead inline routes, keep `registerSkillRoutes`/`registerCronRoutes`. Drop the dead update-check/settings/usage-limits imports in Block 1 (they're in sub-route files now). |
| `App.tsx` | Block 1: Drop both (eager imports superseded by lazy ones below; UpdateBanner deleted in fork). Block 2: Take the git changed-files useEffect from upstream; DROP the update polling useEffect. |
| `api.ts` | Take upstream fields (`resumeSessionAt`, `forkSession`). Move `CliSessionInfo` interface outside the conflict block as a separate fork addition. Drop `resumeSessionId`. |
| `Playground.tsx` | Take upstream import but drop `UpdateInfo` if unused in component body. Keep `LinearIssue`, `LinearComment`. |
| `SettingsPage.test.tsx` | Blocks 1 & 2: Take upstream (mock state needs `setEditorTabEnabled`). Block 3 (test body): Take HEAD (informational update section, not trigger button). |
| `SettingsPage.tsx` | Block 1: Keep only `setStoreEditorTabEnabled` from upstream (required); drop `updateInfo`/`setUpdateInfo`/`setUpdateOverlayActive`. Block 2: Take HEAD (empty — no trigger functions). |
| `UpdateBanner.tsx` | Keep deleted (take HEAD — file was intentionally removed). |
| `store.ts` | Block 1: Take upstream (helpers + imports required). Blocks 2/4: Take HEAD (no update state). Block 3: Keep `setEditorTabEnabled` action only. Block 5: Keep only `setEditorTabEnabled` implementation. |

## Key Risks to Watch

1. **SettingsPage.tsx + store.ts coupling**: `setStoreEditorTabEnabled` must exist in both the store action interface AND the store implementation. The upstream adds it; the fork must keep it.

2. **routes.ts duplicate routes**: If HEAD block is taken (wrong choice), routes like `/update-check`, `/usage-limits`, `/terminal` would be registered TWICE (once inline, once via `registerSystemRoutes`).

3. **api.ts `CliSessionInfo` interface**: Used at line 770 (`listCliSessions`). Must be preserved as a standalone interface outside the conflict zone.

4. **store.ts `deleteFromMap`/`deleteFromSet`**: Used in `removeSession` action outside conflict markers. MUST take upstream Block 1 or add these helpers manually.

5. **`checkForUpdate` API method**: Referenced in upstream's App.tsx useEffect. The fork's `api.ts` does NOT export `checkForUpdate` — only `listCliSessions`. If the git changed-files useEffect is taken from App.tsx but not the update polling, this is fine.
