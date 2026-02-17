import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

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
}

const state: UpdateState = {
  currentVersion: readVersion(wilcoPackageJson),
  latestVersion: null,
  upstreamCompanionVersion: null,
  lastChecked: 0,
  checking: false,
};

// ── Public API ───────────────────────────────────────────────────────────────

export function getUpdateState(): Readonly<UpdateState> {
  return { ...state };
}

export function isUpdateAvailable(): boolean {
  return state.latestVersion !== null && isNewerVersion(state.latestVersion, state.currentVersion);
}

/** Simple semver comparison: returns true if a > b. Strips leading 'v'. */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
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
