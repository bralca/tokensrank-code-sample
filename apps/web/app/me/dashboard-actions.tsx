"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type RevokeAccessKeyButtonProps = {
  keyId: string;
};

type PublishLinkStartResponse = {
  data?: {
    code: string;
    expires_at: string;
  };
  error?: {
    message?: string;
  };
};

async function mutate(path: string, method: "DELETE" | "POST"): Promise<void> {
  const response = await fetch(path, {
    credentials: "include",
    method,
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
}

export function CreateLocalPublishCodeButton() {
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!expiresAt) return;
    setExpired(Date.parse(expiresAt) <= Date.now());
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  async function createCode(): Promise<void> {
    setError(null);
    setIsPending(true);

    try {
      const response = await fetch("/api/publish/link/start", {
        credentials: "include",
        method: "POST",
        headers: {
          Accept: "application/json",
        },
      });
      const body = (await response.json()) as PublishLinkStartResponse;

      if (!response.ok || !body.data?.code) {
        throw new Error(
          body.error?.message ??
            `Request failed with status ${response.status}`,
        );
      }

      setCode(body.data.code);
      setCopied(false);
      setExpired(false);
      setExpiresAt(body.data.expires_at);
    } catch (mutationError) {
      console.warn("[web] Failed to create local publish code", mutationError);
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Could not create publish code.",
      );
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        className="dash-button primary"
        data-testid="create-local-publish-code"
        disabled={isPending}
        onClick={createCode}
        type="button"
      >
        {isPending
          ? "Creating…"
          : code
            ? "Create a new code"
            : "Create connection code"}
      </button>
      {code ? (
        <div className="dash-connection-code">
          <p className="font-sans text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
            Paste into local Publishing
          </p>
          <p
            className="mt-1 break-all font-sans text-sm text-[var(--ink)]"
            data-testid="local-publish-code"
          >
            {code}
          </p>
          <button
            className="dash-button"
            type="button"
            disabled={expired}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(code);
                setCopied(true);
              } catch {
                setError("Select the code above and copy it manually.");
              }
            }}
          >
            {copied ? "Copied" : "Copy code"}
          </button>
          {expiresAt ? (
            <p className="mt-1 text-xs text-[var(--muted)]" role="status">
              {expired
                ? "This code expired. Create a new one."
                : `Expires ${new Date(expiresAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`}
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p className="text-xs text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function RevokeAccessKeyButton({ keyId }: RevokeAccessKeyButtonProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  async function revokeKey(): Promise<void> {
    setError(null);
    setIsPending(true);

    try {
      await mutate(`/api/access-keys/${encodeURIComponent(keyId)}`, "DELETE");
      router.refresh();
    } catch (mutationError) {
      console.warn("[web] Failed to revoke access key", mutationError);
      setError("Could not revoke key. Try again.");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <button
        className="dash-button"
        data-testid={`access-key-revoke-${keyId}`}
        disabled={isPending}
        onClick={revokeKey}
        type="button"
      >
        {isPending ? "Revoking..." : "Revoke"}
      </button>
      {error ? (
        <p className="text-xs text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function SignOutButton() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  async function signOut(): Promise<void> {
    setError(null);
    setIsPending(true);

    try {
      await mutate("/api/auth/sign-out", "POST");
      router.push("/");
      router.refresh();
    } catch (mutationError) {
      console.warn("[web] Failed to sign out", mutationError);
      setError("Could not sign out. Try again.");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        className="dash-button"
        data-testid="sign-out-button"
        disabled={isPending}
        onClick={signOut}
        type="button"
      >
        {isPending ? "Signing out..." : "Sign out"}
      </button>
      {error ? (
        <p className="text-xs text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
