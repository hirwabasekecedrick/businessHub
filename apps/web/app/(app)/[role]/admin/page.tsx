"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Save } from "lucide-react";

import { ApiError, apiFetch } from "@/lib/api";
import { NoAccess } from "@/components/rbac/can";
import { useAuth } from "@/components/providers/auth-provider";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

interface OrgSettings {
  branding?: Record<string, string>;
  locale?: string;
  currency?: string;
  invoiceNumbering?: string;
  dunningScheduleDays?: number[];
}

interface RefSetPayload {
  set: string;
  items: unknown[];
  customized: boolean;
}

const REFERENCE_SETS = ["tax-rates", "business-calendars", "document-categories", "priorities"];

interface FlagsPayload {
  featureFlags: Record<string, boolean>;
  maintenance: { enabled: boolean; message: string | null };
  knownFlags: string[];
}

export default function AdminSettingsPage() {
  const qc = useQueryClient();
  const { can } = useAuth();

  const [currency, setCurrency] = useState("");
  const [locale, setLocale] = useState("en");
  const [dunning, setDunning] = useState("");
  const [refDrafts, setRefDrafts] = useState<Record<string, string>>({});

  const settings = useQuery<{ settings: OrgSettings }>({
    queryKey: ["admin-settings"],
    queryFn: () => apiFetch("/admin/settings"),
  });

  useEffect(() => {
    if (settings.data) {
      setCurrency(settings.data.settings.currency ?? "EUR");
      setLocale(settings.data.settings.locale ?? "en");
      setDunning((settings.data.settings.dunningScheduleDays ?? [7, 14, 30]).join(", "));
    }
  }, [settings.data]);

  const refSets = useQuery<RefSetPayload[]>({
    queryKey: ["reference-sets"],
    queryFn: async () =>
      Promise.all(
        REFERENCE_SETS.map((set) =>
          apiFetch<RefSetPayload>(`/admin/reference/${set}`).then((r) => ({ ...r, set })),
        ),
      ),
  });

  const flags = useQuery<FlagsPayload>({
    queryKey: ["admin-flags"],
    queryFn: () => apiFetch("/admin/flags"),
  });
  const [flagDraft, setFlagDraft] = useState<Record<string, boolean>>({});
  const [maintMessage, setMaintMessage] = useState("");

  useEffect(() => {
    if (flags.data) {
      setFlagDraft(flags.data.featureFlags);
      setMaintMessage(flags.data.maintenance.message ?? "");
    }
  }, [flags.data]);

  const saveFlags = useMutation({
    mutationFn: () =>
      apiFetch("/admin/flags", {
        method: "PUT",
        body: {
          flags: flagDraft,
          maintenance: { enabled: !!flags.data?.maintenance.enabled, message: maintMessage },
        },
      }),
    onSuccess: () => {
      toast.success("Flags saved");
      void qc.invalidateQueries({ queryKey: ["admin-flags"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Save refused"),
  });

  const toggleMaintenance = useMutation({
    mutationFn: (enabled: boolean) =>
      apiFetch("/admin/flags", {
        method: "PUT",
        body: { maintenance: { enabled, message: maintMessage } },
      }),
    onSuccess: (_r, enabled) => {
      toast.success(enabled ? "Maintenance mode ON" : "Maintenance mode off");
      void qc.invalidateQueries({ queryKey: ["admin-flags"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Toggle refused"),
  });

  useEffect(() => {
    if (refSets.data) {
      const drafts: Record<string, string> = {};
      for (const r of refSets.data) drafts[r.set] = JSON.stringify(r.items, null, 2);
      setRefDrafts(drafts);
    }
  }, [refSets.data]);

  const saveSettings = useMutation({
    mutationFn: () => {
      const days = dunning
        .split(",")
        .map((d) => parseInt(d.trim(), 10))
        .filter((d) => Number.isInteger(d) && d > 0);
      return apiFetch("/admin/settings", {
        method: "PUT",
        body: { currency: currency.toUpperCase().slice(0, 3), locale, dunningScheduleDays: days },
      });
    },
    onSuccess: () => {
      toast.success("Settings saved");
      void qc.invalidateQueries({ queryKey: ["admin-settings"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Save refused"),
  });

  const saveRef = useMutation({
    mutationFn: (set: string) => {
      let items: unknown;
      try {
        items = JSON.parse(refDrafts[set] ?? "[]");
      } catch {
        return Promise.reject(new Error("Invalid JSON"));
      }
      return apiFetch(`/admin/reference/${set}`, { method: "PUT", body: { items } });
    },
    onSuccess: (_r, set) => {
      toast.success(`${set} saved`);
      void qc.invalidateQueries({ queryKey: ["reference-sets"] });
    },
    onError: (e) => toast.error(e.message === "Invalid JSON" ? "Fix the JSON first" : "Save refused"),
  });

  if (!can("org.settings.manage")) return <NoAccess />;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Organisation settings</CardTitle>
          <CardDescription>
            Branding, locale, currency, SLA calendar and dunning — per FR-9.2.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {settings.isPending ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="cur">Currency (ISO-4217)</Label>
                <Input
                  id="cur"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                  maxLength={3}
                  className="w-28 font-mono"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="loc">Locale</Label>
                <select
                  id="loc"
                  value={locale}
                  onChange={(e) => setLocale(e.target.value)}
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                >
                  <option value="en">English</option>
                  <option value="fr">Français</option>
                </select>
              </div>
              <div className="grid gap-2 sm:col-span-2">
                <Label htmlFor="dun">Dunning schedule (days after due date)</Label>
                <Input id="dun" value={dunning} onChange={(e) => setDunning(e.target.value)} placeholder="7, 14, 30" />
              </div>
              <div className="sm:col-span-2">
                <Button size="sm" disabled={saveSettings.isPending} onClick={() => saveSettings.mutate()}>
                  <Save />
                  Save settings
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Feature flags & maintenance</CardTitle>
          <CardDescription>
            Runtime switches — no redeploy. Maintenance locks out non-admin users (FR-9.5).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {flags.isPending ? (
            <Skeleton className="h-28 w-full" />
          ) : (
            <>
              <div className="grid max-w-md gap-3">
                {(flags.data?.knownFlags ?? []).map((f) => (
                  <div key={f} className="flex items-center justify-between rounded-lg border p-3">
                    <span className="font-mono text-xs">{f}</span>
                    <Button
                      size="xs"
                      variant={flagDraft[f] ? "default" : "outline"}
                      onClick={() => setFlagDraft((d) => ({ ...d, [f]: !d[f] }))}
                      disabled={saveFlags.isPending}
                    >
                      {flagDraft[f] ? "On" : "Off"}
                    </Button>
                  </div>
                ))}
              </div>

              <div className="grid max-w-md gap-2">
                <Label htmlFor="maintmsg">Maintenance message</Label>
                <Input
                  id="maintmsg"
                  value={maintMessage}
                  onChange={(e) => setMaintMessage(e.target.value)}
                  placeholder="Back on Monday 08:00 EAT"
                />
              </div>

              <div className="flex items-center gap-4">
                <Button
                  size="sm"
                  variant={flags.data?.maintenance.enabled ? "destructive" : "outline"}
                  onClick={() => toggleMaintenance.mutate(!flags.data?.maintenance.enabled)}
                  disabled={toggleMaintenance.isPending}
                >
                  {flags.data?.maintenance.enabled ? "Turn off maintenance" : "Enable maintenance"}
                </Button>
                <span
                  className={
                    flags.data?.maintenance.enabled
                      ? "text-sm font-semibold text-destructive"
                      : "text-sm text-muted-foreground"
                  }
                >
                  {flags.data?.maintenance.enabled
                    ? "Maintenance mode is ACTIVE — clients are locked out"
                    : "Maintenance mode off"}
                </span>
              </div>

              <Button size="sm" disabled={saveFlags.isPending} onClick={() => saveFlags.mutate()}>
                <Save />
                Save flags
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Reference data</CardTitle>
          <CardDescription>
            Managed through the interface — no deployment needed. JSON arrays; changes are audited.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {refSets.isPending && <Skeleton className="h-40 w-full" />}
          {(refSets.data ?? []).map((r) => (
            <div key={r.set} className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor={`ref-${r.set}`} className="font-mono text-xs">
                  {r.set}
                  {!r.customized && (
                    <span className="ml-2 font-sans text-[10px] uppercase tracking-wide text-muted-foreground">
                      default
                    </span>
                  )}
                </Label>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={saveRef.isPending || refDrafts[r.set] === undefined}
                  onClick={() => saveRef.mutate(r.set)}
                >
                  <Save />
                  Save
                </Button>
              </div>
              <textarea
                id={`ref-${r.set}`}
                value={refDrafts[r.set] ?? ""}
                onChange={(e) => setRefDrafts((d) => ({ ...d, [r.set]: e.target.value }))}
                rows={Math.min(8, Math.max(3, (refDrafts[r.set]?.split("\n").length ?? 3)))}
                className="w-full rounded-md border bg-background p-3 font-mono text-xs"
                spellCheck={false}
              />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
