"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { UserPlus } from "lucide-react";

import { apiFetch } from "@/lib/api";
import {
  ApprovalsInbox,
  CaseQueue,
  ReportStats,
} from "@/components/dashboard/shared/widgets";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface MemberRow {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: string;
  roleCode: string;
}

export function AdminDashboard() {
  const { data: members } = useQuery<MemberRow[]>({
    queryKey: ["users"],
    queryFn: () => apiFetch<MemberRow[]>("/users"),
  });

  return (
    <div className="space-y-6">
      <ReportStats />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader className="pb-3">
            <CardTitle>People</CardTitle>
            <CardDescription>
              {members ? `${members.length} members in this organization` : "Loading…"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {(members ?? []).slice(0, 5).map((m) => (
              <div key={m.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{m.firstName ?? m.email}</span>
                <Badge variant="secondary">{m.roleCode}</Badge>
              </div>
            ))}
            <Button size="sm" variant="secondary" className="mt-2 w-full" render={<Link href="/admin/users" />}>
              <UserPlus />
              Manage users & invites
            </Button>
          </CardContent>
        </Card>
        <div className="space-y-6 lg:col-span-2">
          <ApprovalsInbox limit={4} />
          <CaseQueue title="Queue health" limit={4} />
        </div>
      </div>
    </div>
  );
}

export function AdminHeaderActions() {
  return (
    <Button size="sm" variant="secondary" render={<Link href="/admin/users?invite=1" />}>
      <UserPlus />
      Invite
    </Button>
  );
}
