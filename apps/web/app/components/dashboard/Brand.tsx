import Link from "next/link";

export const SOURCE_URL = process.env.NEXT_PUBLIC_SOURCE_URL ?? "https://github.com/bralca/tokensrank-code-sample";

export function Brand({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="dash-brand" aria-label="TokensRank home">
      <span className="dash-logo" aria-hidden="true">#</span>
      <span>tokensrank<span className="dash-brand-dot">.</span></span>
    </Link>
  );
}

export function ProjectFooter({ local = false }: { local?: boolean }) {
  return (
    <footer className="dash-footer">
      <span>{local ? "Raw usage stays on this device." : "Published usage summaries."}</span>
      <a href={SOURCE_URL} target="_blank" rel="noreferrer">Source on GitHub ↗</a>
    </footer>
  );
}
