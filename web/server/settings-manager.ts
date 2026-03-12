import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4.6";

export type UpdateChannel = "stable" | "prerelease";

export interface CompanionSettings {
  anthropicApiKey: string;
  anthropicModel: string;
  linearApiKey: string;
  linearAutoTransition: boolean;
  linearAutoTransitionStateId: string;
  linearAutoTransitionStateName: string;
  linearArchiveTransition: boolean;
  linearArchiveTransitionStateId: string;
  linearArchiveTransitionStateName: string;
  editorTabEnabled: boolean;
  aiValidationEnabled: boolean;
  aiValidationAutoApprove: boolean;
  aiValidationAutoDeny: boolean;
  updateChannel: UpdateChannel;
  sessionLifecycle: "manual" | "auto";
  sessionIdleTimeoutHours: number;
  sessionMaxAgeHours: number;
  sessionAutoRespawn: boolean;
  sessionHandoffEnabled: boolean;
  updatedAt: number;
}

const DEFAULT_PATH = join(homedir(), ".companion", "settings.json");

let loaded = false;
let filePath = DEFAULT_PATH;
let settings: CompanionSettings = {
  anthropicApiKey: "",
  anthropicModel: DEFAULT_ANTHROPIC_MODEL,
  linearApiKey: "",
  linearAutoTransition: false,
  linearAutoTransitionStateId: "",
  linearAutoTransitionStateName: "",
  linearArchiveTransition: false,
  linearArchiveTransitionStateId: "",
  linearArchiveTransitionStateName: "",
  editorTabEnabled: false,
  aiValidationEnabled: false,
  aiValidationAutoApprove: true,
  aiValidationAutoDeny: true,
  updateChannel: "stable",
  sessionLifecycle: "auto",
  sessionIdleTimeoutHours: 48,
  sessionMaxAgeHours: 24,
  sessionAutoRespawn: true,
  sessionHandoffEnabled: true,
  updatedAt: 0,
};

function normalize(raw: Partial<CompanionSettings> | null | undefined): CompanionSettings {
  return {
    anthropicApiKey: typeof raw?.anthropicApiKey === "string" ? raw.anthropicApiKey : "",
    anthropicModel:
      typeof raw?.anthropicModel === "string" && raw.anthropicModel.trim()
        ? raw.anthropicModel
        : DEFAULT_ANTHROPIC_MODEL,
    linearApiKey: typeof raw?.linearApiKey === "string" ? raw.linearApiKey : "",
    linearAutoTransition: typeof raw?.linearAutoTransition === "boolean" ? raw.linearAutoTransition : false,
    linearAutoTransitionStateId: typeof raw?.linearAutoTransitionStateId === "string" ? raw.linearAutoTransitionStateId : "",
    linearAutoTransitionStateName: typeof raw?.linearAutoTransitionStateName === "string" ? raw.linearAutoTransitionStateName : "",
    linearArchiveTransition: typeof raw?.linearArchiveTransition === "boolean" ? raw.linearArchiveTransition : false,
    linearArchiveTransitionStateId: typeof raw?.linearArchiveTransitionStateId === "string" ? raw.linearArchiveTransitionStateId : "",
    linearArchiveTransitionStateName: typeof raw?.linearArchiveTransitionStateName === "string" ? raw.linearArchiveTransitionStateName : "",
    editorTabEnabled: typeof raw?.editorTabEnabled === "boolean" ? raw.editorTabEnabled : false,
    aiValidationEnabled: typeof raw?.aiValidationEnabled === "boolean" ? raw.aiValidationEnabled : false,
    aiValidationAutoApprove: typeof raw?.aiValidationAutoApprove === "boolean" ? raw.aiValidationAutoApprove : true,
    aiValidationAutoDeny: typeof raw?.aiValidationAutoDeny === "boolean" ? raw.aiValidationAutoDeny : true,
    updateChannel: raw?.updateChannel === "prerelease" ? "prerelease" : "stable",
    sessionLifecycle: raw?.sessionLifecycle === "manual" ? "manual" : "auto",
    sessionIdleTimeoutHours: typeof raw?.sessionIdleTimeoutHours === "number" && raw.sessionIdleTimeoutHours > 0
      ? raw.sessionIdleTimeoutHours
      : 48,
    sessionMaxAgeHours: typeof raw?.sessionMaxAgeHours === "number" && raw.sessionMaxAgeHours > 0
      ? raw.sessionMaxAgeHours
      : 24,
    sessionAutoRespawn: typeof raw?.sessionAutoRespawn === "boolean" ? raw.sessionAutoRespawn : true,
    sessionHandoffEnabled: typeof raw?.sessionHandoffEnabled === "boolean" ? raw.sessionHandoffEnabled : true,
    updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : 0,
  };
}

function ensureLoaded(): void {
  if (loaded) return;
  try {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf-8");
      settings = normalize(JSON.parse(raw) as Partial<CompanionSettings>);
    }
  } catch {
    settings = normalize(null);
  }
  loaded = true;
}

function persist(): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(settings, null, 2), "utf-8");
}

export function getSettings(): CompanionSettings {
  ensureLoaded();
  return { ...settings };
}

export function updateSettings(
  patch: Partial<Pick<CompanionSettings, "anthropicApiKey" | "anthropicModel" | "linearApiKey" | "linearAutoTransition" | "linearAutoTransitionStateId" | "linearAutoTransitionStateName" | "linearArchiveTransition" | "linearArchiveTransitionStateId" | "linearArchiveTransitionStateName" | "editorTabEnabled" | "aiValidationEnabled" | "aiValidationAutoApprove" | "aiValidationAutoDeny" | "updateChannel" | "sessionLifecycle" | "sessionIdleTimeoutHours" | "sessionMaxAgeHours" | "sessionAutoRespawn" | "sessionHandoffEnabled">>,
): CompanionSettings {
  ensureLoaded();
  settings = normalize({
    anthropicApiKey: patch.anthropicApiKey ?? settings.anthropicApiKey,
    anthropicModel: patch.anthropicModel ?? settings.anthropicModel,
    linearApiKey: patch.linearApiKey ?? settings.linearApiKey,
    linearAutoTransition: patch.linearAutoTransition ?? settings.linearAutoTransition,
    linearAutoTransitionStateId: patch.linearAutoTransitionStateId ?? settings.linearAutoTransitionStateId,
    linearAutoTransitionStateName: patch.linearAutoTransitionStateName ?? settings.linearAutoTransitionStateName,
    linearArchiveTransition: patch.linearArchiveTransition ?? settings.linearArchiveTransition,
    linearArchiveTransitionStateId: patch.linearArchiveTransitionStateId ?? settings.linearArchiveTransitionStateId,
    linearArchiveTransitionStateName: patch.linearArchiveTransitionStateName ?? settings.linearArchiveTransitionStateName,
    editorTabEnabled: patch.editorTabEnabled ?? settings.editorTabEnabled,
    aiValidationEnabled: patch.aiValidationEnabled ?? settings.aiValidationEnabled,
    aiValidationAutoApprove: patch.aiValidationAutoApprove ?? settings.aiValidationAutoApprove,
    aiValidationAutoDeny: patch.aiValidationAutoDeny ?? settings.aiValidationAutoDeny,
    updateChannel: patch.updateChannel ?? settings.updateChannel,
    sessionLifecycle: patch.sessionLifecycle ?? settings.sessionLifecycle,
    sessionIdleTimeoutHours: patch.sessionIdleTimeoutHours ?? settings.sessionIdleTimeoutHours,
    sessionMaxAgeHours: patch.sessionMaxAgeHours ?? settings.sessionMaxAgeHours,
    sessionAutoRespawn: patch.sessionAutoRespawn ?? settings.sessionAutoRespawn,
    sessionHandoffEnabled: patch.sessionHandoffEnabled ?? settings.sessionHandoffEnabled,
    updatedAt: Date.now(),
  });
  persist();
  return { ...settings };
}

export function _resetForTest(customPath?: string): void {
  loaded = false;
  filePath = customPath || DEFAULT_PATH;
  settings = normalize(null);
}
