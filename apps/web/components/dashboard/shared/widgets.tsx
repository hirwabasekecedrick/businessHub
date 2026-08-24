"use client";

import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { toast } from "sonner";
import {
  AlarmClock,
  BellRing,
  CheckCircle2,
  FolderKanban,
  ReceiptText,
} from "lucide-react";

import { ApiError, apiFetch } from "@/lib/api";
import type { Me } from "@/lib/auth-types";
import { useAuth } from "@/components/providers/auth-provider";
import { Can, NoAccess } from "@/components/rbac/can";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

export function fmtDate(d?: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function fmtDateTime(d?: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  SUBMITTED: "bg-sky-100 text-[#091540] dark:bg-primary/20 dark:text-primary-foreground",
  QUALIFIED: "bg-secondary text-secondary-foreground",
  ASSIGNED: "bg-accent text-accent-foreground",
  IN_PROGRESS: "bg-primary/10 text-primary",
  ON_HOLD: "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-300",
  IN_REVIEW: "bg-[#7692FF]/15 text-[#1B2CC1] dark:text-[#ABD2FA]",
  APPROVED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300",
  REJECTED: "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-300",
  ESCALATED: "bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-300",
  RESOLVED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300",
  CLOSED: "bg-muted text-muted-foreground",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className="border-transparent px-2 font-medium">
      <span className={`rounded-full px-2 py-0.5 ${STATUS_TONE[status] ?? "bg-muted"}`}>
        {status.replaceAll("_", " ").toLowerCase()}
      </span>
    </Badge>
  );
}

/* ------------------------------ stat card ------------------------------ */

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 pb-0">
        <CardDescription>{label}</CardDescription>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent className="pb-4 pt-1">
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/* ------------------------------ case queue ----------------------------- */

export interface CaseRow {
  id: string;
  reference: string;
  subject: string;
  status: string;
  priority: string;
  slaDueAt: string | null;
  breached: boolean;
  atRisk: boolean;
  caseTypeCode: string;
  clientOrgName: string | null;
}

export interface CasesResponse {
  meta: { total: number; page: number; pageSize: number };
  items: CaseRow[];
}

export function useCases(params: Record<string, string>, enabled = true) {
  const qs = new URLSearchParams(params).toString();
  return useQuery<CasesResponse>({
    queryKey: ["cases", params],
    queryFn: () => apiFetch<CasesResponse>(`/cases?${qs}`),
    enabled,
  });
}

export function CaseQueue({
  title = "Case queue",
  description,
  params = {},
  limit = 6,
}: {
  title?: string;
  description?: string;
  params?: Record<string, string>;
  limit?: number;
}) {
  const { data, isPending, error } = useCases({ pageSize: String(limit), ...params });
  if (error instanceof ApiError && error.status === 403) return <NoAccess />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-2">
        {isPending && <Skeleton className="h-24 w-full" />}
        {data?.items.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No cases here yet.
          </p>
        )}
        {data?.items.slice(0, limit).map((c) => (
          <Link
            key={c.id}
            href={`/cases/${c.id}`}
            className="flex items-center justify-between gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/60"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{c.subject}</p>
              <p className="text-xs text-muted-foreground">
                {c.reference} · {c.caseTypeCode}
                {c.clientOrgName ? ` · ${c.clientOrgName}` : ""}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {c.breached ? (
                <Badge variant="destructive">SLA breached</Badge>
              ) : c.atRisk ? (
                <Badge variant="outline" className="border-amber-400/60 bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                  at risk
                </Badge>
              ) : null}
              <StatusBadge status={c.status} />
            </div>
          </Link>
        ))}
        {data && data.meta.total > data.items.length && (
          <Button variant="ghost" size="sm" className="w-full" render={<Link href="/cases" />}>
            View all ({data.meta.total})
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------ my tasks ------------------------------- */

interface TaskRow {
  id: string;
  title: string;
  type: string;
  status: string;
  dueAt: string | null;
  assigneeUserId: string | null;
  case?: { reference: string; subject: string } | null;
}

export function MyTasks({ limit = 6 }: { limit?: number }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const { data, isPending } = useQuery<TaskRow[]>({
    queryKey: ["tasks", "mine"],
    queryFn: () => apiFetch<TaskRow[]>("/tasks?assignee=me"),
  });
  const complete = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/tasks/${id}/complete`, { method: "POST", body: {} }),
    onSuccess: () => {
      toast.success("Task completed");
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : "Failed to complete task"),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>My tasks</CardTitle>
        <CardDescription>Your open work queue</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isPending && <Skeleton className="h-24 w-full" />}
        {data?.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Nothing assigned to you. Enjoy the calm.
          </p>
        )}
        {data?.slice(0, limit).map((t) => (
          <div
            key={t.id}
            className="flex items-center justify-between gap-3 rounded-lg border p-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{t.title}</p>
              <p className="text-xs text-muted-foreground">
                {t.case?.reference ? `${t.case.reference} · ` : ""}
                due {fmtDate(t.dueAt)}
                {!t.assigneeUserId && " · unassigned (role queue)"}
              </p>
            </div>
            <Can perm={me && t.assigneeUserId === me.id ? "task.complete" : "__never__"}>
              <Button
                size="sm"
                variant="outline"
                disabled={complete.isPending}
                onClick={() => complete.mutate(t.id)}
              >
                <CheckCircle2 />
                Complete
              </Button>
            </Can>
            {!t.assigneeUserId && (
              <Badge variant="secondary" className="shrink-0">
                claim in Tasks
              </Badge>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/* ---------------------------- approvals inbox --------------------------- */

interface ApprovalRow {
  id: string;
  level: number;
  state: string;
  comment: string | null;
  delegatedToId: string | null;
  requiredRole?: { code: string; name: string } | null;
  task?: { case?: { reference: string; subject: string } | null } | null;
}

export function ApprovalsInbox({ limit = 5 }: { limit?: number }) {
  const qc = useQueryClient();
  const [rejecting, setRejecting] = React.useState<string | null>(null);
  const [comment, setComment] = React.useState("");
  const { data, isPending } = useQuery<ApprovalRow[]>({
    queryKey: ["approvals"],
    queryFn: () => apiFetch<ApprovalRow[]>("/approvals"),
  });
  const decide = useMutation({
    mutationFn: ({
      id,
      decision,
      comment,
    }: {
      id: string;
      decision: "APPROVED" | "REJECTED";
      comment?: string;
    }) =>
      apiFetch(`/approvals/${id}/decide`, {
        method: "POST",
        body: { decision, comment },
      }),
    onSuccess: (_res, vars) => {
      toast.success(vars.decision === "APPROVED" ? "Approved" : "Rejected");
      setRejecting(null);
      setComment("");
      void qc.invalidateQueries({ queryKey: ["approvals"] });
      void qc.invalidateQueries({ queryKey: ["cases"] });
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : "Decision failed"),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pending approvals</CardTitle>
        <CardDescription>Decisions waiting at your level</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isPending && <Skeleton className="h-20 w-full" />}
        {data?.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No pending approvals.
          </p>
        )}
        {data?.slice(0, limit).map((a) => (
          <div key={a.id} className="rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-medium">
                {a.task?.case?.reference ?? "case"} · level {a.level}
              </p>
              {a.delegatedToId && <Badge variant="secondary">delegated</Badge>}
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {a.task?.case?.subject ?? a.requiredRole?.name}
            </p>
            {rejecting === a.id ? (
              <div className="mt-2 space-y-2">
                <input
                  className="w-full rounded-md border bg-transparent px-2 py-1 text-sm outline-none focus-visible:ring-2"
                  placeholder="Reason (required)"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  autoFocus
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={!comment.trim() || decide.isPending}
                    onClick={() =>
                      decide.mutate({ id: a.id, decision: "REJECTED", comment })
                    }
                  >
                    Confirm reject
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRejecting(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: a.id, decision: "APPROVED" })}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setRejecting(a.id)}
                >
                  Reject…
                </Button>
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/* ---------------------------- finance summary --------------------------- */

interface DashboardReport {
  openCasesByStatus: Record<string, number>;
  slaAtRisk: { breached: number };
  myTasksDueToday: Array<{ id: string; title: string; dueAt: string | null }>;
  finance: { outstandingTotal: string; currency: string };
}

export function useDashboardReport(enabled = true) {
  return useQuery<DashboardReport>({
    queryKey: ["reports", "dashboard"],
    queryFn: () => apiFetch<DashboardReport>("/reports/dashboard"),
    enabled,
  });
}

export function ReportStats() {
  const { data, isPending } = useDashboardReport();
  const openTotal = data
    ? Object.values(data.openCasesByStatus).reduce((a, b) => a + b, 0)
    : 0;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        label="Open cases"
        value={isPending ? "…" : openTotal}
        icon={FolderKanban}
      />
      <StatCard
        label="SLA breached"
        value={data?.slaAtRisk.breached ?? "…"}
        hint="past deadline & unresolved"
        icon={AlarmClock}
      />
      <StatCard
        label="Tasks due today"
        value={data?.myTasksDueToday.length ?? "…"}
        icon={CheckCircle2}
      />
      <StatCard
        label="Outstanding"
        value={
          data
            ? `${Number(data.finance.outstandingTotal).toLocaleString()} ${data.finance.currency}`
            : "…"
        }
        icon={ReceiptText}
      />
    </div>
  );
}

/* --------------------------- notifications feed ------------------------- */

interface NotificationRow {
  id: string;
  subject: string | null;
  body: string | null;
  templateCode: string;
  readAt: string | null;
  createdAt: string;
}

export function useNotifications(unread = false) {
  return useQuery<NotificationRow[]>({
    queryKey: ["notifications", unread],
    queryFn: () =>
      apiFetch<NotificationRow[]>(`/notifications${unread ? "?unread=true" : ""}`),
    refetchInterval: 30_000,
  });
}

export function NotificationsFeed({ limit = 8 }: { limit?: number }) {
  const qc = useQueryClient();
  const { data, isPending } = useNotifications();
  const markRead = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/notifications/${id}/read`, { method: "POST", body: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellRing className="size-4" /> Notifications
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {isPending && <Skeleton className="h-16 w-full" />}
        {data?.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No notifications yet.
          </p>
        )}
        {data?.slice(0, limit).map((n) => (
          <div key={n.id} className="flex items-start justify-between gap-3 rounded-lg border p-3">
            <div className="min-w-0">
              <p className={`truncate text-sm ${n.readAt ? "text-muted-foreground" : "font-medium"}`}>
                {n.subject ?? n.templateCode}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {n.body ?? ""} · {fmtDateTime(n.createdAt)}
              </p>
            </div>
            {!n.readAt && (
              <Button size="xs" variant="ghost" onClick={() => markRead.mutate(n.id)}>
                Mark read
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/* ------------------------------ profile card ---------------------------- */

export function ProfileCard({ me }: { me: Me }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="font-medium">
          {me.firstName} {me.lastName}
        </p>
        <p className="text-muted-foreground">{me.email}</p>
        <Separator />
        <p className="text-xs text-muted-foreground">
          Two-factor authentication:{" "}
          {me.mfaEnabled ? "enabled" : "not enabled"}
        </p>
      </CardContent>
    </Card>
  );
}
