import { cookies } from "next/headers";
import { DashboardNav } from "./DashboardNav";

export async function PublicHeader() {
  const cookieStore = await cookies();
  // Navigation hint only; protected pages still verify the session with the API.
  return <DashboardNav account={cookieStore.has("tr_at")} />;
}
