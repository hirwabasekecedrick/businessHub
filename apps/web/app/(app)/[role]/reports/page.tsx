"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileDown } from "lucide-react";

import { ApiError, apiFetch } from "@/lib/api";
import { NoAccess, Can } from "@/components/rbac/can";
import {
  ReportStats,
} from "@/components/dashboard/shared/widgets";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function ReportsPage() {
  const [month, setMonth] = useState(() =>
    new Date().toISOString().slice(0, 7),
  );
  const [job, setJob] = useState<{ id: string; status?: string } | null>(null);

  const exportReport = useMutation({
    mutationFn: () =>
      apiFetch<{ id: string }>("/reports/export", {
        method: "POST",
        body: { month },
      }),
    onSuccess: (j) => {
      setJob(j);
      toast.success("Export queued");
      // poll once after a moment for the CSV result
      setTimeout(() => {
        void apiFetch<{ status?: string; result?: unknown }>(`/jobs/${j.id}`).then(
          (r) => setJob({ id: j.id, ...r }),
        );
      }, 1200);
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : "Export failed"),
  });

  return (
    <div className="space-y-6">
      <Can perm="report.read" fallback={<NoAccess />}>
        <ReportStats />

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <FileDown className="size-4 text-primary" />
              Monthly export
            </CardTitle>
            <CardDescription>
              Runs as a background job; the CSV lands in the job result.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex max-w-md flex-wrap items-end gap-2">
              <div className="grid gap-2">
                <Label htmlFor="month">Month</Label>
                <Input
                  id="month"
                  placeholder="YYYY-MM"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                  className="w-36"
                />
              </div>
              <Button
                disabled={!/^\d{4}-\d{2}$/.test(month) || exportReport.isPending}
                onClick={() => exportReport.mutate()}
              >
                Export
              </Button>
            </div>
            {job && (
              <p className="mt-3 text-xs text-muted-foreground">
                Job <span className="font-mono">{job.id.slice(0, 8)}</span>
                {job.status ? ` · ${job.status.toLowerCase()}` : ""}
                {"resultUrl" in (job as object) && typeof (job as { resultUrl?: string }).resultUrl === "string" && (
                  <>
                    {" · "}
                    <a
                      className="text-primary underline"
                      href={(job as unknown as { resultUrl: string }).resultUrl}
                    >
                      download CSV
                    </a>
                  </>
                )}
              </p>
            )}
          </CardContent>
        </Card>
      </Can>

      <Can perm="report.export" fallback={null}>
        <p className="text-xs text-muted-foreground">
          You may run exports on behalf of the organization.
        </p>
      </Can>
    </div>
  );
}
