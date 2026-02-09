import { useState, useEffect, useRef } from "react";
import { useStore } from "../store.js";
import { sendToSession } from "../ws.js";

const MODEL_OPTIONS = [
  { label: "Opus 4.6", value: "claude-opus-4-6" },
  { label: "Sonnet 4.5", value: "claude-sonnet-4-5-20250929" },
  { label: "Haiku 4.5", value: "claude-haiku-4-5-20251001" },
] as const;

export function TopBar() {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const sessions = useStore((s) => s.sessions);
  const cliConnected = useStore((s) => s.cliConnected);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const previousPermissionMode = useStore((s) => s.previousPermissionMode);
  const taskPanelOpen = useStore((s) => s.taskPanelOpen);
  const setTaskPanelOpen = useStore((s) => s.setTaskPanelOpen);

  const session = currentSessionId ? sessions.get(currentSessionId) : null;
  const isConnected = currentSessionId ? (cliConnected.get(currentSessionId) ?? false) : false;
  const status = currentSessionId ? (sessionStatus.get(currentSessionId) ?? null) : null;

  return (
    <header className="shrink-0 flex items-center justify-between px-4 py-2.5 bg-cc-card border-b border-cc-border">
      <div className="flex items-center gap-3">
        {/* Sidebar toggle */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="flex items-center justify-center w-7 h-7 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
          </svg>
        </button>

        {/* Connection status */}
        {currentSessionId && (
          <div className="flex items-center gap-1.5">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                isConnected ? "bg-cc-success" : "bg-cc-muted opacity-40"
              }`}
            />
            <span className="text-[11px] text-cc-muted hidden sm:inline">
              {isConnected ? "Connected" : "Disconnected"}
            </span>
          </div>
        )}
      </div>

      {/* Session info */}
      {session && (
        <div className="flex items-center gap-4 text-[12px] text-cc-muted">
          {session.model && (
            <ModelSwitcher
              sessionId={currentSessionId!}
              currentModel={session.model}
              isConnected={isConnected}
            />
          )}

          <PlanModeToggle
            sessionId={currentSessionId!}
            currentMode={session.permissionMode}
            previousMode={previousPermissionMode.get(currentSessionId!) ?? "default"}
            isConnected={isConnected}
          />

          {session.total_cost_usd > 0 && (
            <div className="hidden sm:flex items-center gap-1.5">
              <span className="text-cc-border">|</span>
              <span className="text-cc-muted/60">Cost</span>
              <span className="font-medium text-cc-fg tabular-nums">${session.total_cost_usd.toFixed(4)}</span>
            </div>
          )}

          {session.context_used_percent > 0 && (
            <div className="hidden md:flex items-center gap-1.5">
              <span className="text-cc-border">|</span>
              <span className="text-cc-muted/60">Context</span>
              <div className="flex items-center gap-1.5">
                <div className="w-16 h-1.5 rounded-full bg-cc-hover overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      session.context_used_percent > 80
                        ? "bg-cc-error"
                        : session.context_used_percent > 50
                        ? "bg-cc-warning"
                        : "bg-cc-primary"
                    }`}
                    style={{ width: `${Math.min(session.context_used_percent, 100)}%` }}
                  />
                </div>
                <span className="font-medium text-cc-fg tabular-nums">{session.context_used_percent}%</span>
              </div>
            </div>
          )}

          {status === "compacting" && (
            <>
              <span className="text-cc-border">|</span>
              <span className="text-cc-warning font-medium animate-pulse">Compacting...</span>
            </>
          )}

          {status === "running" && (
            <>
              <span className="text-cc-border">|</span>
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-cc-primary animate-[pulse-dot_1s_ease-in-out_infinite]" />
                <span className="text-cc-primary font-medium">Thinking</span>
              </div>
            </>
          )}

          <span className="text-cc-border">|</span>
          <button
            onClick={() => setTaskPanelOpen(!taskPanelOpen)}
            className={`flex items-center justify-center w-7 h-7 rounded-lg transition-colors cursor-pointer ${
              taskPanelOpen
                ? "text-cc-primary bg-cc-active"
                : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
            }`}
            title="Toggle task panel"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M6 2a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2V4a2 2 0 00-2-2H6zm1 3a1 1 0 000 2h6a1 1 0 100-2H7zm0 4a1 1 0 000 2h6a1 1 0 100-2H7zm0 4a1 1 0 000 2h4a1 1 0 100-2H7z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      )}
    </header>
  );
}

function ModelSwitcher({
  sessionId,
  currentModel,
  isConnected,
}: {
  sessionId: string;
  currentModel: string;
  isConnected: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  const currentLabel =
    MODEL_OPTIONS.find((m) => m.value === currentModel)?.label ?? currentModel;

  function selectModel(value: string) {
    if (value === currentModel) {
      setOpen(false);
      return;
    }
    sendToSession(sessionId, { type: "set_model", model: value });
    useStore.getState().updateSession(sessionId, { model: value });
    setOpen(false);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => isConnected && setOpen(!open)}
        disabled={!isConnected}
        className={`flex items-center gap-1.5 cursor-pointer ${
          !isConnected ? "opacity-40 cursor-not-allowed" : "hover:text-cc-fg"
        }`}
      >
        <span className="text-cc-muted/60">Model</span>
        <span className="font-medium text-cc-fg font-mono-code text-[11px]">{currentLabel}</span>
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-muted/60">
          <path fillRule="evenodd" d="M4.22 6.22a.75.75 0 011.06 0L8 8.94l2.72-2.72a.75.75 0 111.06 1.06l-3.25 3.25a.75.75 0 01-1.06 0L4.22 7.28a.75.75 0 010-1.06z" clipRule="evenodd" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1.5 min-w-[180px] bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-50 py-1">
          {MODEL_OPTIONS.map((m) => (
            <button
              key={m.value}
              onClick={() => selectModel(m.value)}
              className="w-full flex items-center justify-between px-3 py-1.5 text-[12px] text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <span>{m.label}</span>
              {m.value === currentModel && (
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-primary">
                  <path fillRule="evenodd" d="M12.416 3.376a.75.75 0 01.208 1.04l-5 7.5a.75.75 0 01-1.154.114l-3-3a.75.75 0 011.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 011.04-.207z" clipRule="evenodd" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PlanModeToggle({
  sessionId,
  currentMode,
  previousMode,
  isConnected,
}: {
  sessionId: string;
  currentMode: string;
  previousMode: string;
  isConnected: boolean;
}) {
  const isPlan = currentMode === "plan";

  function toggle() {
    if (!isConnected) return;
    const store = useStore.getState();
    if (!isPlan) {
      store.setPreviousPermissionMode(sessionId, currentMode);
      sendToSession(sessionId, { type: "set_permission_mode", mode: "plan" });
      store.updateSession(sessionId, { permissionMode: "plan" });
    } else {
      const restoreMode = previousMode || "default";
      sendToSession(sessionId, { type: "set_permission_mode", mode: restoreMode });
      store.updateSession(sessionId, { permissionMode: restoreMode });
    }
  }

  return (
    <>
      <span className="text-cc-border">|</span>
      <button
        onClick={toggle}
        disabled={!isConnected}
        className={`px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors cursor-pointer ${
          !isConnected
            ? "opacity-40 cursor-not-allowed border border-cc-border text-cc-muted"
            : isPlan
            ? "bg-cc-primary text-white"
            : "border border-cc-border text-cc-muted hover:text-cc-fg hover:border-cc-fg/30"
        }`}
      >
        Plan
      </button>
    </>
  );
}
