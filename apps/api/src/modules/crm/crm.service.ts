import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { UserContext } from '../../common/abilities/case-ability.service';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../../common/audit.service';
import * as crypto from 'crypto';

@Injectable()
export class CrmService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  requirePermission(ctx: UserContext, permission: string) {
    if (!ctx.permissions?.includes(permission) && !ctx.permissions?.includes('*')) {
      throw new ForbiddenException({ code: 'PERMISSION_DENIED', required: permission });
    }
  }

  /** US-2.1: duplicate detection on tax id (blocking) and legal-name similarity (warning). */
  async createOrganisation(ctx: UserContext, data: any) {
    this.requirePermission(ctx, 'crm.create');
    if (data.taxId) {
      const exact = await this.prisma.organization.findFirst({
        where: { country: data.country ?? 'RW', taxId: data.taxId, deletedAt: null },
      });
      if (exact) {
        throw new ConflictException({
          code: 'DUPLICATE_TAX_ID',
          existingId: exact.id,
          legalName: exact.legalName,
        });
      }
    }
    const candidates: any[] = [];
    const all = await this.prisma.organization.findMany({ where: { deletedAt: null } });
    for (const org of all) {
      const sim = similarity(normalise(data.legalName), normalise(org.legalName));
      if (sim > 0.85) candidates.push({ id: org.id, legalName: org.legalName, similarity: Number(sim.toFixed(3)) });
    }
    const created = await this.prisma.organization.create({
      data: {
        type: data.type ?? 'CLIENT',
        status: 'ACTIVE',
        legalName: data.legalName,
        tradingName: data.tradingName,
        registrationNo: data.registrationNo,
        taxId: data.taxId,
        country: data.country ?? 'RW',
        settings: { duplicateWarningAcknowledgedBy: ctx.id },
      },
    });
    await this.audit.record({
      actorUserId: ctx.id,
      organizationId: created.id,
      action: 'ORGANISATION_CREATED',
      resourceType: 'organization',
      resourceId: created.id,
      after: { legalName: created.legalName, similarCandidates: candidates.map((c) => c.legalName) },
    });
    return {
      ...created,
      duplicateWarning: candidates.length
        ? { message: 'Similar records exist; confirm this is genuinely distinct', candidates }
        : null,
    };
  }

  async getClients(ctx: UserContext) {
    this.requirePermission(ctx, 'crm.read');
    return this.prisma.organization.findMany({
      where: { type: 'CLIENT', deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getPartners(ctx: UserContext) {
    this.requirePermission(ctx, 'crm.read');
    return this.prisma.organization.findMany({
      where: { type: 'PARTNER', deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** US-2.2: the 360 record in ONE request; finance panel omitted without permissions. */
  async getClientOverview(ctx: UserContext, id: string) {
    this.requirePermission(ctx, 'crm.read');
    const org = await this.prisma.organization.findUnique({ where: { id } });
    if (!org || org.deletedAt) throw new NotFoundException({ code: 'ORG_NOT_FOUND' });

    const [cases, documents, invoicesRaw, contacts] = await Promise.all([
      this.prisma.case.findMany({ where: { clientOrgId: id, deletedAt: null }, select: { reference: true, subject: true, status: true } }),
      this.prisma.document.findMany({ where: { organizationId: id, deletedAt: null }, select: { filename: true, category: true, expiresAt: true, scanStatus: true } }),
      this.prisma.invoice.findMany({ where: { clientOrgId: id }, select: { number: true, total: true, amountPaid: true, currency: true, status: true } }),
      this.prisma.contact.findMany({ where: { organizationId: id, deletedAt: null } }),
    ]);

    // Compliance checklist from required document categories and expiry dates.
    const caseTypes = await this.prisma.caseType.findMany({ where: { isActive: true } });
    const requiredCats = Array.from(new Set(caseTypes.flatMap((ct) => ct.requiredDocs)));
    const checklist = requiredCats.map((cat) => {
      const docs = documents.filter((d) => d.category === cat);
      const valid = docs.some(
        (d) => d.scanStatus === 'CLEAN' && (!d.expiresAt || d.expiresAt > new Date(Date.now() + 30 * 24 * 3600 * 1000)),
      );
      const expiring = docs.some(
        (d) => d.scanStatus === 'CLEAN' && d.expiresAt && d.expiresAt <= new Date(Date.now() + 30 * 24 * 3600 * 1000) && d.expiresAt > new Date(),
      );
      return { category: cat, valid, expiring };
    });
    const atRisk = checklist.some((c) => !c.valid);

    const canSeeFinance =
      ctx.permissions.includes('finance.read') || ctx.permissions.includes('*');

    return {
      organisation: org,
      cases,
      documents: documents.length,
      contacts,
      compliance: { checklist, atRisk },
      ...(canSeeFinance
        ? {
            invoices: invoicesRaw.map((i) => ({
              number: i.number,
              total: i.total,
              paid: i.amountPaid,
              balance: i.total.minus(i.amountPaid),
              currency: i.currency,
              status: i.status,
            })),
            outstandingTotal: invoicesRaw.reduce((acc, i) => acc.add(i.total.minus(i.amountPaid)), new Prisma.Decimal(0)).toString(),
          }
        : {}),
    };
  }

  async listContacts(ctx: UserContext, organizationId?: string) {
    this.requirePermission(ctx, 'crm.read');
    return this.prisma.contact.findMany({
      where: { deletedAt: null, ...(organizationId ? { organizationId } : {}) },
    });
  }

  async createContact(ctx: UserContext, data: any) {
    this.requirePermission(ctx, 'crm.create');
    return this.prisma.$transaction(async (tx) => {
      if (data.isPrimary) {
        await tx.contact.updateMany({ where: { organizationId: data.organizationId, isPrimary: true }, data: { isPrimary: false } });
      }
      return tx.contact.create({ data: { organizationId: data.organizationId, firstName: data.firstName, lastName: data.lastName, email: data.email, phone: data.phone, jobTitle: data.jobTitle, isPrimary: !!data.isPrimary } });
    });
  }

  async updateContact(ctx: UserContext, id: string, data: any) {
    this.requirePermission(ctx, 'crm.update');
    const contact = await this.prisma.contact.findUnique({ where: { id } });
    if (!contact || contact.deletedAt) throw new NotFoundException({ code: 'CONTACT_NOT_FOUND' });
    return this.prisma.$transaction(async (tx) => {
      if (data.isPrimary) {
        await tx.contact.updateMany({ where: { organizationId: contact.organizationId, isPrimary: true, id: { not: id } }, data: { isPrimary: false } });
      }
      return tx.contact.update({ where: { id }, data: { firstName: data.firstName, lastName: data.lastName, email: data.email, phone: data.phone, jobTitle: data.jobTitle, isPrimary: data.isPrimary ? true : undefined } });
    });
  }

  async deleteContact(ctx: UserContext, id: string) {
    this.requirePermission(ctx, 'crm.delete');
    await this.prisma.contact.update({ where: { id }, data: { deletedAt: new Date() } });
    return { message: 'Contact logically deleted' };
  }

  /** US-2.4 / FR-2.4: consents recorded with previous value, timestamp and actor. */
  async updateConsents(ctx: UserContext, id: string, consents: Record<string, boolean>) {
    this.requirePermission(ctx, 'crm.update');
    const contact = await this.prisma.contact.findUnique({ where: { id } });
    if (!contact || contact.deletedAt) throw new NotFoundException({ code: 'CONTACT_NOT_FOUND' });

    const current = (contact.consents as any) ?? {};
    const historyEntry = {
      at: new Date().toISOString(),
      actor: ctx.email ?? ctx.id,
      changes: Object.fromEntries(
        Object.entries(consents).map(([k, v]) => [k, { from: current[k] ?? null, to: v }]),
      ),
    };

    const updated = await this.prisma.contact.update({
      where: { id },
      data: {
        consents: {
          ...current,
          ...consents,
          history: [...(current.history ?? []), historyEntry],
        },
      },
    });
    await this.audit.record({
      actorUserId: ctx.id,
      action: 'CONSENT_UPDATED',
      resourceType: 'contact',
      resourceId: id,
      before: current,
      after: consents,
    });
    return updated;
  }

  /** FR-2.6: portal access creates user + membership in one action. */
  async grantPortalAccess(ctx: UserContext, contactId: string) {
    this.requirePermission(ctx, 'user.invite');
    const contact = await this.prisma.contact.findUnique({
      where: { id: contactId },
      include: { organization: true },
    });
    if (!contact || contact.deletedAt) throw new NotFoundException({ code: 'CONTACT_NOT_FOUND' });
    if (!contact.email) throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED', rule: 'email_required' });

    const clientRole = await this.prisma.role.findFirst({ where: { code: 'Client', organizationId: null } });
    let user = await this.prisma.user.findUnique({ where: { email: contact.email.toLowerCase() } });
    if (!user) {
      const tempPassword = crypto.randomBytes(9).toString('base64url'); // shared out-of-band in a real flow
      const passwordHash = await import('argon2').then((a) =>
        a.hash(tempPassword + (process.env.PASSWORD_PEPPER || ''), { type: a.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 }),
      );
      user = await this.prisma.user.create({
        data: {
          email: contact.email.toLowerCase(),
          passwordHash,
          firstName: contact.firstName,
          lastName: contact.lastName,
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
        },
      });
    }
    const membership = await this.prisma.membership.upsert({
      where: { userId_organizationId: { userId: user.id, organizationId: contact.organizationId } },
      update: { deletedAt: null },
      create: {
        userId: user!.id,
        organizationId: contact.organizationId,
        roleId: clientRole!.id,
        acceptedAt: new Date(),
      },
    });
    await this.audit.record({
      actorUserId: ctx.id,
      organizationId: contact.organizationId,
      action: 'PORTAL_ACCESS_GRANTED',
      resourceType: 'membership',
      resourceId: membership.id,
    });
    return { userId: user.id, organizationId: contact.organizationId, membershipId: membership.id };
  }

  /** US-2.5: segment filtering over organisation settings.tags. */
  async getSegments(ctx: UserContext, segment?: string) {
    this.requirePermission(ctx, 'crm.read');
    const orgs = await this.prisma.organization.findMany({
      where: { type: { in: ['CLIENT', 'PARTNER'] }, deletedAt: null },
    });
    if (!segment) return orgs;
    return orgs.filter((o) => ((o.settings as any)?.tags ?? []).includes(segment));
  }

  async exportCrm(ctx: UserContext) {
    this.requirePermission(ctx, 'crm.export');
    const orgs = await this.prisma.organization.findMany({ where: { type: { in: ['CLIENT', 'PARTNER'] }, deletedAt: null } });
    const csv = ['id,legal_name,type,country,tax_id', ...orgs.map((o) => `${o.id},"${o.legalName}",${o.type},${o.country},${o.taxId ?? ''}`)].join('\n');
    const job = await this.prisma.job.create({
      data: {
        organizationId: ctx.organizationId,
        type: 'CRM_EXPORT',
        status: 'DONE',
        completedAt: new Date(),
        createdBy: ctx.id,
        result: { csv },
      },
    });
    await this.audit.record({ actorUserId: ctx.id, action: 'EXPORT_CRM', resourceType: 'job', resourceId: job.id });
    return { jobId: job.id, csv };
  }
}

function normalise(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function similarity(a: string, b: string): number {
  // Jaro-like quick similarity; good enough for the warning heuristic.
  if (a === b) return 1;
  const maxDist = Math.max(a.length, b.length);
  let matches = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) matches++;
  }
  if (matches === 0) return 0;
  return matches / maxDist;
}
