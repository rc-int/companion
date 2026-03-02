import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { getSettings, type UpdateChannel } from "./settings-manager.js";

// ── Read current version from wilco package.json ─────────────────────────────

function readVersion(packageJsonPath: string): string {
  try {
    return JSON.parse(readFileSync(packageJsonPath, "utf-8")).version;
  } catch {
    return "0.0.0";
  }
}

const wilcoPackageJson = resolve(homedir(), "wilco", "package.json");

// ── GitHub repos ─────────────────────────────────────────────────────────────

const WILCO_REPO = "rc-international/wilco";
const UPSTREAM_COMPANION_REPO = "The-Vibe-Company/companion";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const INITIAL_DELAY_MS = 10_000; // 10 seconds after boot

// ── State ────────────────────────────────────────────────────────────────────

interface UpdateState {
  currentVersion: string;
  latestVersion: string | null;
  upstreamCompanionVersion: string | null;
  lastChecked: number;
  checking: boolean;
  isServiceMode: boolean;
  updateInProgress: boolean;
  channel: UpdateChannel;
}

const state: UpdateState = {
  currentVersion: readVersion(wilcoPackageJson),
  latestVersion: null,
  upstreamCompanionVersion: null,
  lastChecked: 0,
  checking: false,
  isServiceMode: false,
  updateInProgress: false,
  channel: "stable",
};

// ── Public API ───────────────────────────────────────────────────────────────

export function getUpdateState(): Readonly<UpdateState> {
  return { ...state };
}

export function getCurrentVersion(): string {
  return state.currentVersion;
}

export function setServiceMode(isService: boolean): void {
  state.isServiceMode = isService;
}

export function setUpdateInProgress(inProgress: boolean): void {
  state.updateInProgress = inProgress;
}

export function isUpdateAvailable(): boolean {
  return state.latestVersion !== null && isNewerVersion(state.latestVersion, state.currentVersion);
}

/**
 * Parse a semver string into its components.
 * Handles versions like "1.2.3", "1.2.3-preview.20260228120000.abc1234"
 */
function parseSemver(v: string): { major: number; minor: number; patch: number; prerelease: string[] } {
  const [corePart, ...prereleaseParts] = v.replace(/^v/, "").split("-");
  const prerelease = prereleaseParts.length > 0 ? prereleaseParts.join("-").split(".") : [];
  const parts = corePart.split(".").map(Number);
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
    prerelease,
  };
}

/**
 * Compare two semver prerelease identifier arrays.
 * Returns -1 if a < b, 0 if a == b, 1 if a > b.
 * A version with no prerelease identifiers has higher precedence than one with.
 */
function comparePrereleaseArrays(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;

    const aNum = Number(a[i]);
    const bNum = Number(b[i]);
    const aIsNum = !isNaN(aNum);
    const bIsNum = !isNaN(bNum);

    if (aIsNum && bIsNum) {
      if (aNum > bNum) return 1;
      if (aNum < bNum) return -1;
    } else if (aIsNum) {
      return -1;
    } else if (bIsNum) {
      return 1;
    } else {
      if (a[i] > b[i]) return 1;
      if (a[i] < b[i]) return -1;
    }
  }
  return 0;
}

/**
 * Prerelease-aware semver comparison: returns true if a > b.
 * Handles both stable versions (1.2.3) and prerelease versions
 * (1.2.3-preview.20260228120000.abc1234).
 */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);

  // Compare major.minor.patch
  if (pa.major !== pb.major) return pa.major > pb.major;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch;

  // Core versions are equal — compare prerelease
  return comparePrereleaseArrays(pa.prerelease, pb.prerelease) > 0;
}

// ── GitHub release fetching ──────────────────────────────────────────────────

async function fetchLatestRelease(repo: string): Promise<string | null> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { tag_name: string };
      return data.tag_name.replace(/^v/, "");
    }
  } catch (err) {
    console.warn(
      `[update-checker] Failed to check ${repo}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  return null;
}

export async function checkForUpdate(): Promise<void> {
  if (state.checking) return;
  state.checking = true;
  try {
    const [wilcoLatest, upstreamLatest] = await Promise.allSettled([
      fetchLatestRelease(WILCO_REPO),
      fetchLatestRelease(UPSTREAM_COMPANION_REPO),
    ]);

    if (wilcoLatest.status === "fulfilled" && wilcoLatest.value) {
      state.latestVersion = wilcoLatest.value;
    }
    if (upstreamLatest.status === "fulfilled" && upstreamLatest.value) {
      state.upstreamCompanionVersion = upstreamLatest.value;
    }

    state.lastChecked = Date.now();

    // Informational logging — actual updates handled by scripts/update.sh
    if (isUpdateAvailable()) {
      console.log(
        `[update-checker] Wilco ${state.latestVersion} available (current: ${state.currentVersion}). ` +
        `Run 'wilco update' or wait for background auto-update.`,
      );
    }
    if (
      state.upstreamCompanionVersion &&
      isNewerVersion(state.upstreamCompanionVersion, readVersion(resolve(homedir(), "wilco", "companion", "web", "package.json")))
    ) {
      console.log(
        `[update-checker] Upstream companion ${state.upstreamCompanionVersion} available. Merge manually when ready.`,
      );
    }
  } finally {
    state.checking = false;
  }
}

// ── Periodic checking ────────────────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startPeriodicCheck(): void {
  setTimeout(() => {
    checkForUpdate();
  }, INITIAL_DELAY_MS);

  intervalId = setInterval(() => {
    checkForUpdate();
  }, CHECK_INTERVAL_MS);
}

export function stopPeriodicCheck(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
