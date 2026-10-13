"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";

import { LocalConnectionCard } from "../../components/dashboard/LocalConnectionCard";

import { apiFetch } from "../../lib/api";
import {
  PARSER_VERSION,
  parseUsageFiles,
  type ParsedSourceFile,
  type ParsedUsageEvent,
  type ParsedUsageImport,
} from "./usage-import-parser";

type ImportStatus = "idle" | "parsing" | "uploading" | "done" | "error";

type UsageImportApiResponse = {
  data: {
    ingestion_run_id: string;
    accepted_count: number;
    deduped_count: number;
    rejected_count: number;
    projected: boolean;
    rejected_details: Array<{
      event_id: string;
      reason_code: string;
      details?: Record<string, unknown>;
    }>;
  };
};

type UsageImportFinalizeApiResponse = {
  data: {
    projected: boolean;
  };
};

type UploadTotals = {
  accepted: number;
  deduped: number;
  rejected: number;
  batches: number;
};

const EVENT_BATCH_SIZE = 1000;
const FILE_BATCH_SIZE = 200;
const UPLOAD_CONCURRENCY = 3;

type UsageImportClientProps = {
  handle: string | null;
};

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function sourceFileKey(source: string, hash: string): string {
  return `${source}:${hash}`;
}

function filesForKeys(
  files: ParsedSourceFile[],
  keys: Set<string>,
): ParsedSourceFile[] {
  return files.filter((file) =>
    keys.has(sourceFileKey(file.source, file.source_file_hash)),
  );
}

function selectedFileKey(file: File): string {
  return [
    file.webkitRelativePath || file.name,
    file.name,
    file.size,
    file.lastModified,
  ].join(":");
}

function mergeSelectedFiles(current: File[], incoming: File[]): File[] {
  const byKey = new Map(current.map((file) => [selectedFileKey(file), file]));

  for (const file of incoming) {
    byKey.set(selectedFileKey(file), file);
  }

  return Array.from(byKey.values());
}

function selectedFolderNames(files: File[]): string[] {
  return Array.from(
    new Set(
      files.map((file) => {
        const path = file.webkitRelativePath || file.name;

        return path.split("/").filter(Boolean)[0] ?? file.name;
      }),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

function buildUploadBatches(result: ParsedUsageImport): Array<{
  events: ParsedUsageEvent[];
  fileKeys: Set<string>;
}> {
  const batches: Array<{ events: ParsedUsageEvent[]; fileKeys: Set<string> }> =
    [];
  let events: ParsedUsageEvent[] = [];
  let fileKeys = new Set<string>();

  function flush() {
    if (events.length === 0) {
      return;
    }

    batches.push({ events, fileKeys });
    events = [];
    fileKeys = new Set<string>();
  }

  for (const event of result.events) {
    const key = sourceFileKey(event.source, event.source_file_hash);
    const wouldAddFile = !fileKeys.has(key);

    if (
      events.length >= EVENT_BATCH_SIZE ||
      (wouldAddFile && fileKeys.size >= FILE_BATCH_SIZE)
    ) {
      flush();
    }

    events.push(event);
    fileKeys.add(key);
  }

  flush();

  return batches;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    const index = nextIndex;
    nextIndex += 1;

    const item = items[index];

    if (!item) {
      return;
    }

    await worker(item, index);
    await runNext();
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () =>
      runNext(),
    ),
  );
}

export function UsageImportClient({ handle }: UsageImportClientProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<ImportStatus>("idle");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [parsed, setParsed] = useState<ParsedUsageImport | null>(null);
  const [totals, setTotals] = useState<UploadTotals>({
    accepted: 0,
    deduped: 0,
    rejected: 0,
    batches: 0,
  });
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);

  const folders = useMemo(
    () => selectedFolderNames(selectedFiles),
    [selectedFiles],
  );
  const canImport =
    selectedFiles.length > 0 && status !== "parsing" && status !== "uploading";
  const directoryProps = useMemo(
    () =>
      ({
        directory: "",
        webkitdirectory: "",
      }) as Record<string, string>,
    [],
  );

  async function uploadParsedImport(result: ParsedUsageImport) {
    const startedAt = new Date().toISOString();
    const runId = crypto.randomUUID();
    const batches = buildUploadBatches(result);
    const aggregate: UploadTotals = {
      accepted: 0,
      deduped: 0,
      rejected: 0,
      batches: 0,
    };
    let completedBatches = 0;

    await runWithConcurrency(batches, UPLOAD_CONCURRENCY, async (batch) => {
      const events = batch?.events ?? [];

      setProgress(
        `Uploading ${batches.length} batches with ${Math.min(UPLOAD_CONCURRENCY, batches.length)} parallel requests`,
      );

      const response = await apiFetch<UsageImportApiResponse>(
        "/api/me/usage/import",
        {
          method: "POST",
          body: JSON.stringify({
            client: {
              version: PARSER_VERSION,
              import_surface: "browser_folder",
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
            run: {
              run_id: runId,
              started_at: startedAt,
              finished_at: new Date().toISOString(),
            },
            files: batch ? filesForKeys(result.files, batch.fileKeys) : [],
            events,
            warnings: result.warnings.slice(0, 200),
          }),
        },
      );

      aggregate.accepted += response.data.accepted_count;
      aggregate.deduped += response.data.deduped_count;
      aggregate.rejected += response.data.rejected_count;
      aggregate.batches += 1;
      completedBatches += 1;
      setTotals({ ...aggregate });
      setProgress(`Uploaded ${completedBatches} of ${batches.length} batches`);
    });

    setProgress("Finalizing profile data");

    await apiFetch<UsageImportFinalizeApiResponse>(
      "/api/me/usage/import/finalize",
      {
        method: "POST",
        body: JSON.stringify({
          run: {
            run_id: runId,
            started_at: startedAt,
            finished_at: new Date().toISOString(),
          },
        }),
      },
    );
  }

  async function handleImport() {
    const files = selectedFiles;

    if (files.length === 0) {
      return;
    }

    setError(null);
    setParsed(null);
    setTotals({ accepted: 0, deduped: 0, rejected: 0, batches: 0 });
    setStatus("parsing");
    setProgress("Reading local files");

    try {
      const result = await parseUsageFiles(files);
      setParsed(result);

      if (result.events.length === 0) {
        setStatus("error");
        setError(
          `No Claude or Codex token usage records were found. Scanned ${formatNumber(result.scannedFiles)} JSON/JSONL files and skipped ${formatNumber(result.skippedFiles)} files.`,
        );
        setProgress("");
        return;
      }

      setStatus("uploading");
      await uploadParsedImport(result);
      setStatus("done");
      setProgress("Import complete");
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "Import failed");
      setProgress("");
    }
  }

  return (
    <div className="dash-import-page">
      <section
        className="mx-auto flex max-w-5xl flex-col gap-8"
        aria-labelledby="usage-import-title"
      >
        <header className="flex flex-col gap-4 border-b border-[var(--line)] pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex flex-col gap-2">
            <p className="font-sans text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
              Import
            </p>
            <h1 id="usage-import-title" className="text-3xl font-semibold">
              Import usage
            </h1>
            <p className="max-w-2xl text-sm text-[var(--muted)]">
              Start with the local dashboard. You can also import usage folders
              manually below.
            </p>
          </div>
          <Link
            className="dash-button"
            href="/me"
          >
            Back to dashboard
          </Link>
        </header>

        <LocalConnectionCard />

        <details className="dash-card dash-account-detail dash-manual-import">
          <summary>
            Import folders manually <span>Alternative to the local app</span>
          </summary>
          <div className="dash-manual-import-content">
            <div className="mb-5 flex flex-col gap-2">
              <p className="font-sans text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
                Fallback
              </p>
              <h2 className="text-xl font-semibold text-[var(--ink)]">
                Browser folder upload
              </h2>
            </div>

            <div className="mb-5 grid gap-3 rounded-md border border-[var(--line)] bg-[var(--surface-muted)] p-4 text-sm text-[var(--muted)] sm:grid-cols-3">
              <div>
                <p className="font-sans text-xs uppercase tracking-[0.12em] text-[var(--ink)]">
                  1. Pick a folder
                </p>
                <p className="mt-2 leading-6">
                  Choose a Claude or Codex usage folder, or a parent folder
                  containing both.
                </p>
              </div>
              <div>
                <p className="font-sans text-xs uppercase tracking-[0.12em] text-[var(--ink)]">
                  2. Read and import
                </p>
                <p className="mt-2 leading-6">
                  Only usage counters are sent when you click Import usage.
                  Conversations stay on your computer.
                </p>
              </div>
              <div>
                <p className="font-sans text-xs uppercase tracking-[0.12em] text-[var(--ink)]">
                  3. Reimport anytime
                </p>
                <p className="mt-2 leading-6">
                  Sending full history again is safe; already-seen records are
                  deduped.
                </p>
              </div>
            </div>

            <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
              <div className="flex min-w-0 flex-col gap-2">
                <span className="font-sans text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
                  Folders
                </span>
                <input
                  {...directoryProps}
                  ref={inputRef}
                  className="sr-only"
                  multiple
                  onChange={(event) => {
                    const incoming = Array.from(
                      event.currentTarget.files ?? [],
                    );

                    setSelectedFiles((current) =>
                      mergeSelectedFiles(current, incoming),
                    );
                    setParsed(null);
                    setError(null);
                    setProgress("");
                    setStatus("idle");

                    event.currentTarget.value = "";
                  }}
                  type="file"
                />
                <div className="flex min-h-12 flex-col items-stretch justify-between gap-3 rounded-md border border-[var(--line)] bg-[var(--surface-muted)] px-3 py-2 sm:flex-row sm:items-center">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-[var(--ink)]">
                      {folders.length > 0
                        ? `${formatNumber(folders.length)} folder${folders.length === 1 ? "" : "s"} selected`
                        : "No folders selected"}
                    </p>
                    <p className="mt-1 truncate text-xs text-[var(--muted)]">
                      {folders.length > 0
                        ? `${folders.slice(0, 4).join(", ")}${folders.length > 4 ? ` +${folders.length - 4} more` : ""}`
                        : "Add Codex, Claude, or a parent folder containing both."}
                    </p>
                  </div>
                  <button
                    className="dash-button primary "
                    disabled={status === "parsing" || status === "uploading"}
                    onClick={() => inputRef.current?.click()}
                    type="button"
                  >
                    Add folder
                  </button>
                </div>
                <p className="text-xs text-[var(--muted)]">
                  Your browser will ask for permission before the selected
                  folder is readable.
                </p>
              </div>
              {selectedFiles.length > 0 ? (
                <button
                  className="rounded-md border border-[var(--line)] px-4 py-2 text-sm text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--ink)]"
                  disabled={status === "parsing" || status === "uploading"}
                  onClick={() => {
                    setSelectedFiles([]);
                    setParsed(null);
                    setError(null);
                    setProgress("");
                    setTotals({
                      accepted: 0,
                      deduped: 0,
                      rejected: 0,
                      batches: 0,
                    });
                    setStatus("idle");

                    if (inputRef.current) {
                      inputRef.current.value = "";
                    }
                  }}
                  type="button"
                >
                  Clear
                </button>
              ) : null}
              <button
                className="dash-button primary "
                disabled={!canImport}
                onClick={handleImport}
                type="button"
              >
                {status === "parsing"
                  ? "Parsing..."
                  : status === "uploading"
                    ? "Uploading..."
                    : "Import usage"}
              </button>
            </div>

            <div className="mt-6 grid gap-3 sm:grid-cols-4">
              <div className="rounded-md border border-[var(--line)] bg-[var(--surface-muted)] p-4">
                <p className="font-sans text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
                  Files
                </p>
                <p className="mt-2 font-sans text-2xl">
                  {formatNumber(selectedFiles.length)}
                </p>
              </div>
              <div className="rounded-md border border-[var(--line)] bg-[var(--surface-muted)] p-4">
                <p className="font-sans text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
                  Events
                </p>
                <p className="mt-2 font-sans text-2xl">
                  {formatNumber(parsed?.events.length ?? 0)}
                </p>
              </div>
              <div className="rounded-md border border-[var(--line)] bg-[var(--surface-muted)] p-4">
                <p className="font-sans text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
                  Accepted
                </p>
                <p className="mt-2 font-sans text-2xl">
                  {formatNumber(totals.accepted)}
                </p>
              </div>
              <div className="rounded-md border border-[var(--line)] bg-[var(--surface-muted)] p-4">
                <p className="font-sans text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
                  Deduped
                </p>
                <p className="mt-2 font-sans text-2xl">
                  {formatNumber(totals.deduped)}
                </p>
              </div>
            </div>

            {progress ? (
              <p className="mt-4 font-sans text-xs text-[var(--muted)]">
                {progress}
              </p>
            ) : null}
            {error ? (
              <p className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            ) : null}
            {status === "done" ? (
              <div className="dash-button primary mt-4">
                <p>
                  Imported {formatNumber(totals.accepted)} new records and
                  skipped {formatNumber(totals.deduped)} already-seen records.
                </p>
                <div className="flex flex-wrap gap-3">
                  {handle ? (
                    <Link
                      className="dash-button primary "
                      href={`/u/${handle}`}
                    >
                      View profile
                    </Link>
                  ) : null}
                  <Link
                    className="rounded-md border border-[var(--accent)]/50 px-3 py-1.5 text-xs font-semibold text-[var(--accent-ink)]"
                    href="/me"
                  >
                    Dashboard
                  </Link>
                </div>
              </div>
            ) : null}
            {parsed?.warnings.length ? (
              <div className="mt-4 rounded-md border border-[var(--line)] bg-[var(--surface-muted)] p-4">
                <p className="font-sans text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
                  Parser warnings
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--muted)]">
                  {parsed.warnings.slice(0, 6).map((warning, index) => (
                    <li key={`${warning}:${index}`}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </details>
      </section>
    </div>
  );
}
