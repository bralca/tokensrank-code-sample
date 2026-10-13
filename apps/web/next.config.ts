import path from "node:path";
import { readFileSync } from "node:fs";
import type { NextConfig } from "next";
import {
  scanDirectory,
  type BundleAuditViolation,
} from "./scripts/check-no-service-role-leak";
import { getLocalAppUrl } from "./lib/local-app-url";

interface WebpackDoneStats {
  hasErrors(): boolean;
}

interface WebpackDoneHook {
  tapPromise(
    pluginName: string,
    callback: (stats: WebpackDoneStats) => Promise<void>,
  ): void;
}

interface WebpackCompiler {
  hooks: {
    done: WebpackDoneHook;
  };
}

class TokensRankBundleAuditPlugin {
  private readonly bundleDir: string;

  public constructor(bundleDir: string) {
    this.bundleDir = bundleDir;
  }

  /**
   * Enforces NFR-9 by failing production client builds when forbidden secret
   * patterns appear in emitted Next.js bundle files.
   */
  public apply(compiler: WebpackCompiler): void {
    compiler.hooks.done.tapPromise(
      "TokensRankBundleAuditPlugin",
      async (stats) => {
        if (stats.hasErrors()) {
          return;
        }

        const violations = await scanDirectory(this.bundleDir);

        if (violations.length === 0) {
          console.log(
            `[bundle-audit] Clean: no forbidden frontend secrets found in ${this.bundleDir}`,
          );
          return;
        }

        const details = formatViolations(violations);
        throw new Error(
          `NFR-9 bundle audit failed with ${violations.length} violation(s):\n${details}`,
        );
      },
    );
  }
}

function formatViolations(violations: BundleAuditViolation[]): string {
  return violations
    .map((violation) => {
      return `${violation.filePath}:${violation.lineNumber} ${violation.patternName} ${violation.context}`;
    })
    .join("\n");
}

function loadRootEnv(): void {
  const root = path.resolve(process.cwd(), "../..");
  for (const name of [".env.local", ".env"]) {
    let contents: string;
    try {
      contents = readFileSync(path.resolve(root, name), "utf8");
    } catch (error) {
      if (
        ["ENOENT", "ELOOP"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        continue;
      throw error;
    }
    for (const line of contents.split(/\r?\n/u)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^['"]|['"]$/gu, "");
      }
    }
  }
}

loadRootEnv();

const distDir = process.env.TOKENSRANK_WEB_DIST_DIR ?? ".next";
const nextConfig: NextConfig = {
  distDir,
  reactStrictMode: true,
  redirects: async () => {
    const appMode = process.env.NEXT_PUBLIC_APP_MODE;
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "";
    const publicApp =
      appMode !== undefined
        ? appMode === "public"
        : distDir === ".next-public" ||
          (process.env.NODE_ENV === "production" &&
            /^https?:\/\//.test(siteUrl) &&
            !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(siteUrl));
    return publicApp
      ? [
          {
            source: "/local/:path*",
            destination: getLocalAppUrl("/local/:path*"),
            permanent: false,
          },
        ]
      : [];
  },
  rewrites: async () => {
    return {
      beforeFiles: [
        {
          source: "/og/u/:handle.png",
          destination: "/og/u/:handle",
        },
        {
          source: "/api/:path*",
          destination: `${process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3001"}/api/:path*`,
        },
      ],
    };
  },
  webpack: (config, { dev, isServer }) => {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };

    if (!dev && !isServer && process.env.TOKENSRANK_SKIP_BUNDLE_AUDIT !== "1") {
      config.plugins = config.plugins ?? [];
      config.plugins.push(
        new TokensRankBundleAuditPlugin(path.resolve(process.cwd(), distDir)),
      );
    }

    return config;
  },
};

export default nextConfig;
