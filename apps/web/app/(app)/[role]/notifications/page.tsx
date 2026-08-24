"use client";

import { NotificationsFeed } from "@/components/dashboard/shared/widgets";

export default function NotificationsPage() {
  return <NotificationsFeed limit={50} />;
}
