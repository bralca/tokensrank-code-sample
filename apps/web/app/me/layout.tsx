import { ProjectFooter } from "../components/dashboard/Brand";
import { DashboardNav } from "../components/dashboard/DashboardNav";

export default function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="dashboard">
      <DashboardNav account />
      <div className="dash-content dash-account-content">{children}<ProjectFooter /></div>
    </div>
  );
}
