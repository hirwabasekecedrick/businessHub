"use client";

import { use, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";

import { ApiError, apiFetch } from "@/lib/api";
import { NoAccess } from "@/components/rbac/can";
import { useAuth } from "@/components/providers/auth-provider";
import {
  StatusBadge,
  fmtDate,
  type CaseRow,
  type CasesResponse,
} from "@/components/dashboard/shared/widgets";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

const STATUSES = [
  "",
  "DRAFT",
  "SUBMITTED",
  "QUALIFIED",
  "ASSIGNED",
  "IN_PROGRESS",
  "ON_HOLD",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "CLOSED",
];

interface CaseTypeRow {
  id: string;
  code: string;
  name: string;
}

export default function CasesPage({ params }: PageProps<"/[role]/cases">) {
  const { role } = use(params);
  const search = useSearchParams();
  const qc = useQueryClient();
  const { activeMembership, can } = useAuth();

  const [status, setStatus] = useState("");
  const [mine, setMine] = useState(false);
  const [page, setPage] = useState(1);

  const qs = new URLSearchParams({
    page: String(page),
    pageSize: "15",
    ...(status ? { status } : {}),
    ...(mine ? { mine: "true" } : {}),
  });

  const { data, isPending, error } = useQuery<CasesResponse>({
    queryKey: ["cases", Object.fromEntries(qs)],
    queryFn: () => apiFetch<CasesResponse>(`/cases?${qs}`),
  });

  /* create-case dialog (clients & staff with case.create) */
  const canCreate = can("case.create");
  const [open, setOpen] = useState(search.get("new") === "1");
  const [typeId, setTypeId] = useState(search.get("type") ?? "");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");

  const { data: types } = useQuery<CaseTypeRow[]>({
    queryKey: ["case-types"],
    queryFn: () => apiFetch<CaseTypeRow[]>("/case-types"),
    enabled: canCreate,
  });

  const create = useMutation({
    mutationFn: () =>
      apiFetch<{ id: string; reference: string }>("/cases", {
        method: "POST",
        body: {
          caseTypeId: typeId || undefined,
          subject,
          description,
        },
      }),
    onSuccess: (c) => {
      toast.success(`Case ${c.reference} created`);
      setOpen(false);
      setSubject("");
      setDescription("");
      void qc.invalidateQueries({ queryKey: ["cases"] });
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : "Could not create case"),
  });

  if (error instanceof ApiError && error.status === 403) return <NoAccess />;

  const total = data?.meta.total ?? 0;
  const pageSize = data?.meta.pageSize ?? 15;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={status}
          onValueChange={(v) => {
            setStatus(v ?? "");
            setPage(1);
          }}
          items={{ "": "All statuses", ...Object.fromEntries(STATUSES.filter(Boolean).map((s) => [s, s.replaceAll("_", " ")])) }}
        >
          <SelectTrigger className="w-44" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUSES.map((s) => (
              <SelectItem key={s || "all"} value={s}>
                {s ? s.replaceAll("_", " ") : "All statuses"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          size="sm"
          variant={mine ? "default" : "outline"}
          onClick={() => {
            setMine((v) => !v);
            setPage(1);
          }}
        >
          {mine ? "Showing mine" : "All assigned to me"}
        </Button>

        {canCreate && (
          <Button size="sm" className="ml-auto" onClick={() => setOpen(true)}>
            <Plus />
            New case
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="pt-6">
          {isPending ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>SLA due</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.items ?? []).map((c: CaseRow) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono text-xs">
                      <Link href={`/${role}/cases/${c.id}`} className="hover:underline">
                        {c.reference}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-[16rem]">
                      <Link href={`/${role}/cases/${c.id}`} className="block truncate hover:underline">
                        {c.subject}
                        {c.clientOrgName ? (
                          <span className="text-muted-foreground"> · {c.clientOrgName}</span>
                        ) : null}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs">{c.caseTypeCode}</TableCell>
                    <TableCell>
                      <StatusBadge status={c.status} />
                    </TableCell>
                    <TableCell className="text-xs">
                      {c.breached ? (
                        <span className="font-medium text-destructive">breached</span>
                      ) : c.atRisk ? (
                        <span className="font-medium text-amber-600">at risk · {fmtDate(c.slaDueAt)}</span>
                      ) : (
                        fmtDate(c.slaDueAt)
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {data?.items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                      No cases match.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}

          <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {total} case{total === 1 ? "" : "s"}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="icon-xs"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="outline"
                size="icon-xs"
                disabled={page * pageSize >= total}
                onClick={() => setPage((p) => p + 1)}
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New case</DialogTitle>
            <DialogDescription>
              Submit a request for{" "}
              {activeMembership?.legalName ? `your organization` : "processing"}.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="ctype">Request type</Label>
              <Select
                value={typeId}
                onValueChange={(v) => setTypeId(v ?? "")}
                items={Object.fromEntries((types ?? []).map((t) => [t.id, t.name]))}
              >
                <SelectTrigger id="ctype">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(types ?? []).map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="csubject">Subject</Label>
              <Input
                id="csubject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="e.g. Register Acme Trading Ltd"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cdesc">Details</Label>
              <Textarea
                id="cdesc"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!subject.trim() || !typeId || create.isPending}
              onClick={() => create.mutate()}
            >
              Create case
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
