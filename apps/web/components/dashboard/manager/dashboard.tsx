"use client";

import { ReceiptText } from "lucide-react";
import Link from "next/link";

import {
  ApprovalsInbox,
  CaseQueue,
  MyTasks,
  ReportStats,
} from "@/components/dashboard/shared/widgets";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function ManagerDashboard() {
  return (
    <div className="space-y-6">
      <ReportStats />
      <div className="grid gap-6 lg:grid-cols-2">
        <ApprovalsInbox limit={7} />
        <CaseQueue
          title="Case queue"
          description="Breached cases are pinned to the top"
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <MyTasks />
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <ReceiptText className="size-4 text-primary" />
              Finance desk
            </CardTitle>
            <CardDescription>Issue invoices and record payments</CardDescription>
          </CardHeader>
          <CardContent>
            <Button size="sm" variant="secondary" render={<Link href="/manager/invoices" />}>
              Open finance
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function ManagerHeaderActions() {
  return null;
}
