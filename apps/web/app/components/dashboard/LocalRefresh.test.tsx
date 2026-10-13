import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalRefresh } from "./LocalRefresh";
const mock = vi.hoisted(() => ({
  fetch: vi.fn(),
  router: { refresh: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ apiFetch: mock.fetch }));
vi.mock("next/navigation", () => ({ useRouter: () => mock.router }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  mock.fetch.mockReset();
  mock.router.refresh.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("updates the visible profile when usage is ready, without waiting for code attribution", async () => {
  let updated: string | null = null;
  mock.fetch.mockImplementation(async (path: string) =>
    path.endsWith("/operations")
      ? { data: [] }
      : {
          config: { enabled: true, interval_minutes: 15 },
          running: true,
          usage_updated_at: updated,
        },
  );
  await act(async () => root.render(<LocalRefresh />));
  expect(mock.router.refresh).not.toHaveBeenCalled();
  updated = "2026-09-14T00:00:00Z";
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(mock.router.refresh).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(mock.router.refresh).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Updating your usage");
});
it("shows an offline state rather than claiming updates are running", async () => {
  mock.fetch.mockRejectedValue(new Error("offline"));
  await act(async () => root.render(<LocalRefresh />));
  expect(container.textContent).toContain("Local app is offline");
});
