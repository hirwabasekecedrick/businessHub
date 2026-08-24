"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, History, Upload } from "lucide-react";

import { ApiError, apiFetch } from "@/lib/api";
import { NoAccess } from "@/components/rbac/can";
import { useAuth } from "@/components/providers/auth-provider";
import { fmtDate } from "@/components/dashboard/shared/widgets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:2020/v1";
const ORIGIN = API_URL.replace(/\/v1\/?$/, "");

interface DocRow {
  id: string;
  caseId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number | string;
  classification: string;
  category: string | null;
  version: number;
  scanStatus: string;
  expiresAt: string | null;
  createdAt: string;
}

function ScanBadge({ status }: { status: string }) {
  const variant =
    status === "CLEAN"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
      : status === "INFECTED"
        ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
        : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300";
  return <Badge className={`border-transparent ${variant}`}>{status.toLowerCase()}</Badge>;
}

export default function DocumentsPage() {
  const qc = useQueryClient();
  const { can } = useAuth();

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [expiringOnly, setExpiringOnly] = useState(false);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [upCaseId, setUpCaseId] = useState("");
  const [upFilename, setUpFilename] = useState("");
  const [upCategory, setUpCategory] = useState("");
  const [versionsFor, setVersionsFor] = useState<DocRow | null>(null);

  const { data, isPending, error } = useQuery<DocRow[]>({
    queryKey: ["documents"],
    queryFn: () => apiFetch<DocRow[]>("/documents"),
  });

  const categories = useMemo(
    () => Array.from(new Set((data ?? []).map((d) => d.category).filter(Boolean))) as string[],
    [data],
  );

  const filtered = useMemo(() => {
    return (data ?? []).filter((d) => {
      if (search && !d.filename.toLowerCase().includes(search.toLowerCase())) return false;
      if (category !== "all" && d.category !== category) return false;
      if (
        expiringOnly &&
        (!d.expiresAt ||
          new Date(d.expiresAt).getTime() > Date.now() + 30 * 864e5 ||
          new Date(d.expiresAt).getTime() < Date.now())
      )
        return false;
      return true;
    });
  }, [data, search, category, expiringOnly]);

  /** FR-5.7: ask the API for a single-use grant, then follow it. */
  const download = useMutation({
    mutationFn: (doc: DocRow) =>
      apiFetch<{ url: string; expiresIn: number }>(`/documents/${doc.id}/download-url`),
    onSuccess: ({ url }) => {
      window.open(`${ORIGIN}${url}`, "_blank");
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : "Download refused"),
  });

  const upload = useMutation({
    mutationFn: async () => {
      // FR-5.1 two-phase handshake; dev storage accepts no bytes.
      const session = await apiFetch<{ sessionId: string }>("/documents/upload-sessions", {
        method: "POST",
        body: {
          caseId: upCaseId,
          filename: upFilename,
          mimeType: guessMime(upFilename),
          sizeBytes: 1024,
          ...(upCategory ? { category: upCategory } : {}),
        },
      });
      return apiFetch("/documents/upload-sessions/" + session.sessionId + "/complete", {
        method: "POST",
      });
    },
    onSuccess: () => {
      toast.success("Document uploaded and scanned");
      setUploadOpen(false);
      setUpCaseId("");
      setUpFilename("");
      setUpCategory("");
      void qc.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : "Upload failed"),
  });

  const versions = useQuery<string[]>({
    queryKey: ["document-versions", versionsFor?.id],
    queryFn: () => apiFetch<string[]>(`/documents/${versionsFor!.id}/versions`),
    enabled: !!versionsFor,
  });

  if (error || !can("document.read")) return <NoAccess />;

  const kb = (v: number | string) => `${Math.max(1, Math.round(Number(v ?? 0) / 1024))} KB`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1">
          <Label htmlFor="docsearch">Search</Label>
          <Input
            id="docsearch"
            placeholder="Filename…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-56"
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="doccat">Category</Label>
          <select
            id="doccat"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm"
          >
            <option value="all">All</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <label className="flex h-9 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={expiringOnly}
            onChange={(e) => setExpiringOnly(e.target.checked)}
            className="size-4"
          />
          Expiring ≤30 days
        </label>
        {can("document.upload") && (
          <Button size="sm" className="ml-auto" onClick={() => setUploadOpen(true)}>
            <Upload />
            Upload
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="pt-6">
          {isPending ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Class</TableHead>
                  <TableHead>v</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead>Scan</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="max-w-64 truncate font-medium">{d.filename}</TableCell>
                    <TableCell className="text-xs">{d.category ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="border-transparent text-xs">
                        {d.classification.toLowerCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">{d.version}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{kb(d.sizeBytes)}</TableCell>
                    <TableCell>
                      <ScanBadge status={d.scanStatus} />
                    </TableCell>
                    <TableCell className="text-xs">{fmtDate(d.expiresAt)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setVersionsFor(d)}
                        title="Version history"
                      >
                        <History />
                      </Button>
                      {can("document.download") && (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={d.scanStatus !== "CLEAN" || download.isPending}
                          onClick={() => download.mutate(d)}
                        >
                          <Download />
                          Get link
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                      No documents match. Upload one or relax the filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* upload dialog */}
      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload document</DialogTitle>
            <DialogDescription>
              Bytes go straight to storage via a pre-signed session; the server
              verifies checksum and queues the virus scan.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="grid gap-2">
              <Label htmlFor="ucase">Case ID</Label>
              <Input id="ucase" value={upCaseId} onChange={(e) => setUpCaseId(e.target.value)} placeholder="UUID of the case" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ufname">Filename</Label>
              <Input id="ufname" value={upFilename} onChange={(e) => setUpFilename(e.target.value)} placeholder="contract_v3.pdf" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ucat">Category (optional)</Label>
              <Input id="ucat" value={upCategory} onChange={(e) => setUpCategory(e.target.value)} placeholder="incorporation_certificate" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUploadOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!upCaseId.trim() || !upFilename.trim() || upload.isPending}
              onClick={() => upload.mutate()}
            >
              Upload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* versions dialog */}
      <Dialog open={!!versionsFor} onOpenChange={(o) => !o && setVersionsFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Versions — {versionsFor?.filename}</DialogTitle>
            <DialogDescription>Newest first; originals are never overwritten.</DialogDescription>
          </DialogHeader>
          <ul className="max-h-64 space-y-1 overflow-auto py-2 text-sm">
            {(Array.isArray(versions.data) ? versions.data : []).map((v) => {
              const row = v as unknown as DocRow;
              return (
                <li key={row.id} className="flex items-center justify-between rounded border px-3 py-2">
                  <span className="font-mono text-xs">v{row.version}</span>
                  <span className="flex-1 px-3 truncate">{row.filename}</span>
                  <span className="text-xs text-muted-foreground">{fmtDate(row.createdAt)}</span>
                </li>
              );
            })}
            {versions.isPending && <li className="py-4 text-center text-muted-foreground">Loading…</li>}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "csv":
      return "text/csv";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    default:
      return "application/octet-stream";
  }
}
