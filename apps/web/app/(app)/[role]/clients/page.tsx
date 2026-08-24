"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";

import { apiFetch } from "@/lib/api";
import { NoAccess } from "@/components/rbac/can";
import { useAuth } from "@/components/providers/auth-provider";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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

interface OrgRow {
  id: string;
  legalName: string;
  type: string;
  country: string | null;
  taxId: string | null;
  tier: string | null;
  status: string;
}

export default function ClientsPage() {
  const { can } = useAuth();
  const { role } = useParams<{ role: string }>();
  const [search, setSearch] = useState("");

  const clients = useQuery<OrgRow[]>({
    queryKey: ["crm-clients"],
    queryFn: () => apiFetch<OrgRow[]>("/clients"),
  });
  const partners = useQuery<OrgRow[]>({
    queryKey: ["crm-partners"],
    queryFn: () => apiFetch<OrgRow[]>("/partners"),
  });

  const rows = useMemo(
    () => [...(clients.data ?? []), ...(partners.data ?? [])].filter(
      (o) => !search || o.legalName.toLowerCase().includes(search.toLowerCase()),
    ),
    [clients.data, partners.data, search],
  );

  if (!can("crm.read")) return <NoAccess />;

  const isPending = clients.isPending || partners.isPending;

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2">
        <div className="grid gap-1">
          <Label htmlFor="crmsearch">Search</Label>
          <Input
            id="crmsearch"
            placeholder="Legal name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-64"
          />
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          {isPending ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organisation</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Country</TableHead>
                  <TableHead>Tax ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="font-medium">{o.legalName}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="border-transparent text-xs">
                        {o.type.toLowerCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{o.country ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{o.taxId ?? "—"}</TableCell>
                    <TableCell className="text-xs">{o.status.toLowerCase()}</TableCell>
                    <TableCell className="text-right">
                      <Link
                        href={`/${role}/clients/${o.id}`}
                        className="inline-flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline"
                      >
                        Open 360°
                        <ArrowRight className="size-3.5" />
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                      No organisations match.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
