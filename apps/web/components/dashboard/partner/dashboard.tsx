"use client";

import { BarChart3, FileDown } from "lucide-react";
import Link from "next/link";

import {
  CaseQueue,
} from "@/components/dashboard/shared/widgets";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function PartnerDashboard() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="size-4 text-primary" />
            Engagement workbench
          </CardTitle>
          <CardDescription>
            Cases assigned to your firm, with reporting on outcomes.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button size="sm" variant="secondary" render={<Link href="/partner/reports" />}>
            <FileDown />
            Open reports
          </Button>
        </CardContent>
      </Card>

      <CaseQueue
        title="My engagements"
        description="Cases where you are owner or submitter"
        params={{ mine: "true" }}
        limit={8}
      />
    </div>
  );
}

export function PartnerHeaderActions() {
  return null;
}
