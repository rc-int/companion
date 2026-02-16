// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { UpdateInfo } from "../api.js";

const mockDismissUpdate = vi.fn();
const mockTriggerUpdate = vi.fn();

let storeState: Record<string, unknown> = {};

vi.mock("../store.js", () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(storeState),
}));

vi.mock("../api.js", () => ({
  api: {
    triggerUpdate: () => mockTriggerUpdate(),
  },
}));

import { UpdateBanner } from "./UpdateBanner.js";

function makeUpdateInfo(overrides: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    wilco: { current: "0.1.0", latest: "0.2.0", updateAvailable: true },
    companion: { current: "0.29.0", latest: "0.31.0", updateAvailable: true },
    updateInProgress: false,
    lastChecked: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  storeState = {
    updateInfo: null,
    updateDismissedVersion: null,
    dismissUpdate: mockDismissUpdate,
  };
});

// ─── Visibility ────────────────────────────────────────────────────────────

describe("UpdateBanner visibility", () => {
  it("renders nothing when updateInfo is null", () => {
    storeState.updateInfo = null;
    const { container } = render(<UpdateBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when neither repo has updates", () => {
    storeState.updateInfo = makeUpdateInfo({
      wilco: { current: "0.1.0", latest: "0.1.0", updateAvailable: false },
      companion: { current: "0.29.0", latest: "0.29.0", updateAvailable: false },
    });
    const { container } = render(<UpdateBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("renders when wilco has update", () => {
    storeState.updateInfo = makeUpdateInfo({
      companion: { current: "0.29.0", latest: "0.29.0", updateAvailable: false },
    });
    render(<UpdateBanner />);
    expect(screen.getByText(/wilco/i)).toBeTruthy();
  });

  it("renders when companion has update", () => {
    storeState.updateInfo = makeUpdateInfo({
      wilco: { current: "0.1.0", latest: "0.1.0", updateAvailable: false },
    });
    render(<UpdateBanner />);
    expect(screen.getByText(/companion/i)).toBeTruthy();
  });

  it("renders nothing when dismissed", () => {
    storeState.updateInfo = makeUpdateInfo();
    storeState.updateDismissedVersion = "0.2.0+0.31.0";
    const { container } = render(<UpdateBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("reappears when a newer version supersedes dismissed", () => {
    storeState.updateInfo = makeUpdateInfo({
      wilco: { current: "0.1.0", latest: "0.3.0", updateAvailable: true },
    });
    storeState.updateDismissedVersion = "0.2.0+0.31.0";
    render(<UpdateBanner />);
    expect(screen.getByText("Update & Restart")).toBeTruthy();
  });
});

// ─── Button ─────────────────────────────────────────────────────────────────

describe("UpdateBanner button", () => {
  it("always shows Update & Restart button (no service-mode gate)", () => {
    storeState.updateInfo = makeUpdateInfo();
    render(<UpdateBanner />);
    expect(screen.getByText("Update & Restart")).toBeTruthy();
  });

  it("shows Updating... when update is in progress", () => {
    storeState.updateInfo = makeUpdateInfo({ updateInProgress: true });
    render(<UpdateBanner />);
    expect(screen.getByText("Updating...")).toBeTruthy();
  });

  it("does not show the-companion install text", () => {
    storeState.updateInfo = makeUpdateInfo();
    render(<UpdateBanner />);
    expect(screen.queryByText("the-companion install")).toBeNull();
  });
});

// ─── Interactions ──────────────────────────────────────────────────────────

describe("UpdateBanner interactions", () => {
  it("calls triggerUpdate when Update & Restart is clicked", () => {
    mockTriggerUpdate.mockResolvedValue({ ok: true });
    storeState.updateInfo = makeUpdateInfo();
    render(<UpdateBanner />);

    fireEvent.click(screen.getByText("Update & Restart"));
    expect(mockTriggerUpdate).toHaveBeenCalledOnce();
  });

  it("calls dismissUpdate with composite version key", () => {
    storeState.updateInfo = makeUpdateInfo();
    render(<UpdateBanner />);

    const dismissBtn = screen.getByTitle("Dismiss");
    fireEvent.click(dismissBtn);
    expect(mockDismissUpdate).toHaveBeenCalledWith("0.2.0+0.31.0");
  });
});
