import { useState, useRef } from "react";
import { useStore } from "../store.js";
import { sendToSession } from "../ws.js";

let idCounter = 0;

interface ImageAttachment {
  name: string;
  base64: string;
  mediaType: string;
}

function readFileAsBase64(file: File): Promise<{ base64: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      resolve({ base64, mediaType: file.type });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function Composer({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cliConnected = useStore((s) => s.cliConnected);
  const session = useStore((s) => s.sessions.get(sessionId));
  const previousMode = useStore((s) => s.previousPermissionMode.get(sessionId) || "bypassPermissions");

  const isConnected = cliConnected.get(sessionId) ?? false;
  const currentMode = session?.permissionMode || "default";
  const isPlan = currentMode === "plan";

  function handleSend() {
    const msg = text.trim();
    if (!msg || !isConnected) return;

    sendToSession(sessionId, {
      type: "user_message",
      content: msg,
      session_id: sessionId,
      images: images.length > 0 ? images.map((img) => ({ media_type: img.mediaType, data: img.base64 })) : undefined,
    });

    useStore.getState().appendMessage(sessionId, {
      id: `user-${Date.now()}-${++idCounter}`,
      role: "user",
      content: msg,
      timestamp: Date.now(),
    });

    setText("");
    setImages([]);

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      toggleMode();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }

  function handleInterrupt() {
    sendToSession(sessionId, { type: "interrupt" });
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    const newImages: ImageAttachment[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      const { base64, mediaType } = await readFileAsBase64(file);
      newImages.push({ name: file.name, base64, mediaType });
    }
    setImages((prev) => [...prev, ...newImages]);
    // Reset input so the same file can be re-selected
    e.target.value = "";
  }

  function removeImage(index: number) {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }

  async function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const newImages: ImageAttachment[] = [];
    for (const item of Array.from(items)) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      const { base64, mediaType } = await readFileAsBase64(file);
      newImages.push({ name: `pasted-${Date.now()}.${file.type.split("/")[1]}`, base64, mediaType });
    }
    if (newImages.length > 0) {
      e.preventDefault();
      setImages((prev) => [...prev, ...newImages]);
    }
  }

  function toggleMode() {
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

  const sessionStatus = useStore((s) => s.sessionStatus);
  const isRunning = sessionStatus.get(sessionId) === "running";
  const canSend = text.trim().length > 0 && isConnected;

  return (
    <div className="shrink-0 border-t border-cc-border bg-cc-card px-2 sm:px-4 py-2 sm:py-3">
      <div className="max-w-3xl mx-auto">
        {/* Image thumbnails */}
        {images.length > 0 && (
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            {images.map((img, i) => (
              <div key={i} className="relative group">
                <img
                  src={`data:${img.mediaType};base64,${img.base64}`}
                  alt={img.name}
                  className="w-12 h-12 rounded-lg object-cover border border-cc-border"
                />
                <button
                  onClick={() => removeImage(i)}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-cc-error text-white flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5">
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          {/* Mode toggle - left of chatbar */}
          <button
            onClick={toggleMode}
            disabled={!isConnected}
            className={`px-2.5 py-2 rounded-[10px] text-[11px] font-medium transition-colors shrink-0 cursor-pointer ${
              !isConnected
                ? "opacity-40 cursor-not-allowed border border-cc-border text-cc-muted"
                : isPlan
                ? "bg-cc-primary text-white"
                : "border border-cc-border text-cc-muted hover:text-cc-fg hover:border-cc-fg/30"
            }`}
            title={`${isPlan ? "Plan" : "Agent"} mode (Shift+Tab)`}
          >
            {isPlan ? "Plan" : "Agent"}
          </button>

          <div className="flex-1 relative">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={isConnected ? "Type a message..." : "Waiting for CLI connection..."}
              disabled={!isConnected}
              rows={1}
              className="w-full px-3.5 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-[10px] resize-none focus:outline-none focus:border-cc-primary/50 focus:ring-1 focus:ring-cc-primary/20 text-cc-fg font-sans-ui placeholder:text-cc-muted disabled:opacity-50 transition-all"
              style={{ minHeight: "40px", maxHeight: "200px" }}
            />
          </div>

          {/* Image upload button */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={!isConnected}
            className={`flex items-center justify-center w-10 h-10 rounded-[10px] transition-colors shrink-0 ${
              isConnected
                ? "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
                : "text-cc-muted opacity-50 cursor-not-allowed"
            }`}
            title="Upload image"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
              <rect x="2" y="2" width="12" height="12" rx="2" />
              <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
              <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {isRunning ? (
            <button
              onClick={handleInterrupt}
              className="flex items-center justify-center w-10 h-10 rounded-[10px] bg-cc-error/10 hover:bg-cc-error/20 text-cc-error transition-colors cursor-pointer shrink-0"
              title="Stop generation"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                <rect x="3" y="3" width="10" height="10" rx="1" />
              </svg>
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!canSend}
              className={`flex items-center justify-center w-10 h-10 rounded-[10px] transition-colors shrink-0 ${
                canSend
                  ? "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                  : "bg-cc-hover text-cc-muted cursor-not-allowed"
              }`}
              title="Send message"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                <path d="M3 3l10 5-10 5V9l6-1-6-1V3z" />
              </svg>
            </button>
          )}
        </div>

        <div className="mt-1.5 px-1 flex items-center justify-between">
          <span className="text-[10px] text-cc-muted">
            Enter to send, Shift+Tab to toggle mode
          </span>
          {session && session.context_used_percent > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="w-12 h-1 rounded-full bg-cc-hover overflow-hidden">
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
              <span className="text-[10px] text-cc-muted tabular-nums">{session.context_used_percent}%</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
