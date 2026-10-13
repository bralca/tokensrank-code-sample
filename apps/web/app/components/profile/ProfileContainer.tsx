import type { ReactNode } from "react";
import { apiFetchWithMeta } from "@/lib/api";
import {
  ProfileResponseSchema,
  type ProfileResponse,
  type ProfileWindow,
} from "@tokensrank/shared";
import { UsageDashboard } from "../dashboard/UsageDashboard";
import { PublicHeader } from "../dashboard/PublicHeader";

export async function ProfileContainer({
  handle,
  window = "all",
  initialProfile,
  fallback,
  showHeader = true,
}: {
  handle: string;
  window?: ProfileWindow;
  initialProfile?: ProfileResponse;
  fallback?: ReactNode;
  showHeader?: boolean;
}) {
  try {
    let profile = initialProfile;
    if (!profile) {
      const result = await apiFetchWithMeta<unknown>(
        `/api/profile/${encodeURIComponent(handle)}?window=${window}`,
        { cache: "no-store" },
      );
      const raw = result.data as Record<string, unknown>;
      profile = ProfileResponseSchema.parse(
        raw && "window" in raw ? raw : raw?.data,
      );
    }
    return (
      <div className={showHeader ? "dashboard" : "dash-local-profile"}>
        {showHeader && <PublicHeader />}
        <UsageDashboard profile={profile} local={!showHeader} />
      </div>
    );
  } catch (error) {
    console.error("Failed to load profile:", error);
    return (
      fallback ?? (
        <div className={showHeader ? "dashboard" : "dash-local-profile"}>
          <div className="dash-content dash-card">
            <h1>Usage unavailable</h1>
            <p>{showHeader ? "We couldn’t load this profile. Please try again in a moment." : "Check that the local app is running, then reload this page."}</p>
          </div>
        </div>
      )
    );
  }
}
