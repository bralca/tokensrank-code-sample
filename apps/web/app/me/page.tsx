import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import type {
  GetMeResponse,
  ProfileResponse,
} from "../../../../packages/shared/src/schemas";

import { ApiError } from "../lib/api";
import { serverApiFetch } from "../lib/api-server";
import { RevokeAccessKeyButton, SignOutButton } from "./dashboard-actions";

import { LocalConnectionCard } from "../components/dashboard/LocalConnectionCard";

type DashboardProfile = ProfileResponse | null;

async function loadMe(): Promise<GetMeResponse["data"]> {
  try {
    const response = await serverApiFetch<GetMeResponse>("/api/me", {
      requestHeaders: await headers(),
      cache: "no-store",
      next: {
        tags: ["me"],
      },
    });

    return response.data;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/auth/sign-in");
    }

    throw error;
  }
}

async function loadDashboardProfile(
  handle: string | null,
): Promise<DashboardProfile> {
  if (!handle) {
    return null;
  }

  try {
    return await serverApiFetch<ProfileResponse>(
      `/api/profile/${encodeURIComponent(handle)}?window=all`,
      {
        requestHeaders: await headers(),
        cache: "no-store",
      },
    );
  } catch (error) {
    console.warn("[web] Failed to load dashboard profile summary", error);
    return null;
  }
}

function formatCost(value: number): string {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return "Pending";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusLabel(value: string): string {
  return value.replace(/_/g, " ");
}

export default async function MePage() {
  const me = await loadMe();
  const profile = await loadDashboardProfile(me.handle);
  const displayName =
    me.displayName?.trim() || (me.handle ? `@${me.handle}` : "Your profile");
  const activeKeys = me.accessKeys.filter((key) => !key.revokedAt);
  const revokedKeys = me.accessKeys.filter((key) => key.revokedAt);
  const rank = profile?.headline.rank ? `#${profile.headline.rank}` : "#-";
  const cost = profile ? formatCost(profile.headline.cost_usd_total) : "$0.00";

  const hasUsage = Boolean(profile && profile.headline.tokens_total > 0);
  return (
    <section className="dash-account" aria-labelledby="me-title">
      <header className="dash-page-title">
        <div>
          <p className="dash-eyebrow">YOUR ACCOUNT</p>
          <h1 id="me-title">Your public profile</h1>
          <p className="dash-subtitle" data-testid="me-display-name">
            {displayName}
          </p>
        </div>
        <div className="dash-account-actions">
          <Link className="dash-button" href="/me/settings">
            Edit profile
          </Link>
          {hasUsage && me.handle && (
            <Link className="dash-button primary" href={`/u/${me.handle}`}>
              View public profile ↗
            </Link>
          )}
          <SignOutButton />
        </div>
      </header>
      {hasUsage ? (
        <section
          className="dash-stat-grid dash-account-stats"
          aria-label="Published usage"
          data-testid="dashboard-rank-section"
        >
          <div className="dash-stat">
            <span>Overall rank</span>
            <strong data-testid="dashboard-rank-value">
              {rank === "#-" ? "—" : rank}
            </strong>
            <small>Across the community</small>
          </div>
          <div className="dash-stat">
            <span>Tokens shared</span>
            <strong data-testid="dashboard-token-value">
              {new Intl.NumberFormat("en-US", {
                notation: "compact",
                maximumFractionDigits: 1,
              }).format(profile!.headline.tokens_total)}
            </strong>
            <small>All time</small>
          </div>
          <div className="dash-stat">
            <span>API value</span>
            <strong data-testid="dashboard-cost-value">{cost}</strong>
            <small>Estimated value, not a bill</small>
          </div>
        </section>
      ) : (
        <div className="dash-account-notice">
          <span className="dash-status-dot" />
          <p>
            <strong>Your account is ready.</strong> Connect your local dashboard
            to share your first usage summary.
          </p>
        </div>
      )}
      <LocalConnectionCard />
      <div className="dash-account-secondary">
        <Link href="/onboarding/repos">Manage GitHub repositories →</Link>
      </div>
      <details
        className="dash-card dash-account-detail"
        data-testid="dashboard-runs-section"
      >
        <summary>
          Import history{" "}
          <span>{me.recentIngestionRuns.length} recent runs</span>
        </summary>
        <div className="dash-table-scroll">
          <table className="dash-table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Method</th>
                <th>Status</th>
                <th>Accepted</th>
                <th>Rejected</th>
              </tr>
            </thead>
            <tbody>
              {me.recentIngestionRuns.length ? (
                me.recentIngestionRuns.map((run) => (
                  <tr key={run.ingestionRunId} data-testid="ingestion-run-row">
                    <td>{formatDateTime(run.startedAt)}</td>
                    <td>{statusLabel(run.ingestionMode)}</td>
                    <td>{statusLabel(run.status)}</td>
                    <td>{run.acceptedCount}</td>
                    <td>{run.rejectedCount}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5}>
                    No browser or script imports yet. Local publishing history
                    is in your local app.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </details>
      <details
        className="dash-card dash-account-detail"
        data-testid="dashboard-keys-section"
      >
        <summary>
          Access keys <span>{activeKeys.length} active</span>
        </summary>
        <div className="dash-key-list">
          {activeKeys.length ? (
            activeKeys.map((key) => (
              <div
                key={key.keyId}
                data-testid="access-key-row"
                data-key-prefix={key.keyPrefix}
              >
                <div>
                  <code data-testid="access-key-prefix">{key.maskedKey}</code>
                  <p>
                    {key.scope} · Created {formatDateTime(key.createdAt)}
                  </p>
                </div>
                <RevokeAccessKeyButton keyId={key.keyId} />
              </div>
            ))
          ) : (
            <p>
              No active access keys. A connection code is all you need for the
              local app.
            </p>
          )}
          {revokedKeys.map((key) => (
            <div
              key={key.keyId}
              data-testid="access-key-revoked-row"
              data-key-prefix={key.keyPrefix}
            >
              <code>{key.maskedKey}</code>
              <p>Revoked {formatDateTime(key.revokedAt)}</p>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
