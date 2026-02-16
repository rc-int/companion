import { useState } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";

export function UpdateBanner() {
  const updateInfo = useStore((s) => s.updateInfo);
  const dismissedVersion = useStore((s) => s.updateDismissedVersion);
  const dismissUpdate = useStore((s) => s.dismissUpdate);
  const [updating, setUpdating] = useState(false);

  if (!updateInfo) return null;

  const wilcoUpdate = updateInfo.wilco.updateAvailable;
  const companionUpdate = updateInfo.companion.updateAvailable;
  if (!wilcoUpdate && !companionUpdate) return null;

  // Composite dismiss key: "wilcoLatest+companionLatest"
  const dismissKey = `${updateInfo.wilco.latest ?? updateInfo.wilco.current}+${updateInfo.companion.latest ?? updateInfo.companion.current}`;
  if (dismissedVersion === dismissKey) return null;

  const handleUpdate = async () => {
    setUpdating(true);
    try {
      await api.triggerUpdate();
    } catch (err) {
      console.error("Update failed:", err);
      setUpdating(false);
    }
  };

  const handleDismiss = () => {
    dismissUpdate(dismissKey);
  };

  const inProgress = updating || updateInfo.updateInProgress;

  // Build version summary
  const parts: string[] = [];
  if (wilcoUpdate) {
    parts.push(`wilco ${updateInfo.wilco.current} → ${updateInfo.wilco.latest}`);
  }
  if (companionUpdate) {
    parts.push(`companion ${updateInfo.companion.current} → ${updateInfo.companion.latest}`);
  }

  return (
    <div className="px-4 py-1.5 bg-cc-primary/10 border-b border-cc-primary/20 flex items-center justify-center gap-3 animate-[fadeSlideIn_0.2s_ease-out]">
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-primary shrink-0">
        <path d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm0 2a.75.75 0 0 0-.75.75v3.69L5.78 6.15a.75.75 0 0 0-.96 1.15l2.5 2.08a.75.75 0 0 0 1.08-.12l2-2.5a.75.75 0 1 0-1.17-.94L8.75 6.5V3.75A.75.75 0 0 0 8 3z" />
      </svg>

      <span className="text-xs text-cc-fg">
        {parts.join(", ")}
      </span>

      <button
        onClick={handleUpdate}
        disabled={inProgress}
        className="text-xs font-medium px-2.5 py-0.5 rounded-md bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {inProgress ? "Updating..." : "Update & Restart"}
      </button>

      <button
        onClick={handleDismiss}
        className="text-cc-muted hover:text-cc-fg transition-colors cursor-pointer ml-auto"
        title="Dismiss"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}
