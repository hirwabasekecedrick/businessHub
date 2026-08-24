"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Lock } from "lucide-react";

import { ApiError, apiFetch } from "@/lib/api";
import { NoAccess } from "@/components/rbac/can";
import { useAuth } from "@/components/providers/auth-provider";
import { fmtDateTime } from "@/components/dashboard/shared/widgets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface TaskRow {
  id: string;
  title: string;
  type: string;
  status: string;
  dueAt: string | null;
  assigneeUserId: string | null;
  case?: { reference: string; subject: string } | null;
}

export default function TasksPage() {
  const qc = useQueryClient();
  const { me, can } = useAuth();

  const { data, isPending, error } = useQuery<TaskRow[]>({
    queryKey: ["tasks", "mine"],
    queryFn: () => apiFetch<TaskRow[]>("/tasks?assignee=me"),
  });

  const claim = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/tasks/${id}/claim`, { method: "POST", body: {} }),
    onSuccess: () => {
      toast.success("Task claimed");
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Claim failed"),
  });

  const complete = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/tasks/${id}/complete`, { method: "POST", body: {} }),
    onSuccess: () => {
      toast.success("Task completed");
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      void qc.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Complete failed"),
  });

  if (error) return <NoAccess />;
  if (!can("task.read")) return <NoAccess />;

  return (
    <Card>
      <CardHeader>
        <CardTitle>My tasks</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {isPending && <Skeleton className="h-40 w-full" />}
        {data?.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Your queue is empty.
          </p>
        )}
        {(data ?? []).map((t) => {
          const mine = t.assigneeUserId === me?.id;
          return (
            <div key={t.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{t.title}</p>
                <p className="text-xs text-muted-foreground">
                  {t.case?.reference ? `${t.case.reference} · ` : ""}
                  {t.status.replaceAll("_", " ").toLowerCase()}
                  {t.dueAt ? ` · due ${fmtDateTime(t.dueAt)}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {!t.assigneeUserId && (
                  <>
                    <Badge variant="secondary">role queue</Badge>
                    {can("task.complete") && (
                      <Button size="sm" variant="outline" onClick={() => claim.mutate(t.id)}>
                        <Lock />
                        Claim
                      </Button>
                    )}
                  </>
                )}
                {mine && can("task.complete") && (
                  <Button size="sm" onClick={() => complete.mutate(t.id)}>
                    <Check />
                    Complete
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
