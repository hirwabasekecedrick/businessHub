-- AlterTable
ALTER TABLE "notification" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "next_retry_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "compliance_status" TEXT NOT NULL DEFAULT 'COMPLIANT';

-- AlterTable
ALTER TABLE "task" ALTER COLUMN "case_id" DROP NOT NULL;

-- FR-9.5: the audit trail is append-only. Even the database owner cannot
-- UPDATE or DELETE audit rows once written; the trigger applies regardless
-- of role grants.
CREATE OR REPLACE FUNCTION bh_forbid_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only (FR-9.5)';
END;
$$;

DROP TRIGGER IF EXISTS audit_event_append_only ON "audit_event";
CREATE TRIGGER audit_event_append_only
  BEFORE UPDATE OR DELETE ON "audit_event"
  FOR EACH ROW EXECUTE FUNCTION bh_forbid_audit_mutation();
