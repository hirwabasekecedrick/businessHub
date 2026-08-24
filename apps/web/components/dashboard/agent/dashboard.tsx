"use client";

import {
  ApprovalsInbox,
  CaseQueue,
  MyTasks,
  ReportStats,
} from "@/components/dashboard/shared/widgets";

export function AgentDashboard() {
  return (
    <div className="space-y-6">
      <ReportStats />
      <div className="grid gap-6 lg:grid-cols-2">
        <CaseQueue
          title="Organization queue"
          description="All active cases, breached pinned first"
          limit={7}
        />
        <div className="space-y-6">
          <MyTasks />
          <ApprovalsInbox />
        </div>
      </div>
    </div>
  );
}

export function AgentHeaderActions() {
  return null;
}
