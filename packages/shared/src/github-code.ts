// Bump when the remote counting rules change. Older caches may contain only
// the first page of files, or local rename/committer-date evidence.
export const GITHUB_CODE_METRICS_VERSION = 2;
export const GITHUB_CODE_PER_COMMIT_CAP = 2000;

const NONSHIPPING_PATTERNS = [
  /\.(md|mdx|rst|txt)$/i, /(^|\/)docs\//i, /(^|\/)license(\.|$)/i,
  /-lock\.json$/i, /\.lock$/i, /(^|\/)(pnpm-lock\.yaml|yarn\.lock|package-lock\.json)$/i,
  /(^|\/)(dist|build|vendor|node_modules)\//i, /\.min\.(js|css)$/i,
  /\.map$/i, /\.(csv|svg|snap)$/i,
];

export function isNonShippingPath(path: string): boolean {
  return NONSHIPPING_PATTERNS.some((pattern) => pattern.test(path));
}

type CommitFile = { filename: string; additions?: number };

/** Both apps count GitHub's rename-aware additions, across every file page. */
export async function readGithubCodeCounts(
  readPage: (page: number) => Promise<{ files?: CommitFile[] | null; hasNextPage: boolean }>,
): Promise<{ raw: number; score: number }> {
  const seen = new Set<string>();
  let raw = 0;
  for (let page = 1; page <= 30; page++) {
    const result = await readPage(page);
    if (!Array.isArray(result.files)) throw new Error('GitHub did not return commit files. Code verification is unavailable.');
    for (const file of result.files) {
      if (seen.has(file.filename)) continue;
      seen.add(file.filename);
      if (!isNonShippingPath(file.filename)) raw += Math.max(0, file.additions ?? 0);
    }
    // GitHub truncates commit diffs at 3,000 files. Never use a partial result
    // as evidence that the user's claim is false.
    if (seen.size >= 3000) break;
    if (!result.hasNextPage) return { raw, score: Math.min(raw, GITHUB_CODE_PER_COMMIT_CAP) };
  }
  throw new Error('GitHub could not return the complete commit diff. Code verification is unavailable.');
}
