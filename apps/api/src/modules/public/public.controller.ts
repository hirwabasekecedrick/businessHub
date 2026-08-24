import {
  BadRequestException,
  Controller,
  Module,
  Post,
  Body,
  HttpCode,
  Req,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../../common/audit.service';
import { NotificationService } from '../../common/notification.service';
import { Public } from '../../common/decorators/public.decorator';

const REQUEST_TYPES = ['COMPANY_REG', 'TAX_CLEARANCE', 'WORK_PERMIT', 'OTHER'] as const;
type RequestType = (typeof REQUEST_TYPES)[number];

@Controller('v1')
export class PublicController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * The endpoint is anonymous, but a signed-in caller MAY present their token:
   * the request is then filed under an organisation they already belong to and
   * carries their identity, instead of provisioning a stranger account.
   */
  private async resolveOptionalUser(req: any) {
    const [type, token] = String(req?.headers?.authorization ?? '').split(' ');
    if (type !== 'Bearer' || !token) return null;
    try {
      const payload = await this.jwtService.verifyAsync(token);
      if (!payload?.sub) return null;
      return this.prisma.user.findFirst({
        where: { id: payload.sub, deletedAt: null, status: { not: 'DISABLED' } },
        select: { id: true, email: true, firstName: true, lastName: true },
      });
    } catch {
      return null;
    }
  }

  /**
   * US-1.1: a visitor submits a request without an account. We provision the
   * visitor identity + client organisation and open a SUBMITTED case in the
   * internal hub so staff can triage it immediately.
   */
  @Public()
  @Post('public/requests')
  @HttpCode(201)
  async submitRequest(@Body() body: any, @Req() req: any) {
    // Honeypot: bots filling this invisible field are silently dropped.
    if (body?.website) return { received: true };

    const authedUser = await this.resolveOptionalUser(req);

    const errors: Array<{ field: string; message: string }> = [];
    for (const f of ['firstName', 'lastName', 'email', 'message']) {
      if (!body?.[f] || typeof body[f] !== 'string' || !body[f].trim()) {
        errors.push({ field: f, message: `${f} is required` });
      }
    }
    if (body?.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) {
      errors.push({ field: 'email', message: 'Must be a valid email address' });
    }
    const requestType: RequestType = REQUEST_TYPES.includes(body?.requestType)
      ? body.requestType
      : 'OTHER';
    if (errors.length) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', fieldErrors: errors });
    }

    const email = authedUser ? authedUser.email : String(body.email).trim().toLowerCase();
    const caseType = await this.prisma.caseType.findUnique({
      where: { code: requestType === 'OTHER' ? 'GENERAL_ENQUIRY' : requestType },
    });
    const internal = await this.prisma.organization.findFirst({ where: { type: 'INTERNAL' } });
    if (!caseType || !internal) {
      throw new BadRequestException({ code: 'INTAKE_UNAVAILABLE' });
    }

    const result = await this.prisma.$transaction(async (tx) => {
      let user = authedUser
        ? await tx.user.findUnique({ where: { id: authedUser.id } })
        : await tx.user.findUnique({ where: { email } });
      if (!user) {
        user = await tx.user.create({
          data: {
            email,
            firstName: String(body.firstName).trim(),
            lastName: String(body.lastName).trim(),
            phone: body.phone ? String(body.phone).trim() : null,
            status: 'INVITED',
          },
        });
      }

      let org: { id: string } | null = null;
      if (authedUser) {
        // Known caller: file under a client organisation they already belong to.
        const membership = await tx.membership.findFirst({
          where: {
            userId: user.id,
            deletedAt: null,
            organization: { type: 'CLIENT', deletedAt: null },
          },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
          select: { organizationId: true },
        });
        org = membership ? { id: membership.organizationId } : null;
      }
      if (!org) {
        const legalName = body.organizationName?.trim() || `${user.firstName} ${user.lastName}`;
        org = await tx.organization.findFirst({
          where: { legalName, type: 'CLIENT', deletedAt: null },
        });
        if (!org) {
          org = await tx.organization.create({
            data: { legalName, type: 'CLIENT', status: 'PENDING', country: 'RW' },
          });
        }
        const visitorRole = await tx.role.findFirst({
          where: { organizationId: null, code: 'Visitor' },
        });
        if (visitorRole) {
          await tx.membership.upsert({
            where: { userId_organizationId: { userId: user.id, organizationId: org.id } },
            update: {},
            create: {
              userId: user.id,
              organizationId: org.id,
              roleId: visitorRole.id,
              // Only claim default for a brand-new account; existing members
              // keep whichever organisation they already consider home.
              isDefault: !authedUser,
            },
          });
        }
      }

      const reference = `REQ-${Date.now().toString(36).toUpperCase()}`;
      const slaDueAt = caseType.slaHours
        ? new Date(Date.now() + caseType.slaHours * 3_600_000)
        : null;
      const kase = await tx.case.create({
        data: {
          reference,
          organizationId: internal.id,
          clientOrgId: org.id,
          caseTypeId: caseType.id,
          subject: `[Web request] ${body.organizationName?.trim() || `${user.firstName} ${user.lastName}`}`,
          description: String(body.message).slice(0, 5000),
          payload: {
            source: 'PUBLIC_FORM',
            requestType,
            phone: body.phone ?? null,
            submitterEmail: email,
            submittedByUserId: user.id,
            authenticatedSubmission: !!authedUser,
          },
          status: 'SUBMITTED',
          priority: 'NORMAL',
          createdBy: user.id,
          ownerUserId: user.id,
          submittedAt: new Date(),
          slaDueAt,
        },
      });

      await tx.auditEvent.create({
        data: {
          actorUserId: user.id,
          organizationId: internal.id,
          action: 'PUBLIC_REQUEST_RECEIVED',
          resourceType: 'case',
          resourceId: kase.id,
          outcome: 'SUCCESS',
        },
      });

      return { caseId: kase.id, reference };
    });

    // Triage ping for hub staff (outside the tx — failures must not roll back intake).
    const staff = await this.prisma.membership.findMany({
      where: {
        organizationId: internal.id,
        deletedAt: null,
        role: { permissions: { hasSome: ['case.assign', '*'] } },
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    for (const s of staff.slice(0, 20)) {
      await this.notifications.notify({
        recipientId: s.userId,
        organizationId: internal.id,
        eventKey: 'case.submitted',
        variables: {
          reference: result.reference,
          subject: `[Web request] ${body.organizationName || body.email}`,
          submitter: `${body.firstName} ${body.lastName}`,
        },
        resourceType: 'case',
        resourceId: result.caseId,
      });
    }

    return { received: true, reference: result.reference };
  }
}

@Module({
  controllers: [PublicController],
})
export class PublicModule {}
