"use client";

import { use } from "react";

import { chromeFor, isRoleSlug } from "@/components/dashboard/registry";

export default function RoleHomePage({ params }: PageProps<"/[role]">) {
  const { role } = use(params);
  if (!isRoleSlug(role)) return null;
  const Dashboard = chromeFor(role).Dashboard;
  return <Dashboard />;
}
