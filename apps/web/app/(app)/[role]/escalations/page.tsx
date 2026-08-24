"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { AlarmClock, Plus, Siren, TriangleAlert } from "lucide-react";

import { ApiError, apiFetch } from "@/lib/api";
import { NoAccess } from "@/components/rbac/can";
import { useAuth } from "@/components/providers/auth-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface CaseRow {
  id: string;
  reference: string;
  subject: string;
  status: string;
  priority: string;
  slaDueAt: string | null;
  breached: boolean;
  atRisk: boolean;
  caseTypeCode: string;
  clientOrgName: string;
  ownerUserId: string | null;
}

interface RuleRow {
  id: string;
  caseTypeId: string | null;
  trigger: string;
  thresholdHours: number | null;
  action: string;
  targetRoleId: string | null;
  isActive: boolean;
}

function fmtDue(v: string | null) {
  if (!v) return "—";
  const d = new Date(v);
  const diff = d.getTime() - Date.now();
  if (diff < 0)
    return `${d.toLocaleDateString()} · ${Math.round(-diff / 3_600_000)}h overdue`;
  return `${d.toLocaleDateString()} · in ${Math.round(diff / 3_600_000)}h`;
}

export default function EscalationsPage() {
  const qc = useQueryClient();
  const search = useSearchParams();
  const { can } = useAuth();
  const [addOpen, setAddOpen] = useState(search.get("new") === "1");
  const [draft, setDraft] = useState({
    trigger: "SLA_80PCT",
    thresholdHours: "4",
    action: "NOTIFY_OWNER_AND_MANAGER",
    caseTypeId: "",
    targetRoleId: "",
  });

  // Breached/at-risk queue — the list API already computes both flags.
  const queue = useQuery<CaseRow[]>({
    queryKey: ["escalation-queue"],
    queryFn: async () => {
      const res = await apiFetch<{ items: CaseRow[] }>("/cases?page=1&pageSize=100");
      return res.items.filter((c) => c.breached || c.atRisk || c.status === "ESCALATED");
    },
    refetchInterval: 30_000,
  });

  const rules = useQuery<RuleRow[]>({
    queryKey: ["escalation-rules"],
    queryFn: () => apiFetch<RuleRow[]>("/escalation-rules"),
    enabled: can("admin.reference.manage"),
  });

  const types = useQuery<{ id: string; name: string }[]>({
    queryKey: ["case-types", "escalations"],
    queryFn: () => apiFetch("/case-types"),
    enabled: addOpen,
  });
  const roles = useQuery<{ id: string; name: string }[]>({
    queryKey: ["roles", "escalations"],
    queryFn: () => apiFetch("/roles"),
    enabled: addOpen && can("role.read"),
  });

  const sweep = useMutation({
    mutationFn: () =>
      apiFetch<{ fired?: string[]; escalated?: string[] }>("/escalations/sweep", {
        method: "POST",
        body: {},
      }),
    onSuccess: (res) => {
      toast.success(
        `Sweep done — ${res.fired?.length ?? 0} threshold(s) fired, ${res.escalated?.length ?? 0} escalated`,
      );
      void qc.invalidateQueries({ queryKey: ["escalation-queue"] });
      void qc.invalidateQueries({ queryKey: ["cases"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Sweep failed"),
  });

  const addRule = useMutation({
    mutationFn: () =>
      apiFetch("/escalation-rules", {
        method: "POST",
        body: {
          trigger: draft.trigger,
          thresholdHours: parseInt(draft.thresholdHours, 10),
          action: draft.action,
          ...(draft.caseTypeId ? { caseTypeId: draft.caseTypeId } : {}),
          ...(draft.targetRoleId ? { targetRoleId: draft.targetRoleId } : {}),
          isActive: true,
        },
      }),
    onSuccess: () => {
      toast.success("Escalation rule saved");
      setAddOpen(false);
      void qc.invalidateQueries({ queryKey: ["escalation-rules"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Rule refused"),
  });

  const toggleRule = useMutation({
    mutationFn: (r: RuleRow) =>
      apiFetch(`/escalation-rules/${r.id}`, {
        method: "PUT",
        body: { isActive: !r.isActive },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["escalation-rules"] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Update refused"),
  });

  if (!can("case.read.org")) return <NoAccess />;

  const breachedCount = (queue.data ?? []).filter((c) => c.breached || c.status === "ESCALATED").length;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
          <div>
            <CardTitle>Escalation queue</CardTitle>
            <CardDescription>
              Cases past SLA or within 20% of it — breached ones are pinned first.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" disabled={sweep.isPending} onClick={() => sweep.mutate()}>
            <Siren />
            Run sweep now
          </Button>
        </CardHeader>
        <CardContent>
          {queue.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : (queue.data ?? []).length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing breaching. The queue refreshes itself every 30 seconds.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>SLA due</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(queue.data ?? [])
                  .sort(
                    (a, b) =>
                      Number(b.breached || b.status === "ESCALATED") -
                        Number(a.breached || a.status === "ESCALATED") || 0,
                  )
                  .map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-mono text-xs">{c.reference}</TableCell>
                      <TableCell className="max-w-56 truncate">{c.subject}</TableCell>
                      <TableCell className="text-xs">{c.clientOrgName}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{c.status.toLowerCase()}</Badge>
                      </TableCell>
                      <TableCell className="text-xs">{fmtDue(c.slaDueAt)}</TableCell>
                      <TableCell className="text-right">
                        {c.status === "ESCALATED" || c.breached ? (
                          <Badge variant="destructive" className="gap-1">
                            <TriangleAlert />
                            Breached
                          </Badge>
                        ) : c.atRisk ? (
                          <Badge variant="outline" className="gap-1 text-amber-600">
                            <AlarmClock />
                            At risk
                          </Badge>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            {breachedCount} breached · {(queue.data ?? []).length - breachedCount} at risk
          </p>
        </CardContent>
      </Card>

      {can("admin.reference.manage") && (
        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
            <div>
              <CardTitle>Escalation rules</CardTitle>
              <CardDescription>
                Thresholds fire once per case; the sweep applies them.
              </CardDescription>
            </div>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus />
              New rule
            </Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {rules.isPending && <Skeleton className="h-20 w-full" />}
            {(rules.data ?? []).length === 0 && !rules.isPending && (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No rules yet — the built-in SLA_80PCT default still applies.
              </p>
            )}
            {(rules.data ?? []).map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div className="min-w-0 text-sm">
                  <span className="font-mono text-xs font-medium">{r.trigger}</span>
                  {r.thresholdHours != null && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      at {r.thresholdHours}h
                    </span>
                  )}
                  <span className="ml-2 text-xs">{r.action}</span>
                </div>
                <Button
                  size="xs"
                  variant={r.isActive ? "outline" : "ghost"}
                  onClick={() => toggleRule.mutate(r)}
                  disabled={toggleRule.isPending}
                >
                  {r.isActive ? "Active" : "Paused"}
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New escalation rule</DialogTitle>
            <DialogDescription>
              Applies during sweeps; per-case thresholds fire exactly once.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="grid gap-2">
              <Label htmlFor="etrigger">Trigger</Label>
              <select
                id="etrigger"
                value={draft.trigger}
                onChange={(e) => setDraft({ ...draft, trigger: e.target.value })}
                className="h-9 rounded-md border bg-background px-3 text-sm"
              >
                <option value="SLA_80PCT">80% of SLA elapsed</option>
                <option value="SLA_100PCT">SLA breached</option>
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="eth">Threshold override (hours before/after due)</Label>
              <Input
                id="eth"
                type="number"
                min={1}
                value={draft.thresholdHours}
                onChange={(e) => setDraft({ ...draft, thresholdHours: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="eaction">Action</Label>
              <select
                id="eaction"
                value={draft.action}
                onChange={(e) => setDraft({ ...draft, action: e.target.value })}
                className="h-9 rounded-md border bg-background px-3 text-sm"
              >
                <option value="NOTIFY_OWNER_AND_MANAGER">Notify owner & manager</option>
                <option value="ESCALATE_STATUS">Move case to ESCALATED</option>
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="etype">Case type (optional)</Label>
              <select
                id="etype"
                value={draft.caseTypeId}
                onChange={(e) => setDraft({ ...draft, caseTypeId: e.target.value })}
                className="h-9 rounded-md border bg-background px-3 text-sm"
              >
                <option value="">Any type</option>
                {(types.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            {can("role.read") && (
              <div className="grid gap-2">
                <Label htmlFor="erole">Notify role (optional)</Label>
                <select
                  id="erole"
                  value={draft.targetRoleId}
                  onChange={(e) => setDraft({ ...draft, targetRoleId: e.target.value })}
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">None</option>
                  {(roles.data ?? []).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button disabled={addRule.isPending} onClick={() => addRule.mutate()}>
              Save rule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
