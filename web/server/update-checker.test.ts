import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock fs.readFileSync to control versions
const mockReadFileSync = vi.fn();
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: (...args: unknown[]) => mockReadFileSync(...args) };
});

// Mock settings-manager to control updateChannel
const mockGetSettings = vi.fn(() => ({
  updateChannel: "stable" as "stable" | "prerelease",
}));
vi.mock("./settings-manager.js", () => ({
  getSettings: () => mockGetSettings(),
}));

let checker: typeof import("./update-checker.js");

beforeEach(async () => {
  vi.resetModules();
  mockFetch.mockReset();
  mockReadFileSync.mockReset();
  mockReadFileSync.mockImplementation(() => {
    return JSON.stringify({ version: "0.1.0" });
  });
  mockGetSettings.mockReturnValue({ updateChannel: "stable" });
  checker = await import("./update-checker.js");
});

afterEach(() => {
  checker.stopPeriodicCheck();
});

// ── isNewerVersion (stable) ──────────────────────────────────────────────────
describe("isNewerVersion", () => {
  it("returns true when major version is higher", () => {
    expect(checker.isNewerVersion("2.0.0", "1.0.0")).toBe(true);
  });
  it("returns true when minor version is higher", () => {
    expect(checker.isNewerVersion("1.1.0", "1.0.0")).toBe(true);
  });
  it("returns true when patch version is higher", () => {
    expect(checker.isNewerVersion("1.0.1", "1.0.0")).toBe(true);
  });
  it("returns false when versions are equal", () => {
    expect(checker.isNewerVersion("1.0.0", "1.0.0")).toBe(false);
  });
  it("returns false when version is lower", () => {
    expect(checker.isNewerVersion("1.0.0", "1.0.1")).toBe(false);
  });
  it("strips leading v from tag names", () => {
    expect(checker.isNewerVersion("v2.0.0", "1.0.0")).toBe(true);
    expect(checker.isNewerVersion("v1.0.0", "v1.0.0")).toBe(false);
  });
});

// ── isNewerVersion (prerelease) ──────────────────────────────────────────────
describe("isNewerVersion (prerelease)", () => {
  it("stable is newer than prerelease of same core version", () => {
    expect(checker.isNewerVersion("1.0.0", "1.0.0-preview.1")).toBe(true);
  });

  it("prerelease is older than stable of same core version", () => {
    expect(checker.isNewerVersion("1.0.0-preview.1", "1.0.0")).toBe(false);
  });

  it("higher core prerelease is newer than lower core stable", () => {
    expect(checker.isNewerVersion("1.1.0-preview.1", "1.0.0")).toBe(true);
  });

  it("later prerelease of same core is newer", () => {
    expect(checker.isNewerVersion("1.0.0-preview.2", "1.0.0-preview.1")).toBe(true);
  });

  it("earlier prerelease of same core is older", () => {
    expect(checker.isNewerVersion("1.0.0-preview.1", "1.0.0-preview.2")).toBe(false);
  });

  it("compares timestamp-based prerelease identifiers correctly", () => {
    expect(checker.isNewerVersion(
      "0.66.0-preview.20260228140000.abc1234",
      "0.66.0-preview.20260228120000.def5678",
    )).toBe(true);
  });

  it("returns false for equal prerelease versions", () => {
    expect(checker.isNewerVersion("1.0.0-preview.1", "1.0.0-preview.1")).toBe(false);
  });

  it("compares alphanumeric prerelease identifiers lexically", () => {
    expect(checker.isNewerVersion("1.0.0-beta.1", "1.0.0-alpha.1")).toBe(true);
    expect(checker.isNewerVersion("1.0.0-alpha.1", "1.0.0-beta.1")).toBe(false);
  });
});

// ── Prerelease regressions (THE-216) ────────────────────────────────────────
describe("isNewerVersion — prerelease channel regressions (THE-216)", () => {
  it("same-core prerelease is NOT newer than stable (old broken format)", () => {
    expect(checker.isNewerVersion("0.68.0-preview.20260301120000.abc1234", "0.68.0")).toBe(false);
  });

  it("patch-bumped prerelease IS newer than stable (fixed format)", () => {
    expect(checker.isNewerVersion("0.68.1-preview.20260301120000.abc1234", "0.68.0")).toBe(true);
  });

  it("later timestamp preview is newer than earlier timestamp preview", () => {
    expect(checker.isNewerVersion(
      "0.68.1-preview.20260301140000.abc1234",
      "0.68.1-preview.20260301120000.def5678",
    )).toBe(true);
  });

  it("stable release at preview core supersedes the preview", () => {
    expect(checker.isNewerVersion("0.68.1-preview.20260301120000.abc1234", "0.68.1")).toBe(false);
  });

  it("higher stable is newer than older-core preview", () => {
    expect(checker.isNewerVersion("0.69.0", "0.68.1-preview.20260301120000.abc1234")).toBe(true);
  });
});

// ── getCurrentVersion ───────────────────────────────────────────────────────
describe("getCurrentVersion", () => {
  it("returns a semver string", () => {
    const version = checker.getCurrentVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ── getUpdateState ──────────────────────────────────────────────────────────
describe("getUpdateState", () => {
  it("returns initial state with currentVersion from package.json", () => {
    const state = checker.getUpdateState();
    expect(state.currentVersion).toBe("0.1.0");
    expect(state.latestVersion).toBeNull();
    expect(state.upstreamCompanionVersion).toBeNull();
    expect(state.checking).toBe(false);
    expect(state.updateInProgress).toBe(false);
    expect(state.channel).toBe("stable");
  });
});

// ── checkForUpdate ──────────────────────────────────────────────────────────
describe("checkForUpdate", () => {
  it("fetches wilco and upstream companion from GitHub releases API", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tag_name: "v0.2.0" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tag_name: "v0.31.0" }),
      });

    await checker.checkForUpdate();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("rc-international/wilco"),
      expect.any(Object),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("The-Vibe-Company/companion"),
      expect.any(Object),
    );

    const state = checker.getUpdateState();
    expect(state.latestVersion).toBe("0.2.0");
    expect(state.upstreamCompanionVersion).toBe("0.31.0");
    expect(state.lastChecked).toBeGreaterThan(0);
    expect(state.channel).toBe("stable");
  });

  it("handles fetch errors gracefully", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    await checker.checkForUpdate();

    const state = checker.getUpdateState();
    expect(state.latestVersion).toBeNull();
    expect(state.upstreamCompanionVersion).toBeNull();
  });

  it("handles partial failure (wilco ok, upstream fails)", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tag_name: "v0.2.0" }),
      })
      .mockRejectedValueOnce(new Error("Not found"));

    await checker.checkForUpdate();

    const state = checker.getUpdateState();
    expect(state.latestVersion).toBe("0.2.0");
    expect(state.upstreamCompanionVersion).toBeNull();
  });

  it("includes GITHUB_TOKEN as Bearer header when set", async () => {
    process.env.GITHUB_TOKEN = "ghp_test123";
    vi.resetModules();
    checker = await import("./update-checker.js");

    mockFetch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false });

    await checker.checkForUpdate();

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ghp_test123",
        }),
      }),
    );

    delete process.env.GITHUB_TOKEN;
  });
});

// ── isUpdateAvailable ───────────────────────────────────────────────────────
describe("isUpdateAvailable", () => {
  it("returns false when no latest version is set", () => {
    expect(checker.isUpdateAvailable()).toBe(false);
  });

  it("returns true when wilco has newer version", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tag_name: "v99.0.0" }),
      })
      .mockResolvedValueOnce({ ok: false });

    await checker.checkForUpdate();
    expect(checker.isUpdateAvailable()).toBe(true);
  });

  it("returns false when version matches current", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tag_name: "v0.1.0" }),
      })
      .mockResolvedValueOnce({ ok: false });

    await checker.checkForUpdate();
    expect(checker.isUpdateAvailable()).toBe(false);
  });
});
