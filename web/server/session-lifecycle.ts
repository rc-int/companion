/**
 * Session Lifecycle Manager — auto-archive idle sessions and respawn fresh ones.
 *
 * Periodically checks all active sessions for idle timeout. When a session
 * exceeds the configured idle period (based on num_turns staleness), it:
 *  1. Optionally injects a handoff prompt (if CLI is alive)
 *  2. Kills the CLI process
 *  3. Marks the session as archived in both launcher and store
 *  4. Optionally respawns a fresh session for the same repo/cwd
 */

import { basename } from "node:path";
import type { CliLauncher, SdkSessionInfo, LaunchOptions } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { SessionStore } from "./session-store.js";
import type { CompanionSettings } from "./settings-manager.js";
import * as sessionNames from "./session-names.js";

// ─── Handoff prompt ──────────────────────────────────────────────────────────

const HANDOFF_PROMPT =
  "Session ending. Write a brief progress summary to .companion/handoff.md: " +
  "what you were working on, current state, and next steps. Keep it under 500 words.";

/** How long to wait after injecting the handoff prompt before killing. */
function getHandoffWaitMs(): number {
  return parseInt(process.env.COMPANION_HANDOFF_WAIT_MS ?? "30000", 10);
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface LifecycleConfig {
  /** Whether auto-archive is enabled (from settings: sessionLifecycle === "auto"). */
  enabled: boolean;
  /** How long a session must be idle before archiving (default: 48h). */
  idleTimeoutMs: number;
  /** Maximum session age before forced archive regardless of activity (default: 24h). 0 = disabled. */
  maxSessionAgeMs: number;
  /** How often to check sessions (default: 60s). */
  checkIntervalMs: number;
  /** Whether to inject a handoff prompt before archiving (default: true). */
  handoffEnabled: boolean;
  /** Whether to auto-respawn a fresh session after archive (default: true). */
  autoRespawnEnabled: boolean;
  /** Don't archive if session was active within this window (default: 5min). */
  activityGuardMs: number;
}

const DEFAULT_CONFIG: LifecycleConfig = {
  enabled: false,
  idleTimeoutMs: 48 * 60 * 60 * 1000,
  maxSessionAgeMs: 24 * 60 * 60 * 1000,
  checkIntervalMs: 60_000,
  handoffEnabled: true,
  autoRespawnEnabled: true,
  activityGuardMs: 5 * 60 * 1000,
};

// ─── Types for dependency injection ──────────────────────────────────────────

/** Minimal launcher interface for testability. */
interface LauncherLike {
  listSessions(): SdkSessionInfo[];
  getSession(id: string): SdkSessionInfo | undefined;
  setArchived(id: string, archived: boolean): void;
  kill(id: string): Promise<boolean>;
  isAlive(id: string): boolean;
  launch(options?: LaunchOptions): SdkSessionInfo;
}

/** Minimal bridge interface for testability. */
interface BridgeLike {
  injectUserMessage(sessionId: string, content: string): void;
  getSession(sessionId: string): { state: { num_turns: number; is_compacting: boolean } } | undefined;
}

/** Minimal store interface for testability. */
interface StoreLike {
  setArchived(sessionId: string, archived: boolean): boolean;
}

// ─── Manager ─────────────────────────────────────────────────────────────────

export class SessionLifecycleManager {
  private config: LifecycleConfig;
  private launcher: LauncherLike;
  private bridge: BridgeLike;
  private store: StoreLike;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Tracks the last-known num_turns per session to detect activity. */
  private lastTurns = new Map<string, number>();
  /** Tracks when we last saw activity (num_turns change) per session. */
  private lastActivityAt = new Map<string, number>();
  /** Sessions currently being archived (to prevent double-processing). */
  private archiving = new Set<string>();

  constructor(
    launcher: LauncherLike,
    bridge: BridgeLike,
    store: StoreLike,
    config?: Partial<LifecycleConfig>,
  ) {
    this.launcher = launcher;
    this.bridge = bridge;
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Build a LifecycleConfig from CompanionSettings values.
   */
  static configFromSettings(
    settings: Pick<
      CompanionSettings,
      "sessionLifecycle" | "sessionIdleTimeoutHours" | "sessionMaxAgeHours" | "sessionAutoRespawn" | "sessionHandoffEnabled"
    >,
  ): LifecycleConfig {
    return {
      enabled: settings.sessionLifecycle === "auto",
      idleTimeoutMs: (settings.sessionIdleTimeoutHours ?? 48) * 60 * 60 * 1000,
      maxSessionAgeMs: (settings.sessionMaxAgeHours ?? 24) * 60 * 60 * 1000,
      checkIntervalMs: DEFAULT_CONFIG.checkIntervalMs,
      handoffEnabled: settings.sessionHandoffEnabled ?? true,
      autoRespawnEnabled: settings.sessionAutoRespawn ?? true,
      activityGuardMs: DEFAULT_CONFIG.activityGuardMs,
    };
  }

  /** Start the periodic check timer. */
  start(): void {
    if (this.timer) return;
    if (!this.config.enabled) {
      console.log("[lifecycle] Auto-archive disabled (sessionLifecycle = manual)");
      return;
    }
    console.log(
      `[lifecycle] Started: idleTimeout=${this.config.idleTimeoutMs}ms, ` +
        `maxAge=${this.config.maxSessionAgeMs}ms, ` +
        `checkInterval=${this.config.checkIntervalMs}ms, ` +
        `handoff=${this.config.handoffEnabled}, respawn=${this.config.autoRespawnEnabled}`,
    );
    this.timer = setInterval(() => this.check(), this.config.checkIntervalMs);
  }

  /** Exposed for testing — runs a single check cycle. */
  async _checkForTest(): Promise<void> {
    return this.check();
  }

  /** Stop the periodic check timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── Core check loop ──────────────────────────────────────────────────

  private async check(): Promise<void> {
    const now = Date.now();
    const sessions = this.launcher.listSessions();

    for (const info of sessions) {
      // Skip archived, exited, or currently-archiving sessions
      if (info.archived) continue;
      if (info.state === "exited") continue;
      if (this.archiving.has(info.sessionId)) continue;

      // Check max session age first (absolute ceiling, regardless of activity)
      if (this.config.maxSessionAgeMs > 0) {
        const sessionAge = now - info.createdAt;
        if (sessionAge >= this.config.maxSessionAgeMs) {
          const ageHours = (sessionAge / (60 * 60 * 1000)).toFixed(1);
          console.log(`[lifecycle] Session ${info.sessionId.slice(-8)}: max age reached (${ageHours}h), archiving`);
          await this.archiveSession(info, "max_age");
          continue;
        }
      }

      // Read current state from bridge
      const bridgeSession = this.bridge.getSession(info.sessionId);
      const currentTurns = bridgeSession?.state?.num_turns ?? 0;
      const isCompacting = bridgeSession?.state?.is_compacting ?? false;

      // Update activity tracking
      const prevTurns = this.lastTurns.get(info.sessionId);
      if (prevTurns === undefined) {
        // First time seeing this session — record baseline
        this.lastTurns.set(info.sessionId, currentTurns);
        this.lastActivityAt.set(info.sessionId, now);
        continue;
      }

      if (currentTurns !== prevTurns) {
        // Activity detected: num_turns changed
        this.lastTurns.set(info.sessionId, currentTurns);
        this.lastActivityAt.set(info.sessionId, now);
        continue;
      }

      // No activity change — check idle duration
      const lastActive = this.lastActivityAt.get(info.sessionId) ?? info.createdAt;
      const idleDuration = now - lastActive;

      // Check idle timeout
      if (idleDuration < this.config.idleTimeoutMs) continue;

      // Activity guard: don't archive if recently active
      if (this.config.activityGuardMs > 0 && (now - lastActive) < this.config.activityGuardMs) {
        continue;
      }

      // Compaction guard: don't archive while compacting
      if (isCompacting) {
        console.log(`[lifecycle] Skipping session ${info.sessionId}: compacting`);
        continue;
      }

      // Archive this session
      await this.archiveSession(info, "idle_timeout");
    }
  }

  // ── Archive flow ─────────────────────────────────────────────────────

  private async archiveSession(info: SdkSessionInfo, reason: string = "idle_timeout"): Promise<void> {
    // Defensive: re-check archived flag from launcher (not the snapshot) to prevent
    // double-archive after server restarts where the reconnection watchdog may have
    // already processed this session.
    const current = this.launcher.getSession(info.sessionId);
    if (!current || current.archived) {
      console.log(`[lifecycle] Skipping archive for ${info.sessionId.slice(-8)}: already archived or removed`);
      return;
    }

    this.archiving.add(info.sessionId);

    try {
      // Step 1: Mark archived FIRST to prevent races with the reconnection
      // watchdog and other relaunch paths that check the archived flag.
      this.launcher.setArchived(info.sessionId, true);
      this.store.setArchived(info.sessionId, true);

      // Step 2: Handoff (if enabled and CLI is alive)
      if (this.config.handoffEnabled && this.launcher.isAlive(info.sessionId)) {
        console.log(`[lifecycle] Injecting handoff prompt for session ${info.sessionId}`);
        this.bridge.injectUserMessage(info.sessionId, HANDOFF_PROMPT);

        // Wait for CLI to process the handoff
        await new Promise<void>((resolve) => setTimeout(resolve, getHandoffWaitMs()));
      }

      // Step 3: Kill CLI
      await this.launcher.kill(info.sessionId);

      console.log(`[lifecycle] Auto-archived session ${info.sessionId}: reason=${reason}`);

      // Step 4: Respawn (if enabled and not an agent session — agents are
      // re-executed by the AgentExecutor on their next scheduled trigger)
      if (this.config.autoRespawnEnabled && !info.agentId) {
        await this.respawnSession(info);
      } else if (info.agentId) {
        console.log(`[lifecycle] Skipping respawn for agent session ${info.sessionId.slice(-8)} (agent: ${info.agentName || info.agentId})`);
      }
    } catch (err) {
      console.error(`[lifecycle] Error archiving session ${info.sessionId}:`, err);
    } finally {
      this.archiving.delete(info.sessionId);
      this.lastTurns.delete(info.sessionId);
      this.lastActivityAt.delete(info.sessionId);
    }
  }

  // ── Respawn flow ─────────────────────────────────────────────────────

  private async respawnSession(archivedInfo: SdkSessionInfo): Promise<void> {
    try {
      const cwd = archivedInfo.cwd;
      const backendType = archivedInfo.backendType || "claude";

      const newSession = this.launcher.launch({
        cwd,
        backendType,
        model: archivedInfo.model,
        permissionMode: archivedInfo.permissionMode,
      });

      // Carry over the session name so the user knows what this respawn is for
      const oldName = sessionNames.getName(archivedInfo.sessionId);
      if (oldName) {
        // Strip any existing recycle prefix to avoid stacking (e.g. "♻ ♻ name")
        const baseName = oldName.replace(/^♻\s*/, "");
        sessionNames.setName(newSession.sessionId, `♻ ${baseName}`);
      }

      console.log(
        `[lifecycle] Respawned session for ${basename(cwd)}: ` +
          `oldId=${archivedInfo.sessionId.slice(-8)} → newId=${newSession.sessionId.slice(-8)}`,
      );
    } catch (err) {
      console.error(
        `[lifecycle] Failed to respawn session for ${archivedInfo.cwd}:`,
        err,
      );
    }
  }
}
