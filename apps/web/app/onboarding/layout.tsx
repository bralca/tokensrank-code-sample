import { ProjectFooter } from "../components/dashboard/Brand";
import { PublicHeader } from "../components/dashboard/PublicHeader";

export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="dashboard">
      <PublicHeader />
      <div className="dash-content dash-account-content dash-onboarding-content">{children}<ProjectFooter /></div>
    </div>
  );
}
