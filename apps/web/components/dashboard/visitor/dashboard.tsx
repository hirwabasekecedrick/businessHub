"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { FolderPlus, Plus, Sparkles } from "lucide-react";

import { apiFetch } from "@/lib/api";
import {
  CaseQueue,
  NotificationsFeed,
  ProfileCard,
} from "@/components/dashboard/shared/widgets";
import { useAuth } from "@/components/providers/auth-provider";
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

/* US-1.1: a visitor signs up precisely to submit a request without calling
   anyone — the dashboard leads with that action and tracks what they sent. */
export function VisitorDashboard() {
  const { me } = useAuth();
  const basePath = "visitor";
  const { data: types } = useQuery<CaseTypeRow[]>({
    queryKey: ["case-types"],
    queryFn: () => apiFetch<CaseTypeRow[]>("/case-types"),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            Welcome to BusinessHub
          </CardTitle>
          <CardDescription>
            Submit a request below — no organisation needed. You will get a
            tracked reference and updates right here.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {(types ?? []).map((t) => (
            <Button
              key={t.id}
              variant="secondary"
              size="sm"
              render={<Link href={`/${basePath}/cases?new=1&type=${t.id}`} />}
            >
              <FolderPlus />
              {t.name}
            </Button>
          ))}
          {types?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No request types available yet.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <CaseQueue
            title="My requests"
            description="Everything you have submitted"
            params={{ mine: "true" }}
          />
        </div>
        <div className="space-y-6">
          {me && <ProfileCard me={me} />}
          <NotificationsFeed limit={5} />
        </div>
      </div>
    </div>
  );
}

export function VisitorHeaderActions() {
  return (
    <Button size="sm" render={<Link href="/visitor/cases?new=1" />}>
      <Plus />
      New request
    </Button>
  );
}
