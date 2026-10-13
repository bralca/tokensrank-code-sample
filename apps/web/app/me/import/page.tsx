import { redirect } from "next/navigation";

// Keep old bookmarks useful while routing all browser sharing through a receipt.
export default function UsageImportPage() {
  redirect("/join");
}
