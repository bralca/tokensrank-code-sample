"use client";

import { useActionState, useCallback, useRef, useState } from "react";
import type { GetMeResponse } from "../../../../../packages/shared/src/schemas";
import { avatarProxyUrl } from "../../lib/avatar-url";

const VALIDATIONS = {
  displayName: {
    maxLength: 100,
    validate: (v: string) => (v.length <= 100 ? null : "Max 100 characters"),
  },
  avatarUrl: {
    validate: (v: string) => {
      if (!v) return null;
      try {
        const url = new URL(v);
        // Require http(s) protocol
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return "Must be http(s) URL";
        }
        return null;
      } catch {
        return "Must be a valid URL";
      }
    },
    validateAsync: async (v: string): Promise<string | null> => {
      if (!v) return null;

      const proxiedUrl = avatarProxyUrl(v);

      if (!proxiedUrl) {
        return "Must be an http(s) image URL";
      }

      return new Promise((resolve) => {
        const image = new Image();
        const timeout = window.setTimeout(() => {
          image.src = "";
          resolve("Image URL timed out");
        }, 8000);

        image.onload = () => {
          window.clearTimeout(timeout);
          resolve(null);
        };
        image.onerror = () => {
          window.clearTimeout(timeout);
          resolve("Image URL could not be loaded");
        };
        image.src = proxiedUrl;
      });
    },
  },
  bio: {
    maxLength: 500,
    validate: (v: string) => (v.length <= 500 ? null : "Max 500 characters"),
  },
  xHandle: {
    maxLength: 15,
    validate: (v: string) => {
      if (!v) return null; // Blank is valid (clears the field)
      const normalized = v.replace(/^@/, "");
      if (!/^[A-Za-z0-9_]{1,15}$/.test(normalized)) {
        return "Only letters, numbers, and underscore. 1-15 characters.";
      }
      return null;
    },
  },
};

type FieldName = keyof typeof VALIDATIONS;

export type ProfileSaveState = { error?: string };

interface SettingsFormProps {
  me: GetMeResponse["data"];
  action: (previous: ProfileSaveState, formData: FormData) => Promise<ProfileSaveState>;
}

export default function SettingsForm({ me, action }: SettingsFormProps) {
  const [saveState, submitAction, isSaving] = useActionState(action, {});
  const [fieldErrors, setFieldErrors] = useState<
    Record<FieldName, string | null>
  >({
    displayName: null,
    avatarUrl: null,
    bio: null,
    xHandle: null,
  });

  const [fieldValues, setFieldValues] = useState<Record<FieldName, string>>({
    displayName: me.displayName ?? "",
    avatarUrl: me.avatarUrl ?? "",
    bio: me.bio ?? "",
    xHandle: me.xHandle ?? "",
  });

  const [isValidatingAvatar, setIsValidatingAvatar] = useState(false);
  const avatarValidationId = useRef(0);

  const validateField = useCallback((field: FieldName, value: string) => {
    const validator = VALIDATIONS[field];
    const error = validator.validate(value);
    setFieldErrors((prev) => ({ ...prev, [field]: error }));
    if (field === "avatarUrl") {
      avatarValidationId.current += 1;
      setIsValidatingAvatar(false);
    }

    // For avatar URL, also run async validation
    if (field === "avatarUrl" && !error && "validateAsync" in validator) {
      const validationId = avatarValidationId.current + 1;
      avatarValidationId.current = validationId;
      setIsValidatingAvatar(true);
      (validator.validateAsync as (v: string) => Promise<string | null>)(
        value,
      ).then((asyncError: string | null) => {
        if (avatarValidationId.current !== validationId) {
          return;
        }

        setFieldErrors((prev) => ({ ...prev, [field]: asyncError }));
        setIsValidatingAvatar(false);
      });
    }

    return !error;
  }, []);

  const handleFieldChange = useCallback(
    (field: FieldName, value: string) => {
      // Auto-normalize X handle by removing @ as user types
      if (field === "xHandle") {
        value = value.replace(/^@/, "");
      }
      setFieldValues((prev) => ({ ...prev, [field]: value }));
      validateField(field, value);
    },
    [validateField],
  );

  const isFormValid =
    Object.values(fieldErrors).every((err) => err === null) &&
    !isValidatingAvatar;

  return (
    <form action={submitAction} className="flex flex-col gap-5">

      <label className="flex flex-col gap-2 text-sm">
        <div className="flex items-center justify-between">
          <span>Display name</span>
          <span className="text-xs text-[var(--muted)]">
            {fieldValues.displayName.length}/100
          </span>
        </div>
        <input
          className={`rounded-md border bg-white px-3 py-2 text-[var(--ink)] transition-colors ${
            fieldErrors.displayName
              ? "border-red-500 focus:border-red-500 focus:outline-none"
              : "border-[var(--line)] focus:border-[var(--accent)] focus:outline-none"
          }`}
          data-testid="profile-display-name"
          name="displayName"
          value={fieldValues.displayName}
          onChange={(e) => handleFieldChange("displayName", e.target.value)}
          maxLength={100}
        />
        {fieldErrors.displayName && (
          <span className="text-xs text-red-700">
            {fieldErrors.displayName}
          </span>
        )}
      </label>

      <label className="flex flex-col gap-2 text-sm">
        <span>Avatar URL</span>
        <input
          className={`rounded-md border bg-white px-3 py-2 text-[var(--ink)] transition-colors ${
            fieldErrors.avatarUrl
              ? "border-red-500 focus:border-red-500 focus:outline-none"
              : "border-[var(--line)] focus:border-[var(--accent)] focus:outline-none"
          }`}
          data-testid="profile-avatar-url"
          name="avatarUrl"
          value={fieldValues.avatarUrl}
          onChange={(e) => handleFieldChange("avatarUrl", e.target.value)}
          type="text"
          placeholder="https://example.com/avatar.jpg"
        />
        {fieldErrors.avatarUrl && (
          <span className="text-xs text-red-700">{fieldErrors.avatarUrl}</span>
        )}
        {fieldValues.avatarUrl &&
          !fieldErrors.avatarUrl &&
          !isValidatingAvatar && (
            <span className="text-xs text-[var(--accent-ink)]">✓ Image loaded</span>
          )}
        {fieldValues.avatarUrl && isValidatingAvatar && (
          <span className="text-xs text-[var(--muted)]">Checking image...</span>
        )}
      </label>

      <label className="flex flex-col gap-2 text-sm">
        <div className="flex items-center justify-between">
          <span>Bio</span>
          <span className="text-xs text-[var(--muted)]">
            {fieldValues.bio.length}/500
          </span>
        </div>
        <textarea
          className={`min-h-28 rounded-md border bg-white px-3 py-2 text-[var(--ink)] transition-colors ${
            fieldErrors.bio
              ? "border-red-500 focus:border-red-500 focus:outline-none"
              : "border-[var(--line)] focus:border-[var(--accent)] focus:outline-none"
          }`}
          data-testid="profile-bio"
          name="bio"
          value={fieldValues.bio}
          onChange={(e) => handleFieldChange("bio", e.target.value)}
          maxLength={500}
        />
        {fieldErrors.bio && (
          <span className="text-xs text-red-700">{fieldErrors.bio}</span>
        )}
      </label>

      <label className="flex flex-col gap-2 text-sm">
        <div className="flex items-center justify-between">
          <span>X handle</span>
          <span className="text-xs text-[var(--muted)]">
            {fieldValues.xHandle.length}/15
          </span>
        </div>
        <input
          className={`rounded-md border bg-white px-3 py-2 text-[var(--ink)] transition-colors ${
            fieldErrors.xHandle
              ? "border-red-500 focus:border-red-500 focus:outline-none"
              : "border-[var(--line)] focus:border-[var(--accent)] focus:outline-none"
          }`}
          data-testid="profile-x-handle"
          name="xHandle"
          value={fieldValues.xHandle}
          onChange={(e) => handleFieldChange("xHandle", e.target.value)}
          placeholder="your_handle"
          maxLength={20}
        />
        <span className="text-xs text-[var(--muted)]">
          Letters, numbers, underscore only
        </span>
        {fieldErrors.xHandle && (
          <span className="text-xs text-red-700">{fieldErrors.xHandle}</span>
        )}
        {fieldValues.xHandle && !fieldErrors.xHandle && (
          <span className="text-xs text-[var(--accent-ink)]">✓ Valid handle</span>
        )}
      </label>

      {saveState.error && <p role="alert" className="dash-form-error">{saveState.error}</p>}
      <button
        className="dash-button primary w-fit"
        data-testid="profile-submit"
        type="submit"
        disabled={!isFormValid || isSaving}
      >
        {isSaving ? "Saving…" : isValidatingAvatar ? "Validating avatar..." : "Save profile"}
      </button>
    </form>
  );
}
