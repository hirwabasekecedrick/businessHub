import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

export interface AuditInput {
  /** Optional for system/webhook events; falls back to the seeded system user. */
  actorUserId?: string | null;
  effectiveUserId?: string | null;
  organizationId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: any;
  after?: any;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  outcome?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditInput): Promise<void> {
    try {
      let actorUserId = input.actorUserId ?? null;
      if (!actorUserId) {
        const system = await this.prisma.user.findUnique({ where: { email: 'system@businesshub.local' } });
        actorUserId = system?.id ?? null;
      }
      if (!actorUserId) throw new Error('No actor and no system user available for audit event');
      await this.prisma.auditEvent.create({
        data: {
          actorUserId,
          effectiveUserId: input.effectiveUserId ?? null,
          organizationId: input.organizationId ?? null,
          action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resourceId ?? null,
          before: input.before === undefined ? undefined : input.before,
          after: input.after === undefined ? undefined : input.after,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          requestId: input.requestId ?? null,
          outcome: input.outcome ?? 'SUCCESS',
        },
      });
    } catch (e) {
      // Audit must never break the request path, but it must be visible.
      this.logger.error(`Failed to write audit event ${input.action}: ${e?.message}`);
    }
  }
}
