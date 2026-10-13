"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight, Github, ShieldCheck } from "lucide-react";
import { Brand, SOURCE_URL } from "./Brand";

export function DashboardNav({
  local = false,
  account = false,
}: {
  local?: boolean;
  account?: boolean;
}) {
  const pathname = usePathname();
  return (
    <header className="dash-header">
      <div className="dash-nav">
        <Brand href={local ? "/local/profile" : "/"} />
        <a className="dash-edition" href={SOURCE_URL} target="_blank" rel="noreferrer">Source code</a>
        <nav aria-label="Main navigation" className="dash-nav-links">
          {local ? (
            <>
              <Link
                aria-current={
                  pathname === "/local/profile" ? "page" : undefined
                }
                href="/local/profile"
              >
                Your usage
              </Link>
              <Link
                aria-current={
                  pathname === "/local/publish" ? "page" : undefined
                }
                href="/local/publish"
              >
                Publishing
              </Link>
              <Link
                aria-current={
                  pathname === "/local/settings" ? "page" : undefined
                }
                href="/local/settings"
              >
                Settings
              </Link>
            </>
          ) : (
            <>
              <Link
                aria-current={pathname === "/" ? "page" : undefined}
                href="/"
              >
                Leaderboard
              </Link>
              <Link aria-current={pathname.startsWith('/models') ? "page" : undefined} href="/models">Models</Link>
              <Link aria-current={pathname.startsWith('/tools') ? "page" : undefined} href="/tools">Tools</Link>
            </>
          )}
        </nav>
        <div className="dash-nav-actions">
          <a className="dash-source-link" href={SOURCE_URL} target="_blank" rel="noreferrer" aria-label="TokensRank on GitHub"><Github size={19} /></a>
          {local ? (
            <span className="dash-private">
              <ShieldCheck size={14} /> On your device
            </span>
          ) : (
            <Link
              className="dash-button primary"
              href={account ? "/me" : "/join"}
            >
              <span className="dash-join-label">
                {account ? "Your account" : "Share your usage"}
              </span>
              <span className="dash-join-label-short">
                {account ? "Account" : "Share usage"}
              </span>{" "}
              <ArrowUpRight size={15} />
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
