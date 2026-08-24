"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { UserPlus, UserX, VenetianMask } from "lucide-react";

import { ApiError, apiFetch, beginImpersonation } from "@/lib/api";
import { NoAccess } from "@/components/rbac/can";
import { useAuth } from "@/components/providers/auth-provider";
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

interface MemberRow {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: string;
  roleCode: string;
  membershipId: string;
}

interface RoleRow {
  id: string;
  code: string;
  name: string;
}

export default function UsersPage() {
  const qc = useQueryClient();
  const search = useSearchParams();
  const { activeOrgId, can, me } = useAuth();

  const [inviteOpen, setInviteOpen] = useState(search.get("invite") === "1");
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState("");

  const { data: members, isPending, error } = useQuery<MemberRow[]>({
    queryKey: ["users"],
    queryFn: () => apiFetch<MemberRow[]>("/users"),
  });
  const { data: roles } = useQuery<RoleRow[]>({
    queryKey: ["roles"],
    queryFn: () => apiFetch<RoleRow[]>("/roles"),
    enabled: inviteOpen && can("role.read"),
  });

  const invite = useMutation({
    mutationFn: () =>
      apiFetch(`/organizations/${activeOrgId}/invitations`, {
        method: "POST",
        body: { email, roleId },
      }),
    onSuccess: () => {
      toast.success("Invitation sent — they will receive an email with an acceptance link");
      setInviteOpen(false);
      setEmail("");
      setRoleId("");
      void qc.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : "Invitation failed"),
  });

  const deactivate = useMutation({
    mutationFn: (userId: string) =>
      apiFetch(`/users/${userId}/deactivate`, { method: "POST", body: {} }),
    onSuccess: () => {
      toast.success("User deactivated");
      void qc.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : "Could not deactivate"),
  });

  const impersonate = useMutation({
    mutationFn: (userId: string) =>
      apiFetch<{ impersonationToken: string }>("/admin/impersonate", {
        method: "POST",
        body: { userId },
      }),
    onSuccess: (res) => {
      beginImpersonation(res.impersonationToken);
      toast.info("Impersonation started — read-only session");
      window.location.assign("/");
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : "Impersonation refused"),
  });

  if (error || !can("user.read")) return <NoAccess />;

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Members</h2>
          {can("user.invite") && (
            <Button size="sm" onClick={() => setInviteOpen(true)}>
              <UserPlus />
              Invite user
            </Button>
          )}
        </div>

        {isPending ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                {(can("user.deactivate") || can("admin.impersonate")) && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(members ?? []).map((m) => (
                <TableRow key={m.membershipId}>
                  <TableCell>{m.firstName ?? "—"} {m.lastName ?? ""}</TableCell>
                  <TableCell className="text-xs">{m.email}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{m.roleCode}</Badge>
                  </TableCell>
                  <TableCell className="text-xs">{m.status.toLowerCase()}</TableCell>
                  {(can("user.deactivate") || can("admin.impersonate")) && (
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {can("admin.impersonate") && m.status === "ACTIVE" && m.id !== me?.id && (
                          <Button
                            size="xs"
                            variant="ghost"
                            title="Sign in as this user (read-only, audited)"
                            onClick={() => impersonate.mutate(m.id)}
                            disabled={impersonate.isPending}
                          >
                            <VenetianMask />
                            Sign in as
                          </Button>
                        )}
                        {can("user.deactivate") && m.status === "ACTIVE" && (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => deactivate.mutate(m.id)}
                            disabled={deactivate.isPending}
                          >
                            <UserX />
                            Deactivate
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={inviteOpen} onOpenChange={(o) => { setInviteOpen(o); if (!o) { setEmail(""); setRoleId(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite a user</DialogTitle>
            <DialogDescription>
              They receive an email with an acceptance link.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 py-2">
            <div className="grid gap-2">
              <Label htmlFor="iemail">Email</Label>
              <Input
                id="iemail"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="colleague@company.test"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="irole">Role</Label>
              <Select
                value={roleId}
                onValueChange={(v) => setRoleId(v ?? "")}
                items={Object.fromEntries((roles ?? []).map((r) => [r.id, r.name]))}
              >
                <SelectTrigger id="irole">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(roles ?? []).map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setInviteOpen(false)}>
              Close
            </Button>
            <Button
              disabled={!email.trim() || !roleId || invite.isPending}
              onClick={() => invite.mutate()}
            >
              Send invitation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
