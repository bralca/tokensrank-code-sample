"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Check,
  FolderSearch,
  Github,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { LocalSetupStatus, ProfileResponse } from "@tokensrank/shared";
import { apiFetch } from "../lib/api";
import { LocalShell } from "./LocalShell";

const tools = [
  { id: "claude", name: "Claude" },
  { id: "codex", name: "Codex" },
  { id: "opencode", name: "OpenCode" },
] as const;
const compact = (value: number) =>
  new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);

export function LocalOnboardingClient() {
  const router = useRouter();
  const [status, setStatus] = useState<LocalSetupStatus | null>(null);
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const next = await apiFetch<LocalSetupStatus>("/local/setup/status", {
      cache: "no-store",
    });
    setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await apiFetch<LocalSetupStatus>("/local/setup/status", {
          cache: "no-store",
        });
        if (!cancelled) {
          setStatus(next);
          setConnectionError(null);
        }
      } catch {
        if (!cancelled)
          setConnectionError(
            "We couldn’t reach the local app. Keep it running and try again.",
          );
      }
      if (!cancelled) timer = setTimeout(poll, 4000);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!status?.profile_ready) return;
    let cancelled = false;
    void apiFetch<ProfileResponse>("/api/profile/local?window=all", {
      cache: "no-store",
    })
      .then((value) => {
        if (!cancelled) setProfile(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [status?.profile_ready, status?.ingestion.finished_at]);

  const operation = status?.operations.find(
    (item) =>
      ["usage_ingest", "schedule_run"].includes(item.type) &&
      ["queued", "running"].includes(item.status),
  );
  const reading = Boolean(operation || status?.ingestion.status === "running");
  const ready = Boolean(status?.profile_ready);
  const filesFound =
    status?.usage_sources.reduce(
      (total, source) => total + (source.readable ? source.file_count : 0),
      0,
    ) ?? 0;

  async function readUsage() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/local/discovery", { cache: "no-store" });
      await apiFetch("/local/ingest/run", { method: "POST" });
      await refresh();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Couldn’t read your usage. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function openDashboard() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/local/onboarding/complete", {
        method: "POST",
        body: JSON.stringify({
          completed_version: "local-v3",
          last_completed_step: "ready",
        }),
      });
      router.push("/local/profile");
    } catch {
      setError("Couldn’t finish setup. Please try again.");
      setBusy(false);
    }
  }

  return (
    <LocalShell showActions={false}>
      <div className="dash-content dash-setup-content">
        <header className="dash-page-title">
          <div>
            <p className="dash-eyebrow">WELCOME TO YOUR LOCAL DASHBOARD</p>
            <h1>Find your usage</h1>
            <p className="dash-subtitle">
              Find your activity, understand your model mix, and keep the
              details on your computer.
            </p>
          </div>
        </header>
        <section className="dash-card dash-setup-card">
          <div className="dash-connect-heading">
            <span className="dash-connect-icon">
              {ready ? <Check size={24} /> : <FolderSearch size={24} />}
            </span>
            <div>
              <h2>{ready ? "Your usage is ready" : "Let’s find your usage"}</h2>
              <p className="dash-subtitle">
                {status
                  ? `${filesFound.toLocaleString()} readable files found in your local tool folders.`
                  : "Checking this computer…"}
              </p>
            </div>
          </div>
          <div className="dash-source-grid">
            {tools.map((tool) => {
              const sources =
                status?.usage_sources.filter(
                  (source) => source.source === tool.id,
                ) ?? [];
              const files = sources.reduce(
                (total, source) =>
                  total + (source.readable ? source.file_count : 0),
                0,
              );
              return (
                <div key={tool.id}>
                  <span className={`dash-source-icon ${files ? "found" : ""}`}>
                    {tool.name.slice(0, 1)}
                  </span>
                  <div>
                    <strong>{tool.name}</strong>
                    <small>
                      {!status
                        ? "Checking…"
                        : files
                          ? `${files.toLocaleString()} file${files === 1 ? "" : "s"} found`
                          : "No usage found yet"}
                    </small>
                  </div>
                  {files > 0 && <Check size={14} />}
                </div>
              );
            })}
          </div>
          {profile && (
            <div className="dash-setup-highlights">
              <div>
                <strong>{compact(profile.at_glance.tokens_total)}</strong>
                <span>tokens</span>
              </div>
              <div>
                <strong>{compact(profile.at_glance.sessions_count)}</strong>
                <span>sessions</span>
              </div>
              <div>
                <strong>{profile.models.models.length}</strong>
                <span>models</span>
              </div>
            </div>
          )}
          {reading && (
            <p className="dash-setup-progress" role="status">
              <RefreshCw size={14} className="dash-spin" />
              {ready
                ? "Your numbers are available. Finishing the background update…"
                : (operation?.message ??
                  "Reading your usage. Your first import may take a little longer.")}
            </p>
          )}
          {!reading && status?.ingestion.status === "failed" && (
            <p role="alert" className="dash-form-error">
              The last import didn’t finish. You can try reading your usage
              again.
            </p>
          )}
          <div className="dash-setup-actions">
            {ready ? (
              <button
                className="dash-button primary"
                disabled={busy}
                onClick={openDashboard}
              >
                Open my dashboard <ArrowRight size={15} />
              </button>
            ) : (
              <button
                className="dash-button primary"
                disabled={busy || reading || !status}
                onClick={readUsage}
              >
                {busy || reading ? "Reading usage…" : "Read my usage"}
                <ArrowRight size={15} />
              </button>
            )}
            {ready && (
              <button
                className="dash-button"
                disabled={busy || reading}
                onClick={readUsage}
              >
                <RefreshCw size={14} /> Read usage again
              </button>
            )}
          </div>
          <p className="dash-connect-privacy">
            <ShieldCheck size={14} /> No account needed. Prompts, conversations,
            and source files stay here.
          </p>
        </section>
        <div className="dash-setup-optional">
          <Github size={20} />
          <div>
            <h3>Want to see your code contributions too?</h3>
            <p>
              GitHub and repository settings are optional. You can connect them
              whenever you’re ready.
            </p>
          </div>
          <Link href="/local/settings" className="dash-text-button">
            Open settings <ArrowRight size={14} />
          </Link>
        </div>
        {(error || connectionError) && (
          <p className="dash-form-error" role="alert">
            {error || connectionError}
          </p>
        )}
      </div>
    </LocalShell>
  );
}
