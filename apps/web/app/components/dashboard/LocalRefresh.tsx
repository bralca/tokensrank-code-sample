"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import type {
  LocalScheduleStatus,
  LocalOperationRun,
} from "@tokensrank/shared";
import { apiFetch } from "@/lib/api";

export function LocalRefresh() {
  const router = useRouter();
  const [status, setStatus] = useState<LocalScheduleStatus | null>(null);
  const [active, setActive] = useState<LocalOperationRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const lastFinished = useRef<string | null | undefined>(undefined);
  const poll = useCallback(async () => {
    try {
      const [next, operations] = await Promise.all([
        apiFetch<LocalScheduleStatus>("/local/schedule/status"),
        apiFetch<{ data: LocalOperationRun[] }>("/local/operations"),
      ]);
      setStatus(next);
      const imports = operations.data.filter(
        (op) => op.type === "usage_ingest" || op.type === "schedule_run",
      );
      setActive(imports.find((op) => op.status === "running") ?? null);
      const finished =
        [
          next.usage_updated_at,
          imports.find(
            (op) => op.status === "completed" || op.status === "failed",
          )?.finished_at,
        ]
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) ?? null;
      if (
        lastFinished.current !== undefined &&
        finished !== lastFinished.current
      )
        router.refresh();
      lastFinished.current = finished;
      setError(null);
    } catch {
      setError("Local app is offline. Start it again to resume updates.");
    }
  }, [router]);
  useEffect(() => {
    void poll();
    const timer = setInterval(() => {
      if (!document.hidden) void poll();
    }, 5000);
    const onVisible = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [poll]);
  const busy = starting || Boolean(active) || Boolean(status?.running);
  async function refresh() {
    setStarting(true);
    try {
      await apiFetch("/local/schedule/run", {
        method: "POST",
        body: JSON.stringify({}),
      });
      await poll();
    } catch {
      setError("Could not start the refresh. Please try again.");
    } finally {
      setStarting(false);
    }
  }
  const usageReady = Boolean(
    active &&
      status?.usage_updated_at &&
      Date.parse(status.usage_updated_at) >= Date.parse(active.started_at),
  );
  const last = lastFinished.current ?? status?.last_finished_at;
  return (
    <div className="dash-refresh-wrap">
      <div className="dash-refresh">
        <span
          className={`dash-status-dot ${error || status?.last_error ? "warning" : ""}`}
        />
        <span>
          {busy
            ? usageReady
              ? "Usage updated · finishing sync"
              : "Updating your usage…"
            : !status
              ? "Checking refresh status…"
              : status.config.enabled
                ? `Auto-refresh every ${status.config.interval_minutes} min`
                : "Automatic refresh paused"}
        </span>
        <button className="dash-button" onClick={refresh} disabled={busy}>
          <RefreshCw size={14} className={busy ? "dash-spin" : ""} />
          {busy ? "Refreshing" : "Refresh now"}
        </button>
      </div>
      <div className="dash-refresh-note" role="status">
        {error ??
          (busy
            ? usageReady
              ? "Your numbers are current. Code attribution is finishing in the background."
              : "Reading local activity. You can keep browsing."
            : status?.last_error
              ? "Usage may be partial. Review the latest update in Settings."
              : last
                ? `Last checked ${new Date(last).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · updates while the local app is running`
                : "Refreshes when the local app opens. No files are uploaded.")}
      </div>
    </div>
  );
}
