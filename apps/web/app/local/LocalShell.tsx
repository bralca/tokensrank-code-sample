import type { ReactNode } from "react";
import { ProjectFooter } from "../components/dashboard/Brand";
import { DashboardNav } from "../components/dashboard/DashboardNav";

export function LocalShell({
  children,
}: {
  children: ReactNode;
  showActions?: boolean;
}) {
  return (
    <main className="dashboard">
      <DashboardNav local />
      {children}
      <div className="dash-content dash-shell-footer"><ProjectFooter local /></div>
    </main>
  );
}
