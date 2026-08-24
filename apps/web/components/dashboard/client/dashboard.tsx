"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { FolderPlus, Plus } from "lucide-react";

import { apiFetch } from "@/lib/api";
import {
  CaseQueue,
  NotificationsFeed,
} from "@/components/dashboard/shared/widgets";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface CaseTypeRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  slaHours: number;
}

export function ClientDashboard() {
  const { data: types } = useQuery<CaseTypeRow[]>({
    queryKey: ["case-types"],
    queryFn: () => apiFetch<CaseTypeRow[]>("/case-types"),
  });
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Start something new</CardTitle>
          <CardDescription>
            Submit a registration or request — staff pick it up from there.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {(types ?? []).map((t) => (
            <Button
              key={t.id}
              variant="secondary"
              size="sm"
              render={<Link href={`/client/cases?new=1&type=${t.id}`} />}
            >
              <FolderPlus />
              {t.name}
            </Button>
          ))}
          {types?.length === 0 && (
            <p className="text-sm text-muted-foreground">No request types available yet.</p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <CaseQueue
          title="My cases"
          description="Everything you have submitted"
          params={{ mine: "true" }}
        />
        <NotificationsFeed limit={5} />
      </div>
    </div>
  );
}

export function ClientHeaderActions() {
  return (
    <Button size="sm" render={<Link href="/client/cases?new=1" />}>
      <Plus />
      New case
    </Button>
  );
}
