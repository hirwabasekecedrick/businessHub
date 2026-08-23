"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ChevronsUpDown, LogOut, ShieldCheck } from "lucide-react";

import { useAuth } from "@/components/providers/auth-provider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardPage() {
  const {
    status,
    me,
    activeOrgId,
    activeMembership,
    switchOrganization,
    logout,
    can,
  } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/login");
  }, [status, router]);

  if (status !== "authenticated" || !me) {
    return (
      <main className="flex min-h-svh flex-1 items-center justify-center gap-3 p-6">
        <Skeleton className="h-8 w-full max-w-md" />
      </main>
    );
  }

  const initials =
    `${me.firstName?.[0] ?? ""}${me.lastName?.[0] ?? me.email[1] ?? ""}`.toUpperCase() ||
    "U";

  return (
    <main className="min-h-svh flex-1 bg-background">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b bg-card px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2 font-semibold tracking-tight">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
            BH
          </div>
          BusinessHub
        </div>

        <div className="flex items-center gap-2">
          {me.memberships.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="outline" size="sm" className="gap-2">
                    <span className="max-w-[10rem] truncate">
                      {activeMembership?.legalName ?? "Select organization"}
                    </span>
                    <ChevronsUpDown className="size-3.5 opacity-60" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>Organizations</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {me.memberships.map((m) => (
                  <DropdownMenuItem
                    key={m.organizationId}
                    onClick={() => switchOrganization(m.organizationId)}
                    className="flex-col items-start gap-0.5"
                  >
                    <span className="font-medium">{m.legalName}</span>
                    <span className="text-xs text-muted-foreground">
                      {m.roleName}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <Avatar className="size-8">
                    <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                </button>
              }
            />
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <div className="text-sm font-medium">
                  {me.firstName} {me.lastName}
                </div>
                <div className="text-xs font-normal text-muted-foreground">
                  {me.email}
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => void logout()}>
                <LogOut />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-4xl gap-6 p-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Welcome back{me.firstName ? `, ${me.firstName}` : ""}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            You are signed in to{" "}
            <span className="font-medium text-foreground">
              {activeMembership?.legalName ?? "no organization"}
            </span>
            .
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Your access</CardTitle>
            <CardDescription>
              Role-based permissions resolved from your membership in this
              organization.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {activeMembership ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="gap-1">
                    <ShieldCheck className="size-3" />
                    {activeMembership.roleName}
                  </Badge>
                  <Badge variant="outline">{activeMembership.type}</Badge>
                  {activeMembership.approvalLevel > 0 && (
                    <Badge variant="secondary">
                      Approval level {activeMembership.approvalLevel}
                    </Badge>
                  )}
                </div>
                <Separator />
                <div className="flex flex-wrap gap-1.5">
                  {activeMembership.permissions.map((p) => (
                    <Badge
                      key={p}
                      variant={can(p) ? "secondary" : "outline"}
                      className="font-mono text-[11px]"
                    >
                      {p}
                    </Badge>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                You have no organization memberships yet.
              </p>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground">
          Operational dashboards — cases, tasks, approvals, finance and reports —
          land here next, gated by the permissions above.
        </p>
      </div>
    </main>
  );
}
