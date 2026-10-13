import type { ReactNode } from "react";
import { Brand, SOURCE_URL } from "../components/dashboard/Brand";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="dashboard dash-auth">
      <Brand />
      <div className="dash-auth-card">{children}</div>
      <a className="dash-muted" href={SOURCE_URL} target="_blank" rel="noreferrer">Source on GitHub ↗</a>
    </main>
  );
}
