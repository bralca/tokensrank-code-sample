'use client';
import Link from 'next/link';
export default function ExplorerError({reset}:{reset:()=>void}) {
  return <main className="dashboard"><div className="dash-content"><section className="dash-empty-board"><h1>Usage rankings are unavailable</h1><p>We couldn’t load the published totals. Please try again.</p><button className="dash-button primary" onClick={reset}>Try again</button><Link className="dash-button" href="/">Back to leaderboard</Link></section></div></main>;
}
