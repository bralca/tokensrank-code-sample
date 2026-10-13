import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProfileResponse } from "@tokensrank/shared";
import { UsageDashboard } from "./UsageDashboard";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/u/example" }));
vi.mock("./LocalRefresh", () => ({ LocalRefresh: () => null }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

// Include a session deliberately: public rendering must never expose local
// session details, even if a caller accidentally supplies the local response.
const profile = {
  window: "all",
  identity: { handle: "example", display_name: "Example" },
  headline: { rank: 1 },
  at_glance: { tokens_total: 0, cost_usd_total: 0, sessions_count: 1 },
  cadence: { days: [] },
  models: { models: [], distinct: 0 },
  tools: { items: [] },
  sessions: { items: [{ source: "codex", session_id: "private-session", model: "private-model", started_at: "2026-09-14T00:00:00Z", tokens_total: 1, cost_usd_total: 0 }] },
} as unknown as ProfileResponse;

async function showActivity(local: boolean) {
  await act(async () => root.render(<UsageDashboard profile={profile} local={local} />));
  const activity = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((tab) => tab.textContent === "Activity")!;
  await act(async () => activity.click());
}

it("keeps session details out of public activity", async () => {
  await showActivity(false);
  expect(container.textContent).toContain("This profile shares daily totals only.");
  expect(container.textContent).not.toContain("Recent sessions");
  expect(container.textContent).not.toContain("Private Model");
  expect(container.textContent).not.toContain("No sessions to show");
});

it("retains session details in the private local dashboard", async () => {
  await showActivity(true);
  expect(container.textContent).toContain("Recent sessions");
  expect(container.textContent).toContain("Private Model");
});
