"use client";

import { use, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, SendHorizonal } from "lucide-react";

import { ApiError, apiFetch } from "@/lib/api";
import { NoAccess } from "@/components/rbac/can";
import { StatusBadge, fmtDateTime } from "@/components/dashboard/shared/widgets";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface CaseDetail {
  id: string;
  reference: string;
  subject: string;
  description: string | null;
  status: string;
  priority: string;
  createdAt: string;
  submittedAt: string | null;
  slaDueAt: string | null;
  caseType: { code: string; name: string };
  ownerUserId: string | null;
}

interface HistoryRow {
  id: string;
  action?: string;
  toStatus?: string;
  fromStatus?: string;
  reason?: string | null;
  createdAt: string;
  actorUserId?: string | null;
}

interface CommentRow {
  id: string;
  body: string;
  isInternal: boolean;
  authorId: string;
  createdAt: string;
}

interface MemberRow {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

export default function CaseDetailPage({
  params,
}: PageProps<"/[role]/cases/[id]">) {
  const { role, id } = use(params);
  const qc = useQueryClient();
  const [comment, setComment] = useState("");
  const [holdReason, setHoldReason] = useState("");
  const [assignee, setAssignee] = useState("");

  const { data: c, isPending, error } = useQuery<CaseDetail>({
    queryKey: ["case", id],
    queryFn: () => apiFetch<CaseDetail>(`/cases/${id}`),
  });
  const { data: history } = useQuery<HistoryRow[]>({
    queryKey: ["case", id, "history"],
    queryFn: () => apiFetch<HistoryRow[]>(`/cases/${id}/history`),
    enabled: !!c,
  });
  const { data: comments } = useQuery<CommentRow[]>({
    queryKey: ["case", id, "comments"],
    queryFn: () => apiFetch<CommentRow[]>(`/cases/${id}/comments`),
    enabled: !!c,
  });
  const { data: members } = useQuery<MemberRow[]>({
    queryKey: ["users"],
    queryFn: () => apiFetch<MemberRow[]>("/users"),
    enabled: !!c && c.status === "QUALIFIED",
  });

  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      apiFetch(`/cases/${id}/${path}`, { method: "POST", body: body ?? {} }),
    onSuccess: () => {
      toast.success("Done");
      void qc.invalidateQueries({ queryKey: ["case", id] });
      void qc.invalidateQueries({ queryKey: ["cases"] });
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : "Action failed"),
  });

  const addComment = useMutation({
    mutationFn: () =>
      apiFetch(`/cases/${id}/comments`, {
        method: "POST",
        body: { body: comment },
      }),
    onSuccess: () => {
      setComment("");
      void qc.invalidateQueries({ queryKey: ["case", id, "comments"] });
    },
    onError: () => toast.error("Could not post comment"),
  });

  if (error instanceof ApiError && error.status === 403) return <NoAccess />;
  if (isPending) return <Skeleton className="h-72 w-full" />;
  if (!c) return null;

  const canTransition = true; // backend enforces; buttons gated by status only

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon-xs"
                render={<Link href={`/${role}/cases`} />}
              >
                <ArrowLeft />
              </Button>
              <div className="min-w-0">
                <CardTitle className="truncate">{c.subject}</CardTitle>
                <CardDescription className="font-mono text-xs">
                  {c.reference} · {c.caseType.name}
                </CardDescription>
              </div>
              <div className="ml-auto shrink-0">
                <StatusBadge status={c.status} />
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {c.description && <p>{c.description}</p>}
            <Separator />
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">Created</dt>
                <dd>{fmtDateTime(c.createdAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Submitted</dt>
                <dd>{fmtDateTime(c.submittedAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">SLA due</dt>
                <dd>{fmtDateTime(c.slaDueAt)}</dd>
              </div>
            </dl>

            {/* lifecycle actions — visibility by current state; the API is
                the final arbiter and answers with a generic denial */}
            {canTransition && (
              <div className="flex flex-wrap gap-2 pt-2">
                {c.status === "DRAFT" && (
                  <Button size="sm" onClick={() => act.mutate({ path: "submit" })}>
                    <SendHorizonal />
                    Submit for review
                  </Button>
                )}
                {c.status === "SUBMITTED" && (
                  <Button size="sm" onClick={() => act.mutate({ path: "qualify", body: {} })}>
                    Qualify
                  </Button>
                )}
                {c.status === "QUALIFIED" && (
                  <div className="flex w-full max-w-md gap-2">
                    <Select
                      value={assignee}
                      onValueChange={(v) => setAssignee(v ?? "")}
                      items={Object.fromEntries((members ?? []).map((m) => [m.id, m.firstName ?? m.email]))}
                    >
                      <SelectTrigger className="flex-1" size="sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(members ?? []).map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.firstName ?? m.email}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      disabled={!assignee || act.isPending}
                      onClick={() =>
                        act.mutate({ path: "assign", body: { ownerUserId: assignee } })
                      }
                    >
                      Assign
                    </Button>
                  </div>
                )}
                {c.status === "IN_PROGRESS" && (
                  <div className="flex w-full max-w-md gap-2">
                    <Textarea
                      rows={1}
                      placeholder="Hold reason"
                      value={holdReason}
                      onChange={(e) => setHoldReason(e.target.value)}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!holdReason.trim() || act.isPending}
                      onClick={() => {
                        act.mutate({ path: "hold", body: { reason: holdReason } });
                        setHoldReason("");
                      }}
                    >
                      Put on hold
                    </Button>
                  </div>
                )}
                {c.status === "ON_HOLD" && (
                  <Button size="sm" onClick={() => act.mutate({ path: "resume" })}>
                    Resume work
                  </Button>
                )}
                {c.status === "APPROVED" && (
                  <Button size="sm" variant="outline" onClick={() => act.mutate({ path: "close" })}>
                    Close case
                  </Button>
                )}
                {c.status === "CLOSED" && (
                  <Button size="sm" variant="outline" onClick={() => act.mutate({ path: "reopen", body: { reason: "Reopened from portal" } })}>
                    Reopen
                  </Button>
                )}
                {c.status === "IN_REVIEW" && (
                  <p className="text-xs text-muted-foreground">
                    Awaiting approval decisions — see the Approvals page.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Activity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(history ?? []).map((h) => (
              <div key={h.id} className="flex items-start justify-between gap-3 border-l-2 pl-3 text-sm"
                style={{ borderColor: "var(--border)" }}>
                <div>
                  <p className="font-medium">
                    {h.action ??
                      (h.toStatus
                        ? `${h.fromStatus ?? ""} → ${h.toStatus}`.trim()
                        : "Update")}
                  </p>
                  {h.reason && (
                    <p className="text-xs text-muted-foreground">{h.reason}</p>
                  )}
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {fmtDateTime(h.createdAt)}
                </span>
              </div>
            ))}
            {(history ?? []).length === 0 && (
              <p className="py-4 text-center text-sm text-muted-foreground">No events yet.</p>
            )}

            <Separator />

            <div className="space-y-2">
              {(comments ?? []).map((cm) => (
                <div key={cm.id} className="rounded-lg bg-muted/60 p-3 text-sm">
                  <p>{cm.body}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {fmtDateTime(cm.createdAt)}
                    {cm.isInternal ? " · internal" : ""}
                  </p>
                </div>
              ))}
              <Textarea
                rows={2}
                placeholder="Add a comment…"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
              <Button
                size="sm"
                disabled={!comment.trim() || addComment.isPending}
                onClick={() => addComment.mutate()}
              >
                Comment
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        <Card className="self-start">
          <CardHeader>
            <CardTitle className="text-base">Lifecycle</CardTitle>
            <CardDescription className="text-xs">
              DRAFT → SUBMITTED → QUALIFIED → ASSIGNED → IN PROGRESS → REVIEW → CLOSED
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="space-y-1.5 text-xs">
              {["DRAFT", "SUBMITTED", "QUALIFIED", "ASSIGNED", "IN_PROGRESS", "ON_HOLD", "IN_REVIEW", "APPROVED"].map(
                (s) => (
                  <li key={s} className="flex items-center gap-2">
                    <span
                      className={
                        c.status === s
                          ? "size-2 rounded-full bg-primary"
                          : "size-2 rounded-full bg-muted-foreground/30"
                      }
                    />
                    <span className={c.status === s ? "font-semibold" : "text-muted-foreground"}>
                      {s.replaceAll("_", " ")}
                    </span>
                  </li>
                ),
              )}
            </ol>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
