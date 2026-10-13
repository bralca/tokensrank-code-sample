import type { Metadata } from "next";

import "../styles/globals.css";
import "../styles/dashboard.css";
import "../styles/community.css";
import "../styles/explorer.css";
import "../styles/recap.css";
import { SearchShortcut } from "@/components/SearchShortcut";
import { getSiteUrl } from "../lib/sitemap";

export const metadata: Metadata = {
  metadataBase: new URL(getSiteUrl()),
  title: "TokensRank",
  description: "Track AI usage locally and share your stats on the community leaderboard.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link
          rel="preload"
          as="style"
          href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=Geist+Mono:wght@400;500;600&display=swap"
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=Geist+Mono:wght@400;500;600&display=swap"
        />
      </head>
      <body className="bg-tr-bg font-sans text-tr-text">
        <SearchShortcut />
        {children}
      </body>
    </html>
  );
}
