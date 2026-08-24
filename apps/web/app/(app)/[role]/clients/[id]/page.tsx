"use client";

import { use } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, TriangleAlert } from "lucide-react";

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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface ChecklistItem {
  category: string;
  valid: boolean;
  expiring: boolean;
}

interface Overview {
  organisation: {
    id: string;
    legalName: string;
    type: string;
    country: string | null;
    taxId: string | null;
    status: string;
  };
  cases: Array<{ reference: string; subject: string; status: string }>;
  documents: number;
  contacts: Array<{
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    jobTitle: string | null;
    isPrimary: boolean;
  }>;
  compliance: { checklist: ChecklistItem[]; atRisk: boolean };
  invoices?: Array<{
    number: string | null;
    total: string;
    paid: string;
    balance: string;
    currency: string;
    status: string;
  }>;
  outstandingTotal?: string;
}

export default function OrgDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { role } = useParams<{ role: string }>();
  const { can } = useAuth();

  const { data, isPending, error } = useQuery<Overview>({
    queryKey: ["crm-overview", id],
    queryFn: () => apiFetch<Overview>(`/clients/${id}/overview`),
  });

  if (error) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <div className="space-y-4">
          <BackLink />
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              This organisation does not exist or you cannot see it.
            </CardContent>
          </Card>
        </div>
      );
    }
    return <NoAccess />;
  }

  if (!can("crm.read")) return <NoAccess />;

  return (
    <div className="space-y-6">
      <BackLink />

      {isPending || !data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          {/* identity + status header */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center gap-3">
                <CardTitle className="text-xl">{data.organisation.legalName}</CardTitle>
                <Badge variant="outline" className="border-transparent text-xs">
                  {data.organisation.type.toLowerCase()}
                </Badge>
                <Badge
                  className={
                    data.compliance.atRisk
                      ? "border-transparent bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
                      : "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                  }
                >
                  {data.compliance.atRisk ? (
                    <>
                      <TriangleAlert className="size-3" />
                      compliance at risk
                    </>
                  ) : (
                    "compliant"
                  )}
                </Badge>
                <span className="ml-auto text-xs text-muted-foreground">
                  {data.organisation.country ?? "—"} · tax {data.organisation.taxId ?? "—"} ·{" "}
                  {data.organisation.status.toLowerCase()} · {data.documents} document
                  {data.documents === 1 ? "" : "s"}
                </span>
              </div>
            </CardHeader>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* cases */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Open history — cases</CardTitle>
                <CardDescription>{data.cases.length} linked</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm">
                  {data.cases.slice(0, 8).map((c) => (
                    <li key={c.reference} className="flex items-center justify-between gap-2 rounded border px-3 py-2">
                      <Link href={`/${role}/cases`} className="font-mono text-xs text-primary hover:underline">
                        {c.reference}
                      </Link>
                      <span className="flex-1 truncate">{c.subject}</span>
                      <Badge variant="outline" className="border-transparent text-[10px]">
                        {c.status.replaceAll("_", " ").toLowerCase()}
                      </Badge>
                    </li>
                  ))}
                  {data.cases.length === 0 && (
                    <li className="py-6 text-center text-muted-foreground">No cases yet.</li>
                  )}
                </ul>
              </CardContent>
            </Card>

            {/* contacts */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Contacts</CardTitle>
                <CardDescription>Exactly one primary contact enforced.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Email</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.contacts.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium">
                          {c.firstName} {c.lastName}
                          {c.isPrimary && (
                            <Badge className="ml-2 border-transparent bg-primary/10 text-[10px] text-primary">
                              primary
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">{c.jobTitle ?? "—"}</TableCell>
                        <TableCell className="text-xs">{c.email}</TableCell>
                      </TableRow>
                    ))}
                    {data.contacts.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={3} className="py-6 text-center text-muted-foreground">
                          No contacts.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* compliance checklist */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Compliance checklist</CardTitle>
                <CardDescription>Driven by required document categories and expiry.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm">
                  {data.compliance.checklist.map((item) => (
                    <li key={item.category} className="flex items-center justify-between rounded border px-3 py-2">
                      <span className="font-mono text-xs">{item.category}</span>
                      {item.valid ? (
                        <Badge className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                          valid
                        </Badge>
                      ) : item.expiring ? (
                        <Badge className="border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                          expiring
                        </Badge>
                      ) : (
                        <Badge className="border-transparent bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300">
                          missing/expired
                        </Badge>
                      )}
                    </li>
                  ))}
                  {data.compliance.checklist.length === 0 && (
                    <li className="py-6 text-center text-muted-foreground">
                      No required document categories configured.
                    </li>
                  )}
                </ul>
              </CardContent>
            </Card>

            {/* transactions panel — absent from the RESPONSE for users without finance perms */}
            {data.invoices !== undefined && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Transactions</CardTitle>
                  <CardDescription>
                    Outstanding{" "}
                    <span className="font-semibold tabular-nums">
                      {Number(data.outstandingTotal ?? 0).toLocaleString()}{" "}
                      {data.invoices[0]?.currency}
                    </span>
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Number</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                        <TableHead className="text-right">Balance</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.invoices.slice(0, 8).map((i) => (
                        <TableRow key={i.number ?? i.total}>
                          <TableCell className="font-mono text-xs">{i.number ?? "draft"}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {Number(i.total).toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right font-medium tabular-nums">
                            {Number(i.balance).toLocaleString()}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="border-transparent text-[10px]">
                              {i.status.replaceAll("_", " ").toLowerCase()}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                      {data.invoices.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                            No invoices issued.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function BackLink() {
  const { role } = useParams<{ role: string }>();
  return (
    <Link
      href={`/${role}/clients`}
      className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
      Clients & partners
    </Link>
  );
}
