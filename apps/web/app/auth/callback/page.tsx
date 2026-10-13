"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { getApiBaseUrl } from "../../../lib/api";

export default function AuthCallbackPage() {
  const router = useRouter();
  const exchange = useRef<Promise<void> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!exchange.current) {
      const params = new URLSearchParams(window.location.hash.slice(1));
      const accessToken = params.get("access_token");
      const refreshToken = params.get("refresh_token");
      const providerToken = params.get("provider_token");
      const oauthError = params.get("error_description") ?? params.get("error");
      // Remove credentials even when the exchange fails. Strict Mode reuses the
      // in-flight promise instead of submitting the same session a second time.
      window.history.replaceState(null, "", "/auth/callback");
      exchange.current = (async () => {
        if (oauthError)
          throw new Error(
            "GitHub sign-in was not completed. Please try again.",
          );
        if (!accessToken || !refreshToken)
          throw new Error(
            "This sign-in link has expired. Please sign in again.",
          );
        const response = await fetch(
          `${getApiBaseUrl()}/api/auth/github/session`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              access_token: accessToken,
              refresh_token: refreshToken,
              provider_token: providerToken ?? undefined,
            }),
          },
        );
        if (!response.ok)
          throw new Error(
            "We couldn’t finish signing you in. Please try again.",
          );
      })();
    }
    exchange.current
      .then(() => {
        if (active) {
          const returnTo = sessionStorage.getItem('tokensrank:auth-return');
          sessionStorage.removeItem('tokensrank:auth-return');
          router.replace(returnTo?.startsWith('/connect/local?') ? returnTo : '/me');
          router.refresh();
        }
      })
      .catch((reason) => {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "Couldn’t reach the sign-in service. Please try again.",
          );
      });
    return () => {
      active = false;
    };
  }, [router]);

  return (
    <section className="dash-callback" aria-live="polite">
      {!error && <LoaderCircle className="dash-spin" size={24} />}
      <h1>{error ? "Sign-in failed" : "Signing you in"}</h1>
      <p role={error ? "alert" : "status"}>
        {error ?? "Connecting your GitHub account to TokensRank…"}
      </p>
      {error && (
        <Link href="/auth/sign-in" className="dash-button primary">
          Back to sign in
        </Link>
      )}
    </section>
  );
}
