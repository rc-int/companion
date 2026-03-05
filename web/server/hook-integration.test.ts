/**
 * Integration test for the hooks gateway.
 * Tests the full flow: HTTP POST → handler → DB mock → WebSocket broadcast.
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { registerHookRoutes } from "./routes/hook-routes.js";

// Mock session-db — integration test validates the full route→handler→broadcast chain
vi.mock("./session-db.js", () => ({
  registerSession: vi.fn().mockResolvedValue(undefined),
  getActiveSessions: vi.fn().mockResolvedValue([
    { id: "peer-abc", working_on: "implementing auth" },
  ]),
}));

describe("hooks gateway integration", () => {
  /** Full SessionStart flow: register session, get peers, broadcast, return context */
  it("full SessionStart flow: register + peers + broadcast", async () => {
    const broadcasts: unknown[] = [];
    const app = new Hono();
    registerHookRoutes(app, {
      wsBridge: {
        broadcastToSession: (_id: string, msg: unknown) =>
          broadcasts.push(msg),
      },
    });

    const res = await app.request("/hooks/session-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "new-session-456",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/home/kev/wilco",
        permission_mode: "default",
        hook_event_name: "SessionStart",
        source: "startup",
        model: "claude-opus-4-6",
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();

    // Verify context includes peer session info
    expect(json.hookSpecificOutput?.additionalContext).toContain("peer-abc");
    expect(json.hookSpecificOutput?.additionalContext).toContain(
      "implementing auth",
    );

    // Verify broadcast was sent with correct shape
    expect(broadcasts).toHaveLength(1);
    const bc = broadcasts[0] as Record<string, unknown>;
    expect(bc.type).toBe("hook_event");
    expect(bc.event).toBe("SessionStart");
    expect(bc.session_id).toBe("new-session-456");
    expect(bc.timestamp).toBeTypeOf("number");
  });

  /** Full SessionEnd flow: handler runs cache cleanup + broadcast fires */
  it("full SessionEnd flow: handler + broadcast", async () => {
    const broadcasts: unknown[] = [];
    const app = new Hono();
    registerHookRoutes(app, {
      wsBridge: {
        broadcastToSession: (_id: string, msg: unknown) =>
          broadcasts.push(msg),
      },
    });

    const res = await app.request("/hooks/session-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "ending-session-789",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/tmp/nonexistent-project",
        permission_mode: "default",
        hook_event_name: "SessionEnd",
        reason: "prompt_input_exit",
      }),
    });

    expect(res.status).toBe(200);

    // Verify broadcast
    expect(broadcasts).toHaveLength(1);
    const bc = broadcasts[0] as Record<string, unknown>;
    expect(bc.event).toBe("SessionEnd");
    expect(bc.session_id).toBe("ending-session-789");
    expect(bc.reason).toBe("prompt_input_exit");
  });

  /** Verifies that unknown hook endpoints return 404, not 500 */
  it("unknown hook endpoint returns 404 cleanly", async () => {
    const app = new Hono();
    registerHookRoutes(app);

    const res = await app.request("/hooks/FutureEvent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "x" }),
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Unknown hook event");
  });
});
