/**
 * Tests for SessionLifecycleManager.
 *
 * Validates the auto-archive/respawn lifecycle:
 * - Idle detection based on num_turns staleness
 * - Activity guard preventing archive of recently-active sessions
 * - Archive flow: kill + setArchived on both launcher and store
 * - Respawn flow: launch new session with same cwd/backendType
 * - Handoff injection: prompt old session before archiving
 * - Disabled lifecycle: "manual" setting prevents all archiving
 * - Skipping already-archived sessions
 * - Compaction guard: don't archive while compacting
 */

// Set handoff wait to 0ms so tests don't hang for 30s
process.env.COMPANION_HANDOFF_WAIT_MS = "0";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionLifecycleManager } from "./session-lifecycle.js";
import type { LifecycleConfig } from "./session-lifecycle.js";
import type { SdkSessionInfo } from "./cli-launcher.js";
import type { SessionState } from "./session-types.js";

// ─── Mock factories ────────────────────────────────────────────────────────

function makeMockLauncher(sessions: SdkSessionInfo[] = []) {
  return {
    listSessions: vi.fn(() => sessions),
    getSession: vi.fn((id: string) => sessions.find((s) => s.sessionId === id)),
    setArchived: vi.fn(),
    kill: vi.fn(async () => true),
    isAlive: vi.fn((id: string) => {
      const s = sessions.find((x) => x.sessionId === id);
      return !!s && s.state !== "exited";
    }),
    launch: vi.fn((opts: Record<string, unknown>) => ({
      sessionId: "new-session-id",
      state: "starting" as const,
      cwd: opts.cwd as string,
      createdAt: Date.now(),
      backendType: opts.backendType || "claude",
    })),
  };
}

function makeMockBridge(stateMap: Map<string, SessionState> = new Map()) {
  return {
    injectUserMessage: vi.fn(),
    getSession: vi.fn((id: string) => {
      const state = stateMap.get(id);
      if (!state) return undefined;
      return { state };
    }),
  };
}

function makeMockStore() {
  return {
    setArchived: vi.fn(() => true),
  };
}

function makeSessionInfo(overrides: Partial<SdkSessionInfo> = {}): SdkSessionInfo {
  return {
    sessionId: "test-session-1",
    state: "running",
    cwd: "/home/user/project",
    createdAt: Date.now() - 72 * 60 * 60 * 1000, // 72h ago
    backendType: "claude",
    ...overrides,
  };
}

function makeSessionState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: "test-session-1",
    model: "claude-sonnet-4-6",
    cwd: "/home/user/project",
    tools: [],
    permissionMode: "default",
    claude_code_version: "1.0.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 5,
    context_used_percent: 30,
    is_compacting: false,
    git_branch: "main",
    is_worktree: false,
    is_containerized: false,
    repo_root: "/home/user/project",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("SessionLifecycleManager", () => {
  let manager: SessionLifecycleManager;

  afterEach(() => {
    manager?.stop();
  });

  // ── Idle detection ─────────────────────────────────────────────────────

  describe("idle detection", () => {
    it("archives a session that has been idle longer than the timeout", async () => {
      const sessions = [makeSessionInfo({ sessionId: "idle-1" })];
      const stateMap = new Map([
        ["idle-1", makeSessionState({ session_id: "idle-1", num_turns: 5 })],
      ]);

      const launcher = makeMockLauncher(sessions);
      const bridge = makeMockBridge(stateMap);
      const store = makeMockStore();

      const config: LifecycleConfig = {
        enabled: true,
        idleTimeoutMs: 0, // immediate for fast test
        checkIntervalMs: 60_000,
        handoffEnabled: false,
        autoRespawnEnabled: false,
        maxSessionAgeMs: 0,
        activityGuardMs: 0, // disable guard for this test
      };

      manager = new SessionLifecycleManager(launcher as any, bridge as any, store as any, config);

      // First check: records num_turns snapshot
      await manager._checkForTest();

      // Second check: detects idle (idleTimeoutMs=0), triggers archive
      await manager._checkForTest();

      expect(launcher.kill).toHaveBeenCalledWith("idle-1");
      expect(launcher.setArchived).toHaveBeenCalledWith("idle-1", true);
      expect(store.setArchived).toHaveBeenCalledWith("idle-1", true);
    });

    it("does NOT archive a session whose num_turns changed between checks", async () => {
      const sessions = [makeSessionInfo({ sessionId: "active-1" })];
      const stateMap = new Map([
        ["active-1", makeSessionState({ session_id: "active-1", num_turns: 5 })],
      ]);

      const launcher = makeMockLauncher(sessions);
      const bridge = makeMockBridge(stateMap);
      const store = makeMockStore();

      const config: LifecycleConfig = {
        enabled: true,
        idleTimeoutMs: 0, // very short
        checkIntervalMs: 60_000,
        handoffEnabled: false,
        autoRespawnEnabled: false,
        maxSessionAgeMs: 0,
        activityGuardMs: 0,
      };

      manager = new SessionLifecycleManager(launcher as any, bridge as any, store as any, config);

      // First check: records snapshot
      await manager._checkForTest();

      // Simulate activity: bump num_turns
      stateMap.get("active-1")!.num_turns = 10;

      // Second check: detects activity change, resets timer
      await manager._checkForTest();

      // Should NOT archive because activity was detected
      expect(launcher.kill).not.toHaveBeenCalled();
    });
  });

  // ── Guards ────────────────────────────────────────────────────────

  describe("guards", () => {
    it("does NOT archive a session that is compacting", async () => {
      const sessions = [makeSessionInfo({ sessionId: "compact-1" })];
      const stateMap = new Map([
        ["compact-1", makeSessionState({
          session_id: "compact-1",
          num_turns: 5,
          is_compacting: true,
        })],
      ]);

      const launcher = makeMockLauncher(sessions);
      const bridge = makeMockBridge(stateMap);
      const store = makeMockStore();

      const config: LifecycleConfig = {
        enabled: true,
        idleTimeoutMs: 0,
        checkIntervalMs: 60_000,
        handoffEnabled: false,
        autoRespawnEnabled: false,
        maxSessionAgeMs: 0,
        activityGuardMs: 0,
      };

      manager = new SessionLifecycleManager(launcher as any, bridge as any, store as any, config);

      await manager._checkForTest();
      await manager._checkForTest();

      expect(launcher.kill).not.toHaveBeenCalled();
    });

    it("skips already-archived sessions", async () => {
      const sessions = [makeSessionInfo({ sessionId: "already-arch", archived: true })];
      const stateMap = new Map([
        ["already-arch", makeSessionState({ session_id: "already-arch", num_turns: 5 })],
      ]);

      const launcher = makeMockLauncher(sessions);
      const bridge = makeMockBridge(stateMap);
      const store = makeMockStore();

      const config: LifecycleConfig = {
        enabled: true,
        idleTimeoutMs: 0,
        checkIntervalMs: 60_000,
        handoffEnabled: false,
        autoRespawnEnabled: false,
        maxSessionAgeMs: 0,
        activityGuardMs: 0,
      };

      manager = new SessionLifecycleManager(launcher as any, bridge as any, store as any, config);

      await manager._checkForTest();
      await manager._checkForTest();

      expect(launcher.kill).not.toHaveBeenCalled();
    });
  });

  // ── Archive flow ──────────────────────────────────────────────────────

  describe("archive flow", () => {
    it("kills CLI and sets archived on both launcher and store", async () => {
      const sessions = [makeSessionInfo({ sessionId: "arch-1" })];
      const stateMap = new Map([
        ["arch-1", makeSessionState({ session_id: "arch-1", num_turns: 5 })],
      ]);

      const launcher = makeMockLauncher(sessions);
      const bridge = makeMockBridge(stateMap);
      const store = makeMockStore();

      const config: LifecycleConfig = {
        enabled: true,
        idleTimeoutMs: 0,
        checkIntervalMs: 60_000,
        handoffEnabled: false,
        autoRespawnEnabled: false,
        maxSessionAgeMs: 0,
        activityGuardMs: 0,
      };

      manager = new SessionLifecycleManager(launcher as any, bridge as any, store as any, config);

      // First check: snapshot. Second check: idle detected.
      await manager._checkForTest();
      await manager._checkForTest();

      expect(launcher.kill).toHaveBeenCalledWith("arch-1");
      expect(launcher.setArchived).toHaveBeenCalledWith("arch-1", true);
      expect(store.setArchived).toHaveBeenCalledWith("arch-1", true);
    });
  });

  // ── Respawn flow ──────────────────────────────────────────────────────

  describe("respawn flow", () => {
    it("launches a new session with the same cwd and backendType after archive", async () => {
      const sessions = [makeSessionInfo({
        sessionId: "resp-1",
        cwd: "/home/user/myrepo",
        backendType: "codex",
      })];
      const stateMap = new Map([
        ["resp-1", makeSessionState({ session_id: "resp-1", num_turns: 5 })],
      ]);

      const launcher = makeMockLauncher(sessions);
      const bridge = makeMockBridge(stateMap);
      const store = makeMockStore();

      const config: LifecycleConfig = {
        enabled: true,
        idleTimeoutMs: 0,
        checkIntervalMs: 60_000,
        handoffEnabled: false,
        autoRespawnEnabled: true,
        maxSessionAgeMs: 0,
        activityGuardMs: 0,
      };

      manager = new SessionLifecycleManager(launcher as any, bridge as any, store as any, config);

      await manager._checkForTest();
      await manager._checkForTest();

      expect(launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/home/user/myrepo",
          backendType: "codex",
        }),
      );
    });

    it("does NOT respawn when autoRespawnEnabled is false", async () => {
      const sessions = [makeSessionInfo({ sessionId: "no-resp-1" })];
      const stateMap = new Map([
        ["no-resp-1", makeSessionState({ session_id: "no-resp-1", num_turns: 5 })],
      ]);

      const launcher = makeMockLauncher(sessions);
      const bridge = makeMockBridge(stateMap);
      const store = makeMockStore();

      const config: LifecycleConfig = {
        enabled: true,
        idleTimeoutMs: 0,
        checkIntervalMs: 60_000,
        handoffEnabled: false,
        autoRespawnEnabled: false,
        maxSessionAgeMs: 0,
        activityGuardMs: 0,
      };

      manager = new SessionLifecycleManager(launcher as any, bridge as any, store as any, config);

      await manager._checkForTest();
      await manager._checkForTest();

      expect(launcher.launch).not.toHaveBeenCalled();
    });
  });

  // ── Handoff injection ─────────────────────────────────────────────────

  describe("handoff injection", () => {
    it("injects handoff prompt into CLI before archiving when alive", async () => {
      const sessions = [makeSessionInfo({ sessionId: "ho-1" })];
      const stateMap = new Map([
        ["ho-1", makeSessionState({ session_id: "ho-1", num_turns: 5 })],
      ]);

      const launcher = makeMockLauncher(sessions);
      const bridge = makeMockBridge(stateMap);
      const store = makeMockStore();

      const config: LifecycleConfig = {
        enabled: true,
        idleTimeoutMs: 0,
        checkIntervalMs: 60_000,
        handoffEnabled: true,
        autoRespawnEnabled: false,
        maxSessionAgeMs: 0,
        activityGuardMs: 0,
      };

      manager = new SessionLifecycleManager(launcher as any, bridge as any, store as any, config);

      await manager._checkForTest();
      await manager._checkForTest();

      expect(bridge.injectUserMessage).toHaveBeenCalledWith(
        "ho-1",
        expect.stringContaining("progress summary"),
      );
      expect(launcher.kill).toHaveBeenCalledWith("ho-1");
    });

    it("skips handoff when CLI is not alive", async () => {
      const sessions = [makeSessionInfo({ sessionId: "dead-1", state: "exited" })];
      const stateMap = new Map([
        ["dead-1", makeSessionState({ session_id: "dead-1", num_turns: 5 })],
      ]);

      const launcher = makeMockLauncher(sessions);
      launcher.isAlive.mockReturnValue(false);
      const bridge = makeMockBridge(stateMap);
      const store = makeMockStore();

      const config: LifecycleConfig = {
        enabled: true,
        idleTimeoutMs: 0,
        checkIntervalMs: 60_000,
        handoffEnabled: true,
        autoRespawnEnabled: false,
        maxSessionAgeMs: 0,
        activityGuardMs: 0,
      };

      manager = new SessionLifecycleManager(launcher as any, bridge as any, store as any, config);

      await manager._checkForTest();
      await manager._checkForTest();

      // Should NOT inject handoff into a dead CLI
      expect(bridge.injectUserMessage).not.toHaveBeenCalled();
      // Should still archive
      expect(launcher.setArchived).toHaveBeenCalledWith("dead-1", true);
    });
  });

  // ── Disabled lifecycle ────────────────────────────────────────────────

  describe("disabled lifecycle", () => {
    it("does nothing when start() is called with enabled=false", () => {
      const launcher = makeMockLauncher([]);
      const bridge = makeMockBridge();
      const store = makeMockStore();

      const config: LifecycleConfig = {
        enabled: false,
        idleTimeoutMs: 1000,
        checkIntervalMs: 60_000,
        handoffEnabled: false,
        autoRespawnEnabled: false,
        maxSessionAgeMs: 0,
        activityGuardMs: 0,
      };

      manager = new SessionLifecycleManager(launcher as any, bridge as any, store as any, config);
      manager.start();

      // Timer should not have been set
      expect(launcher.listSessions).not.toHaveBeenCalled();
    });
  });

  // ── Stop method ───────────────────────────────────────────────────────

  describe("stop", () => {
    it("clears the interval timer", () => {
      const launcher = makeMockLauncher([]);
      const bridge = makeMockBridge();
      const store = makeMockStore();

      const config: LifecycleConfig = {
        enabled: true,
        idleTimeoutMs: 1000,
        checkIntervalMs: 60_000,
        handoffEnabled: false,
        autoRespawnEnabled: false,
        maxSessionAgeMs: 0,
        activityGuardMs: 0,
      };

      manager = new SessionLifecycleManager(launcher as any, bridge as any, store as any, config);
      manager.start();
      manager.stop();

      // Should not throw — stop is idempotent
      manager.stop();
    });
  });

  // ── Max session age ─────────────────────────────────────────────────

  describe("max session age", () => {
    it("archives a session that exceeds max age even if still active", async () => {
      // Session created 25h ago (exceeds 24h max age)
      const sessions = [makeSessionInfo({
        sessionId: "old-1",
        createdAt: Date.now() - 25 * 60 * 60 * 1000,
      })];
      const stateMap = new Map([
        ["old-1", makeSessionState({ session_id: "old-1", num_turns: 5 })],
      ]);

      const launcher = makeMockLauncher(sessions);
      const bridge = makeMockBridge(stateMap);
      const store = makeMockStore();

      const config: LifecycleConfig = {
        enabled: true,
        idleTimeoutMs: 48 * 60 * 60 * 1000,
        maxSessionAgeMs: 24 * 60 * 60 * 1000, // 24h
        checkIntervalMs: 60_000,
        handoffEnabled: false,
        autoRespawnEnabled: false,
        activityGuardMs: 0,
      };

      manager = new SessionLifecycleManager(launcher as any, bridge as any, store as any, config);

      // First check: records snapshot
      await manager._checkForTest();

      // Simulate activity (num_turns changed) — session is NOT idle
      stateMap.get("old-1")!.num_turns = 10;

      // Second check: should still archive because max age exceeded
      await manager._checkForTest();

      expect(launcher.kill).toHaveBeenCalledWith("old-1");
      expect(launcher.setArchived).toHaveBeenCalledWith("old-1", true);
    });

    it("does NOT archive a young session even if idle", async () => {
      // Session created 2h ago (under 24h max age)
      const sessions = [makeSessionInfo({
        sessionId: "young-1",
        createdAt: Date.now() - 2 * 60 * 60 * 1000,
      })];
      const stateMap = new Map([
        ["young-1", makeSessionState({ session_id: "young-1", num_turns: 5 })],
      ]);

      const launcher = makeMockLauncher(sessions);
      const bridge = makeMockBridge(stateMap);
      const store = makeMockStore();

      const config: LifecycleConfig = {
        enabled: true,
        idleTimeoutMs: 48 * 60 * 60 * 1000, // 48h idle (won't trigger)
        maxSessionAgeMs: 24 * 60 * 60 * 1000, // 24h max age (won't trigger for 2h old session)
        checkIntervalMs: 60_000,
        handoffEnabled: false,
        autoRespawnEnabled: false,
        activityGuardMs: 0,
      };

      manager = new SessionLifecycleManager(launcher as any, bridge as any, store as any, config);

      await manager._checkForTest();
      await manager._checkForTest();

      expect(launcher.kill).not.toHaveBeenCalled();
    });

    it("skips max age check when maxSessionAgeMs is 0", async () => {
      // Session created 100h ago but max age disabled
      const sessions = [makeSessionInfo({
        sessionId: "ancient-1",
        createdAt: Date.now() - 100 * 60 * 60 * 1000,
      })];
      const stateMap = new Map([
        ["ancient-1", makeSessionState({ session_id: "ancient-1", num_turns: 5 })],
      ]);

      const launcher = makeMockLauncher(sessions);
      const bridge = makeMockBridge(stateMap);
      const store = makeMockStore();

      const config: LifecycleConfig = {
        enabled: true,
        idleTimeoutMs: 200 * 60 * 60 * 1000, // very long idle (won't trigger)
        maxSessionAgeMs: 0, // disabled
        checkIntervalMs: 60_000,
        handoffEnabled: false,
        autoRespawnEnabled: false,
        activityGuardMs: 0,
      };

      manager = new SessionLifecycleManager(launcher as any, bridge as any, store as any, config);

      // Simulate activity so idle doesn't trigger
      await manager._checkForTest();
      stateMap.get("ancient-1")!.num_turns = 10;
      await manager._checkForTest();

      expect(launcher.kill).not.toHaveBeenCalled();
    });
  });

  // ── Config from settings ──────────────────────────────────────────────

  describe("configFromSettings", () => {
    it("creates config from CompanionSettings with auto mode", () => {
      const config = SessionLifecycleManager.configFromSettings({
        sessionLifecycle: "auto",
        sessionIdleTimeoutHours: 48,
        sessionMaxAgeHours: 24,
        sessionAutoRespawn: true,
        sessionHandoffEnabled: true,
      } as any);

      expect(config.enabled).toBe(true);
      expect(config.idleTimeoutMs).toBe(48 * 60 * 60 * 1000);
      expect(config.maxSessionAgeMs).toBe(24 * 60 * 60 * 1000);
      expect(config.autoRespawnEnabled).toBe(true);
      expect(config.handoffEnabled).toBe(true);
    });

    it("disables when sessionLifecycle is manual", () => {
      const config = SessionLifecycleManager.configFromSettings({
        sessionLifecycle: "manual",
        sessionIdleTimeoutHours: 48,
        sessionMaxAgeHours: 24,
        sessionAutoRespawn: true,
        sessionHandoffEnabled: true,
      } as any);

      expect(config.enabled).toBe(false);
    });
  });
});
