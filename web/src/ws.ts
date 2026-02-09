import { useStore } from "./store.js";
import type { BrowserIncomingMessage, BrowserOutgoingMessage, ContentBlock, ChatMessage, TaskItem } from "./types.js";
import { generateUniqueSessionName } from "./utils/names.js";

const sockets = new Map<string, WebSocket>();
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const taskCounters = new Map<string, number>();

let idCounter = 0;
function nextId(): string {
  return `msg-${Date.now()}-${++idCounter}`;
}

function getWsUrl(sessionId: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws/browser/${sessionId}`;
}

function extractTextFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "thinking") return b.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function handleMessage(sessionId: string, event: MessageEvent) {
  const store = useStore.getState();
  let data: BrowserIncomingMessage;
  try {
    data = JSON.parse(event.data);
  } catch {
    return;
  }

  switch (data.type) {
    case "session_init": {
      store.addSession(data.session);
      store.setCliConnected(sessionId, true);
      store.setSessionStatus(sessionId, "idle");
      if (!store.sessionNames.has(sessionId)) {
        const existingNames = new Set(store.sessionNames.values());
        const name = generateUniqueSessionName(existingNames);
        store.setSessionName(sessionId, name);
      }
      break;
    }

    case "session_update": {
      store.updateSession(sessionId, data.session);
      break;
    }

    case "assistant": {
      const msg = data.message;
      const textContent = extractTextFromBlocks(msg.content);
      const chatMsg: ChatMessage = {
        id: msg.id,
        role: "assistant",
        content: textContent,
        contentBlocks: msg.content,
        timestamp: Date.now(),
        parentToolUseId: data.parent_tool_use_id,
        model: msg.model,
        stopReason: msg.stop_reason,
      };
      store.appendMessage(sessionId, chatMsg);
      store.setStreaming(sessionId, null);
      store.setSessionStatus(sessionId, "running");

      // Extract TaskCreate and TaskUpdate from content blocks
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.name === "TaskCreate") {
          const count = (taskCounters.get(sessionId) || 0) + 1;
          taskCounters.set(sessionId, count);
          const input = block.input as { subject?: string; description?: string; activeForm?: string };
          store.addTask(sessionId, {
            id: String(count),
            subject: input.subject || "Task",
            description: input.description || "",
            activeForm: input.activeForm,
            status: "pending",
          });
        }

        if (block.type === "tool_use" && block.name === "TaskUpdate") {
          const input = block.input as { taskId?: string; status?: string; owner?: string; activeForm?: string; addBlockedBy?: string[] };
          if (input.taskId) {
            const updates: Partial<TaskItem> = {};
            if (input.status) updates.status = input.status as TaskItem["status"];
            if (input.owner) updates.owner = input.owner;
            if (input.activeForm !== undefined) updates.activeForm = input.activeForm;
            if (input.addBlockedBy) updates.blockedBy = input.addBlockedBy;
            store.updateTask(sessionId, input.taskId, updates);
          }
        }
      }

      break;
    }

    case "stream_event": {
      const evt = data.event as Record<string, unknown>;
      if (evt && typeof evt === "object") {
        // Handle content_block_delta events for streaming
        if (evt.type === "content_block_delta") {
          const delta = evt.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            const current = store.streaming.get(sessionId) || "";
            store.setStreaming(sessionId, current + delta.text);
          }
        }
      }
      break;
    }

    case "result": {
      const r = data.data;
      store.updateSession(sessionId, {
        total_cost_usd: r.total_cost_usd,
        num_turns: r.num_turns,
      });
      store.setStreaming(sessionId, null);
      store.setSessionStatus(sessionId, "idle");
      if (r.is_error && r.errors?.length) {
        store.appendMessage(sessionId, {
          id: nextId(),
          role: "system",
          content: `Error: ${r.errors.join(", ")}`,
          timestamp: Date.now(),
        });
      }
      break;
    }

    case "permission_request": {
      store.addPermission(data.request);
      break;
    }

    case "permission_cancelled": {
      store.removePermission(data.request_id);
      break;
    }

    case "tool_progress": {
      // Could be used for progress indicators; ignored for now
      break;
    }

    case "tool_use_summary": {
      // Optional: add as system message
      break;
    }

    case "status_change": {
      if (data.status === "compacting") {
        store.setSessionStatus(sessionId, "compacting");
      } else {
        store.setSessionStatus(sessionId, data.status);
      }
      break;
    }

    case "auth_status": {
      if (data.error) {
        store.appendMessage(sessionId, {
          id: nextId(),
          role: "system",
          content: `Auth error: ${data.error}`,
          timestamp: Date.now(),
        });
      }
      break;
    }

    case "error": {
      store.appendMessage(sessionId, {
        id: nextId(),
        role: "system",
        content: data.message,
        timestamp: Date.now(),
      });
      break;
    }

    case "cli_disconnected": {
      store.setCliConnected(sessionId, false);
      store.setSessionStatus(sessionId, null);
      break;
    }

    case "cli_connected": {
      store.setCliConnected(sessionId, true);
      break;
    }

    case "message_history": {
      const chatMessages: ChatMessage[] = [];
      for (const histMsg of data.messages) {
        if (histMsg.type === "user_message") {
          chatMessages.push({
            id: nextId(),
            role: "user",
            content: histMsg.content,
            timestamp: histMsg.timestamp,
          });
        } else if (histMsg.type === "assistant") {
          const msg = histMsg.message;
          const textContent = extractTextFromBlocks(msg.content);
          chatMessages.push({
            id: msg.id,
            role: "assistant",
            content: textContent,
            contentBlocks: msg.content,
            timestamp: Date.now(),
            parentToolUseId: histMsg.parent_tool_use_id,
            model: msg.model,
            stopReason: msg.stop_reason,
          });
        } else if (histMsg.type === "result") {
          const r = histMsg.data;
          if (r.is_error && r.errors?.length) {
            chatMessages.push({
              id: nextId(),
              role: "system",
              content: `Error: ${r.errors.join(", ")}`,
              timestamp: Date.now(),
            });
          }
        }
      }
      if (chatMessages.length > 0) {
        store.setMessages(sessionId, chatMessages);
      }
      break;
    }
  }
}

export function connectSession(sessionId: string) {
  if (sockets.has(sessionId)) return;

  const store = useStore.getState();
  store.setConnectionStatus(sessionId, "connecting");

  const ws = new WebSocket(getWsUrl(sessionId));
  sockets.set(sessionId, ws);

  ws.onopen = () => {
    useStore.getState().setConnectionStatus(sessionId, "connected");
    // Clear any reconnect timer
    const timer = reconnectTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      reconnectTimers.delete(sessionId);
    }
  };

  ws.onmessage = (event) => handleMessage(sessionId, event);

  ws.onclose = () => {
    sockets.delete(sessionId);
    useStore.getState().setConnectionStatus(sessionId, "disconnected");
    scheduleReconnect(sessionId);
  };

  ws.onerror = () => {
    ws.close();
  };
}

function scheduleReconnect(sessionId: string) {
  if (reconnectTimers.has(sessionId)) return;
  // Only reconnect if the session is still the current one
  const timer = setTimeout(() => {
    reconnectTimers.delete(sessionId);
    const store = useStore.getState();
    if (store.currentSessionId === sessionId || store.sessions.has(sessionId)) {
      connectSession(sessionId);
    }
  }, 2000);
  reconnectTimers.set(sessionId, timer);
}

export function disconnectSession(sessionId: string) {
  const timer = reconnectTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(sessionId);
  }
  const ws = sockets.get(sessionId);
  if (ws) {
    ws.close();
    sockets.delete(sessionId);
  }
}

export function disconnectAll() {
  for (const [id] of sockets) {
    disconnectSession(id);
  }
}

export function waitForConnection(sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = setInterval(() => {
      const ws = sockets.get(sessionId);
      if (ws?.readyState === WebSocket.OPEN) {
        clearInterval(check);
        clearTimeout(timeout);
        resolve();
      }
    }, 50);
    const timeout = setTimeout(() => {
      clearInterval(check);
      reject(new Error("Connection timeout"));
    }, 10000);
  });
}

export function sendToSession(sessionId: string, msg: BrowserOutgoingMessage) {
  const ws = sockets.get(sessionId);
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
