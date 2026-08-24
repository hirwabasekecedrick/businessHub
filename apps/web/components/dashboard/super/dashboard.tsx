"use client";

import { useQuery } from "@tanstack/react-query";
import { Plug, UserPlus } from "lucide-react";

import { apiFetch } from "@/lib/api";
import {
  ApprovalsInbox,
  CaseQueue,
  ReportStats,
} from "@/components/dashboard/shared/widgets";
import { AdminHeaderActions } from "@/components/dashboard/admin/dashboard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export const SuperHeaderActions = AdminHeaderActions;

interface IntegrationRow {
  code: string;
  displayName: string;
  isActive: boolean;
}

function IntegrationsCard() {
  const { data, isPending } = useQuery<IntegrationRow[]>({
    queryKey: ["integrations"],
    queryFn: () => apiFetch<IntegrationRow[]>("/integrations"),
  });
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <Plug className="size-4 text-primary" />
          Integrations
        </CardTitle>
        <CardDescription>Provider connections for this hub</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isPending && <Skeleton className="h-20 w-full" />}
        {(data ?? []).map((i) => (
          <div key={i.code} className="flex items-center justify-between gap-2 text-sm">
            <span>{i.displayName}</span>
            <Badge variant={i.isActive ? "secondary" : "outline"}>
              {i.isActive ? "active" : "off"}
            </Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function SuperDashboard() {
  return (
    <div className="space-y-6">
      <ReportStats />
      <div className="grid gap-6 lg:grid-cols-3">
        <IntegrationsCard />
        <div className="space-y-6 lg:col-span-2">
          <ApprovalsInbox limit={4} />
          <CaseQueue title="Queue health (all)" limit={5} />
        </div>
      </div>
    </div>
  );
}
