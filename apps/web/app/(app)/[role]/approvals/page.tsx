"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ApiError, apiFetch } from "@/lib/api";
import { NoAccess } from "@/components/rbac/can";
import { useAuth } from "@/components/providers/auth-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface ApprovalRow {
  id: string;
  level: number;
  state: string;
  comment: string | null;
  delegatedToId: string | null;
  requiredRole?: { code: string; name: string } | null;
  task?: { case?: { reference: string; subject: string } | null; title?: string } | null;
}

export default function ApprovalsPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [comment, setComment] = useState("");

  const { data, isPending, error } = useQuery<ApprovalRow[]>({
    queryKey: ["approvals"],
    queryFn: () => apiFetch<ApprovalRow[]>("/approvals"),
  });

  const decide = useMutation({
    mutationFn: ({ path, body }: { path: string; body: Record<string, unknown> }) =>
      apiFetch(`/approvals/${path}`, { method: "POST", body }),
    onSuccess: () => {
      toast.success("Decision recorded");
      setRejecting(null);
      setComment("");
      void qc.invalidateQueries({ queryKey: ["approvals"] });
      void qc.invalidateQueries({ queryKey: ["cases"] });
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : "Decision failed"),
  });

  if (error || !can("approval.read")) return <NoAccess />;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pending approvals</CardTitle>
        <CardDescription>
          Items at your approval level or delegated to you
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isPending && <Skeleton className="h-40 w-full" />}
        {data?.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Nothing waiting on you.
          </p>
        )}
        {(data ?? []).map((a) => (
          <div key={a.id} className="rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">
                {a.task?.case?.reference ?? "case"}
                {a.task?.title ? ` — ${a.task.title}` : ""}
              </p>
              <div className="flex gap-2">
                <Badge variant="outline">level {a.level}</Badge>
                <Badge variant="secondary">{a.state.toLowerCase()}</Badge>
              </div>
            </div>
            {a.task?.case?.subject && (
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {a.task.case.subject}
              </p>
            )}

            {rejecting === a.id ? (
              <div className="mt-3 space-y-2">
                <input
                  className="w-full rounded-md border bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:ring-2"
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
                      decide.mutate({
                        path: `${a.id}/decide`,
                        body: { decision: "REJECTED", comment },
                      })
                    }
                  >
                    Confirm rejection
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRejecting(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={decide.isPending}
                  onClick={() =>
                    decide.mutate({
                      path: `${a.id}/decide`,
                      body: { decision: "APPROVED" },
                    })
                  }
                >
                  Approve
                </Button>
                <Button size="sm" variant="outline" onClick={() => setRejecting(a.id)}>
                  Reject…
                </Button>
                {can("approval.override") && a.state === "PENDING" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      decide.mutate({
                        path: `${a.id}/override`,
                        body: { decision: "APPROVED", comment: "Override" },
                      })
                    }
                  >
                    Override
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
