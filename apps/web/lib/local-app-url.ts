/** The local app is a separate origin from the public leaderboard. */
export function getLocalAppUrl(path = "/local"): string {
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "";
  const pairedPreview =
    /^https?:\/\/(localhost|127\.0\.0\.1):(3100|3200)\/?$/.test(site);
  const base =
    process.env.NEXT_PUBLIC_LOCAL_APP_URL ||
    (pairedPreview ? "http://localhost:3100" : "http://localhost:3000");
  return new URL(path, base).toString();
}
