"use client";

import { use, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import QRCode from "qrcode";
import { Copy, Loader2, LogOut, ShieldAlert, ShieldCheck } from "lucide-react";

import { ApiError, apiFetch } from "@/lib/api";
import { NoAccess } from "@/components/rbac/can";
import { useAuth } from "@/components/providers/auth-provider";
import {
  ProfileCard,
  fmtDateTime,
} from "@/components/dashboard/shared/widgets";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

interface SessionRow {
  id: string;
  device: string | null;
  ip: string | null;
  lastSeen: string;
  expiresAt: string;
  active: boolean;
}

function MfaCard() {
  const { me, enrolMfa, confirmMfa, disableMfa, mfaRequiredForRole } = useAuth();
  const [provisioning, setProvisioning] = useState<{
    uri: string;
    secret: string;
  } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);

  if (!me) return null;
  const enabled = me.mfaEnabled;

  async function start() {
    setPending(true);
    try {
      const p = await enrolMfa();
      setProvisioning(p);
      setQr(await QRCode.toDataURL(p.uri, { margin: 1, width: 176 }));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not start enrolment");
    } finally {
      setPending(false);
    }
  }

  async function confirm() {
    if (!provisioning) return;
    setPending(true);
    try {
      const res = await confirmMfa(code.trim());
      setCodes(res.recoveryCodes ?? []);
      setProvisioning(null);
      setCode("");
      toast.success("Two-factor authentication enabled");
    } catch (e) {
      toast.error(
        e instanceof ApiError
          ? e.code === "MFA_CODE_INVALID"
            ? "Invalid or expired code."
            : e.message
          : "Confirmation failed",
      );
    } finally {
      setPending(false);
    }
  }

  async function turnOff() {
    setPending(true);
    try {
      await disableMfa();
      toast.success("Two-factor authentication disabled");
    } catch (e) {
      toast.error(
        e instanceof ApiError && e.code === "MFA_MANDATORY_FOR_ROLE"
          ? "Your role requires two-factor authentication — it cannot be disabled."
          : e instanceof ApiError
            ? e.message
            : "Could not disable MFA",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Two-factor authentication
          {enabled ? (
            <Badge className="gap-1">
              <ShieldCheck /> On
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <ShieldAlert /> Off
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          TOTP authenticator with ten single-use recovery codes.
          {mfaRequiredForRole && !enabled
            ? " Your role requires MFA — enrolment is mandatory."
            : ""}
        </CardDescription>
      </CardHeader>

      {codes ? (
        <CardContent className="grid gap-3">
          <Alert>
            <ShieldAlert />
            <AlertDescription>
              Shown exactly once — store these recovery codes safely.
            </AlertDescription>
          </Alert>
          <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-3">
            {codes.map((c) => (
              <code key={c} className="text-center text-sm font-semibold tracking-wider">
                {c}
              </code>
            ))}
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void navigator.clipboard.writeText(codes.join("\n")).catch(() => {})}
            >
              <Copy />
              Copy all
            </Button>
            <Button variant="ghost" onClick={() => setCodes(null)}>
              I&apos;ve saved them
            </Button>
          </div>
        </CardContent>
      ) : provisioning ? (
        <CardContent className="grid gap-4">
          <div className="flex flex-col items-center gap-2">
            {qr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr} alt="TOTP QR code" className="size-44 rounded-lg border bg-white p-1" />
            ) : (
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            )}
            <p className="text-center text-xs break-all text-muted-foreground">
              Manual secret: <code className="font-semibold text-foreground">{provisioning.secret}</code>
            </p>
          </div>
          <div className="grid gap-2">
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <div className="flex gap-2">
              <Button onClick={() => void confirm()} disabled={pending || code.trim().length !== 6}>
                Enable
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setProvisioning(null);
                  setCode("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        </CardContent>
      ) : (
        <CardContent>
          {enabled ? (
            <Button
              variant="destructive"
              size="sm"
              disabled={pending || mfaRequiredForRole}
              title={
                mfaRequiredForRole
                  ? "Mandatory for your role"
                  : undefined
              }
              onClick={() => void turnOff()}
            >
              Disable two-factor
            </Button>
          ) : (
            <Button size="sm" disabled={pending} onClick={() => void start()}>
              Set up authenticator
            </Button>
          )}
          {mfaRequiredForRole && (
            <p className="mt-2 text-xs text-muted-foreground">
              Manager/Admin roles keep MFA always on.
            </p>
          )}
        </CardContent>
      )}
    </Card>
  );
}

export default function ProfilePage({ params }: PageProps<"/[role]/me">) {
  const { role: _role } = use(params);
  const { me, activeMembership } = useAuth();
  const qc = useQueryClient();

  const { data: sessions } = useQuery<SessionRow[]>({
    queryKey: ["sessions"],
    queryFn: () => apiFetch<SessionRow[]>("/auth/sessions"),
    enabled: !!me,
  });

  const revoke = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/auth/sessions/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Session signed out");
      void qc.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : "Failed to revoke session"),
  });

  if (!me) return null;
  if (!activeMembership) return <NoAccess />;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <ProfileCard me={me} />
        <MfaCard />
        <Card>
          <CardHeader>
            <CardTitle>Active sessions</CardTitle>
            <CardDescription>Devices currently signed in as you</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {(sessions ?? []).map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {s.device ?? "Unknown device"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {s.ip ?? "unknown ip"} · seen {fmtDateTime(s.lastSeen)}
                  </p>
                </div>
                {s.active ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => revoke.mutate(s.id)}
                    disabled={revoke.isPending}
                  >
                    <LogOut />
                    Sign out
                  </Button>
                ) : (
                  <Badge variant="outline">ended</Badge>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card className="self-start">
        <CardHeader>
          <CardTitle>Membership</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="font-medium">{activeMembership.legalName}</p>
          <Badge>{activeMembership.roleName}</Badge>
          <Separator />
          <p className="text-xs text-muted-foreground">
            Approval level {activeMembership.approvalLevel}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
