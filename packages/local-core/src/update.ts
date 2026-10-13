import type { LocalVersionStatus } from '@tokensrank/shared';

const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org';

type NpmPackageMetadata = {
  'dist-tags'?: {
    latest?: string;
  };
  versions?: Record<string, unknown>;
};

function parseVersion(version: string): number[] {
  return version
    .replace(/^v/u, '')
    .split(/[.-]/u)
    .slice(0, 3)
    .map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
}

export function compareSemverLike(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

export function defaultVersionStatus(options: {
  packageName: string;
  currentVersion: string;
}): LocalVersionStatus {
  return {
    package_name: options.packageName,
    current_version: options.currentVersion,
    latest_version: null,
    update_available: false,
    checked_at: null,
    source: 'unknown',
    release_url: null,
    last_error: null,
  };
}

export async function checkLocalVersionStatus(options: {
  packageName: string;
  currentVersion: string;
  registryUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<LocalVersionStatus> {
  const registryUrl = (options.registryUrl ?? DEFAULT_REGISTRY_URL).replace(/\/$/u, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const packagePath = encodeURIComponent(options.packageName).replace(/^%40/u, '@');
  const checkedAt = new Date().toISOString();

  try {
    const response = await fetchImpl(`${registryUrl}/${packagePath}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'tokensrank-local-update-check',
      },
    });
    if (!response.ok) {
      throw new Error(`registry returned ${response.status} ${response.statusText}`);
    }

    const metadata = await response.json() as NpmPackageMetadata;
    const latestVersion = metadata['dist-tags']?.latest ?? Object.keys(metadata.versions ?? {}).sort(compareSemverLike).at(-1);
    if (!latestVersion) {
      throw new Error('registry response did not include a latest version');
    }

    return {
      package_name: options.packageName,
      current_version: options.currentVersion,
      latest_version: latestVersion,
      update_available: compareSemverLike(latestVersion, options.currentVersion) > 0,
      checked_at: checkedAt,
      source: 'npm',
      release_url: `https://www.npmjs.com/package/${options.packageName}/v/${latestVersion}`,
      last_error: null,
    };
  } catch (error) {
    return {
      package_name: options.packageName,
      current_version: options.currentVersion,
      latest_version: null,
      update_available: false,
      checked_at: checkedAt,
      source: 'unknown',
      release_url: null,
      last_error: error instanceof Error ? error.message : String(error),
    };
  }
}
