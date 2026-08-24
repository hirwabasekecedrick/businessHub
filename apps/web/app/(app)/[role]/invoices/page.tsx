"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileText, Plus, Send } from "lucide-react";

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

interface InvoiceRow {
  id: string;
  number: string | null;
  status: string;
  total: number | string;
  amountPaid: number | string;
  currency: string;
  dueDate: string | null;
}

export default function InvoicesPage() {
  const qc = useQueryClient();
  const { can } = useAuth();

  const [createOpen, setCreateOpen] = useState(false);
  const [caseId, setCaseId] = useState("");
  const [desc, setDesc] = useState("");
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");
  const [taxRate, setTaxRate] = useState("0");

  const [payFor, setPayFor] = useState<InvoiceRow | null>(null);
  const [payAmount, setPayAmount] = useState("");

  const { data, isPending, error } = useQuery<InvoiceRow[]>({
    queryKey: ["invoices"],
    queryFn: () => apiFetch<InvoiceRow[]>("/invoices"),
  });

  /** FR-6.1: create a draft; totals are computed server-side. */
  const createDraft = useMutation({
    mutationFn: () =>
      apiFetch<{ id: string }>("/invoices", {
        method: "POST",
        body: {
          caseId,
          lines: [
            {
              label: desc || "Service fee",
              quantity: Number(qty) || 1,
              unitPrice: price || "0",
              taxRate: Number(taxRate) || 0,
            },
          ],
        },
      }),
    onSuccess: () => {
      toast.success("Draft created — a second finance user must issue it");
      setCreateOpen(false);
      setCaseId("");
      setDesc("");
      void qc.invalidateQueries({ queryKey: ["invoices"] });
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : "Could not create draft"),
  });

  /** US-6.1 / FR-6.2: allocate the gapless number and freeze the invoice. */
  const issue = useMutation({
    mutationFn: (inv: InvoiceRow) =>
      apiFetch<{ number: string }>(`/invoices/${inv.id}/issue`, { method: "POST" }),
    onSuccess: (issued) => {
      toast.success(`Issued as ${issued.number}`);
      void qc.invalidateQueries({ queryKey: ["invoices"] });
    },
    onError: (e) =>
      toast.error(
        e instanceof ApiError ? e.message : "Issuance refused",
      ),
  });

  /** FR-6.2: time-limited signed PDF link. */
  const pdf = useMutation({
    mutationFn: (inv: InvoiceRow) =>
      apiFetch<{ url: string }>(`/invoices/${inv.id}/pdf-url`),
    onSuccess: ({ url }) => window.open(`${ORIGIN}${url}`, "_blank"),
    onError: () => toast.error("PDF is only available for issued invoices"),
  });

  const recordPayment = useMutation({
    mutationFn: () =>
      apiFetch(`/invoices/${payFor!.id}/payments`, {
        method: "POST",
        body: { amount: payAmount },
      }),
    onSuccess: () => {
      toast.success("Payment recorded");
      setPayFor(null);
      setPayAmount("");
      void qc.invalidateQueries({ queryKey: ["invoices"] });
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : "Payment failed"),
  });

  if (error || !can("finance.read")) return <NoAccess />;

  const num = (v: number | string | undefined | null) => Number(v ?? 0).toLocaleString();
  const balanceOf = (i: InvoiceRow) => Number(i.total) - Number(i.amountPaid);

  return (
    <div className="space-y-4">
      {can("invoice.create") && (
        <Button size="sm" className="ml-auto" onClick={() => setCreateOpen(true)}>
          <Plus />
          New draft invoice
        </Button>
      )}

      <Card>
        <CardContent className="pt-6">
          {isPending ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data ?? []).map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="font-mono text-xs">{i.number ?? "(draft)"}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="border-transparent">
                        {i.status.replaceAll("_", " ").toLowerCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {num(i.total)} {i.currency}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {num(i.amountPaid)}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {num(balanceOf(i))}
                    </TableCell>
                    <TableCell className="text-xs">{fmtDate(i.dueDate)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {can("invoice.issue") && i.status === "DRAFT" && (
                        <Button size="xs" variant="outline" onClick={() => issue.mutate(i)}>
                          <Send />
                          Issue
                        </Button>
                      )}
                      {can("finance.read") && i.status !== "DRAFT" && (
                        <Button size="xs" variant="ghost" onClick={() => pdf.mutate(i)} title="Open PDF">
                          <FileText />
                          PDF
                        </Button>
                      )}
                      {can("payment.record") &&
                        balanceOf(i) > 0 &&
                        !["VOID", "DRAFT", "PAID"].includes(i.status) && (
                          <Button size="xs" variant="outline" onClick={() => setPayFor(i)}>
                            Record payment
                          </Button>
                        )}
                    </TableCell>
                  </TableRow>
                ))}
                {data?.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                      No invoices yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* create draft dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New draft invoice</DialogTitle>
            <DialogDescription>
              Saved as a draft against a case. Segregation of duties applies at
              issuance: someone else with invoice.issue must release it.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="grid gap-2">
              <Label htmlFor="icase">Case ID</Label>
              <Input id="icase" value={caseId} onChange={(e) => setCaseId(e.target.value)} placeholder="UUID of the case" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="idesc">Line description</Label>
              <Input id="idesc" value={desc} onChange={(e) => setDesc(e.target.value)} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="grid gap-2">
                <Label htmlFor="iqty">Qty</Label>
                <Input id="iqty" type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="iprice">Unit price</Label>
                <Input id="iprice" type="number" value={price} onChange={(e) => setPrice(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="itax">Tax %</Label>
                <Input id="itax" type="number" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!caseId.trim() || !price || createDraft.isPending} onClick={() => createDraft.mutate()}>
              Save draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* payment dialog */}
      <Dialog open={!!payFor} onOpenChange={(o) => !o && setPayFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record payment — {payFor?.number}</DialogTitle>
            <DialogDescription>
              Balance due {num(payFor ? balanceOf(payFor) : 0)} {payFor?.currency}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-2">
            <Label htmlFor="pamount">Amount</Label>
            <Input
              id="pamount"
              type="number"
              value={payAmount}
              onChange={(e) => setPayAmount(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPayFor(null)}>
              Cancel
            </Button>
            <Button
              disabled={!payAmount || Number(payAmount) <= 0 || recordPayment.isPending}
              onClick={() => recordPayment.mutate()}
            >
              Record
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
