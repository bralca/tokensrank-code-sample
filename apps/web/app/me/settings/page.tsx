import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import type {
  GetMeResponse,
  ProfileUpdate,
} from "../../../../../packages/shared/src/schemas";
import { serverApiFetch } from "../../lib/api-server";
import { ApiError } from "../../lib/api";
import SettingsForm, { type ProfileSaveState } from "./settings-form";

async function loadMe(): Promise<GetMeResponse["data"]> {
  try {
    const response = await serverApiFetch<GetMeResponse>("/api/me", {
      requestHeaders: await headers(),
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

function nullableFormValue(
  value: FormDataEntryValue | null,
): string | null | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

async function updateProfileAction(_previous: ProfileSaveState, formData: FormData): Promise<ProfileSaveState> {
  "use server";

  const displayName = nullableFormValue(formData.get("displayName"));
  const avatarUrl = nullableFormValue(formData.get("avatarUrl"));
  const bio = nullableFormValue(formData.get("bio"));
  let xHandle = nullableFormValue(formData.get("xHandle"));

  // Normalize X handle by stripping @ prefix
  if (xHandle) {
    xHandle = xHandle.replace(/^@/, "");
  }

  const payload: ProfileUpdate = {
    ...(displayName !== undefined ? { displayName: displayName ?? "" } : {}),
    ...(avatarUrl !== undefined ? { avatarUrl } : {}),
    ...(bio !== undefined ? { bio: bio ?? "" } : {}),
    ...(xHandle !== undefined ? { xHandle: xHandle ?? null } : {}),
  };

  try {
    await serverApiFetch("/api/me/profile", {
      method: "PATCH",
      requestHeaders: await headers(),
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/auth/sign-in");
    }
    return { error: "Couldn’t save your profile. Please try again." };
  }
  revalidatePath("/me");
  redirect("/me");
}

export default async function SettingsPage() {
  const me = await loadMe();

  return (
    <main className="dash-account-page">
      <section
        className="mx-auto flex max-w-3xl flex-col gap-6"
        aria-labelledby="settings-title"
      >
        <header className="flex flex-col gap-2">
          <p className="font-sans text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
            Settings
          </p>
          <h1 id="settings-title" className="text-3xl font-semibold">
            Edit profile
          </h1>
        </header>
        <Link href="/me" className="text-sm text-[var(--accent-ink)]">← Back to your account</Link>
        <SettingsForm me={me} action={updateProfileAction} />
      </section>
    </main>
  );
}
