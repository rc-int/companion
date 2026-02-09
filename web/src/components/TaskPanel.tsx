import { useStore } from "../store.js";
import type { TaskItem } from "../types.js";

const EMPTY_TASKS: TaskItem[] = [];

export function TaskPanel({ sessionId }: { sessionId: string }) {
  const tasks = useStore((s) => s.sessionTasks.get(sessionId) || EMPTY_TASKS);
  const taskPanelOpen = useStore((s) => s.taskPanelOpen);
  const setTaskPanelOpen = useStore((s) => s.setTaskPanelOpen);

  if (!taskPanelOpen) return null;

  return (
    <aside className="w-[280px] h-full flex flex-col bg-cc-card border-l border-cc-border">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-cc-border">
        <span className="text-sm font-semibold text-cc-fg tracking-tight">Tasks</span>
        <button
          onClick={() => setTaskPanelOpen(false)}
          className="flex items-center justify-center w-6 h-6 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {tasks.length === 0 ? (
          <p className="text-xs text-cc-muted text-center py-12">No tasks yet</p>
        ) : (
          <div className="space-y-1">
            {tasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function TaskRow({ task }: { task: TaskItem }) {
  const isCompleted = task.status === "completed";
  const isInProgress = task.status === "in_progress";

  return (
    <div
      className={`px-3 py-2 rounded-[10px] ${
        isCompleted ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-center gap-2">
        {/* Status icon */}
        <span className="shrink-0 flex items-center justify-center w-4 h-4">
          {isInProgress ? (
            <svg className="w-4 h-4 text-cc-primary animate-spin" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
            </svg>
          ) : isCompleted ? (
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-success">
              <path fillRule="evenodd" d="M8 15A7 7 0 108 1a7 7 0 000 14zm3.354-9.354a.5.5 0 00-.708-.708L7 8.586 5.354 6.94a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z" clipRule="evenodd" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="none" className="w-4 h-4 text-cc-muted">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          )}
        </span>

        {/* Subject */}
        <span className={`text-[13px] flex-1 truncate ${isCompleted ? "text-cc-muted" : "text-cc-fg"}`}>
          {task.subject}
        </span>

        {/* Task number badge */}
        <span className="shrink-0 text-[10px] text-cc-muted bg-cc-hover px-1.5 py-0.5 rounded-full tabular-nums">
          {task.id}
        </span>
      </div>

      {/* Active form text (in_progress only) */}
      {isInProgress && task.activeForm && (
        <p className="mt-1 ml-6 text-[11px] text-cc-muted italic truncate">
          {task.activeForm}
        </p>
      )}

      {/* Blocked by */}
      {task.blockedBy && task.blockedBy.length > 0 && (
        <p className="mt-1 ml-6 text-[11px] text-cc-muted flex items-center gap-1">
          <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3 shrink-0">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M5 8h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span>blocked by {task.blockedBy.map((b) => `#${b}`).join(", ")}</span>
        </p>
      )}
    </div>
  );
}
