import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import AdminClient from "./client";
export const dynamic = "force-dynamic";
export default async function Page() {
  if (!(await isAdmin())) redirect("/login");
  return <AdminClient />;
}
