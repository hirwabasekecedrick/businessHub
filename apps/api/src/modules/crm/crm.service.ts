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
import { NotificationService } from '../../common/notification.service';
import * as crypto from 'crypto';

@Injectable()
export class CrmService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
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

    // US-2.3: the persisted compliance status maintained by the sweep.
    const persistedStatus = org.complianceStatus;

    // US-2.2: the transactions panel is for internal finance handlers.
    // Clients hold finance.read solely to view/pay their own invoices, which
    // must not unlock org-wide transaction data inside a CRM 360 payload.
    const internalFinancePerms = ['invoice.create', 'invoice.issue', 'payment.record', 'finance.reconcile'];
    const canSeeFinance =
      ctx.permissions.includes('*') || internalFinancePerms.some((p) => ctx.permissions.includes(p));

    return {
      organisation: org,
      cases,
      documents: documents.length,
      contacts,
      compliance: { checklist, atRisk, status: persistedStatus },
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

  /**
   * US-2.3 / FR-2.5: expiring documents are surfaced before they lapse.
   *
   * - A CLEAN document expiring within 30 days creates an open DOC_EXPIRY task
   *   for the account manager and notifies them once per document.
   * - An expiry date that passes with no valid replacement flips the
   *   organisation's persisted complianceStatus to AT_RISK (one notification
   *   per lapse episode) so the daily digest can carry it.
   * - Uploading a valid replacement restores COMPLIANT, closes the follow-up
   *   tasks whose category is valid again and notifies the managers.
   *
   * Idempotent: safe to call repeatedly; nothing fires twice for the same state.
   */
  async sweepCompliance(ctx: UserContext) {
    this.requirePermission(ctx, 'crm.read');
    const caseTypes = await this.prisma.caseType.findMany({ where: { isActive: true } });
    const requiredCats = Array.from(new Set(caseTypes.flatMap((ct) => ct.requiredDocs)));
    const now = new Date();
    const soon = new Date(now.getTime() + 30 * 24 * 3600 * 1000);

    const orgs = await this.prisma.organization.findMany({
      where: { deletedAt: null, type: { in: ['CLIENT', 'PARTNER'] } },
    });

    const summary = {
      sweptAt: now.toISOString(),
      organisationsChecked: orgs.length,
      expiryTasksCreated: 0,
      expiringNotified: 0,
      flaggedAtRisk: [] as Array<{ organizationId: string; categories: string[] }>,
      restored: [] as string[],
    };

    for (const org of orgs) {
      // Documents belong to the OWNING organisation of their case; a client's
      // paperwork is therefore reachable either directly or through its cases.
      const docs = await this.prisma.document.findMany({
        where: {
          deletedAt: null,
          scanStatus: 'CLEAN',
          OR: [{ organizationId: org.id }, { case: { clientOrgId: org.id } }],
        },
        include: { case: { select: { organizationId: true } } },
      });
      const managerIds = await this.resolveManagerIds(org.id, org.ownerUserId);
      const categoryValid = (cat: string | null) =>
        !!cat && docs.some((d) => d.category === cat && (!d.expiresAt || d.expiresAt > now));

      // 1. 30-day warnings — one open task + one notification per document.
      for (const doc of docs.filter((d) => d.expiresAt && d.expiresAt > now && d.expiresAt <= soon)) {
        // Follow-up work is actioned by the internal team that owns the case;
        // documents attached directly to an organisation keep that org as owner.
        const taskOrgId = doc.case?.organizationId ?? org.id;
        if (managerIds.length) {
          const watchKey = JSON.stringify({ docExpiryWatch: doc.id });
          const openTask = await this.prisma.task.findFirst({
            where: {
              organizationId: taskOrgId,
              type: 'DOC_EXPIRY',
              status: { in: ['OPEN', 'IN_PROGRESS', 'BLOCKED'] },
              description: watchKey,
            },
          });
          if (!openTask) {
            await this.prisma.task.create({
              data: {
                organizationId: taskOrgId,
                caseId: doc.case ? doc.caseId : null,
                type: 'DOC_EXPIRY',
                title: `Document expiring within 30 days: ${doc.filename}`,
                description: watchKey,
                assigneeUserId: managerIds[0],
                dueAt: doc.expiresAt,
              },
            });
            summary.expiryTasksCreated++;
          }
        }
        const already = await this.prisma.notification.findFirst({
          where: { templateCode: 'DOCUMENTS_EXPIRING', resourceType: 'document', resourceId: doc.id },
        });
        if (!already && managerIds.length) {
          summary.expiringNotified++;
          for (const mgr of managerIds) {
            await this.notifications.notify({
              recipientId: mgr,
              organizationId: org.id,
              eventKey: 'DOCUMENTS_EXPIRING',
              resourceType: 'document',
              resourceId: doc.id,
              variables: {
                filename: doc.filename,
                expiresOn: doc.expiresAt!.toISOString().slice(0, 10),
                organisation: org.legalName,
              },
            });
          }
        }
      }

      // 2. Lapse detection: a required category whose latest evidence has expired
      //    with no valid replacement puts the organisation AT_RISK.
      const lapsedCats = Array.from(
        new Set(
          docs.filter((d) => d.category && d.expiresAt && d.expiresAt <= now).map((d) => d.category!),
        ),
      ).filter((cat) => !categoryValid(cat));

      if (lapsedCats.length > 0) {
        if (org.complianceStatus !== 'AT_RISK') {
          await this.prisma.organization.update({
            where: { id: org.id },
            data: { complianceStatus: 'AT_RISK' },
          });
          summary.flaggedAtRisk.push({ organizationId: org.id, categories: lapsedCats });
        }
        if (managerIds.length) {
          const signature = lapsedCats.slice().sort().join(',');
          const already = await this.prisma.notification.findFirst({
            where: {
              templateCode: 'COMPLIANCE_AT_RISK',
              resourceType: 'organization',
              resourceId: org.id,
              payload: { path: ['catsSignature'], equals: signature },
            },
          });
          if (!already) {
            for (const mgr of managerIds) {
              await this.notifications.notify({
                recipientId: mgr,
                organizationId: org.id,
                eventKey: 'COMPLIANCE_AT_RISK',
                urgent: true,
                resourceType: 'organization',
                resourceId: org.id,
                variables: { organisation: org.legalName, categories: lapsedCats.join(', ') },
                payloadExtras: { catsSignature: signature, batchedDigest: false },
              });
            }
          }
        }
      } else if (org.complianceStatus === 'AT_RISK') {
        // 3. Recovery: every previously lapsed category now has valid evidence.
        await this.prisma.organization.update({
          where: { id: org.id },
          data: { complianceStatus: 'COMPLIANT' },
        });
        summary.restored.push(org.id);
        if (managerIds.length) {
          for (const mgr of managerIds) {
            await this.notifications.notify({
              recipientId: mgr,
              organizationId: org.id,
              eventKey: 'COMPLIANCE_RESTORED',
              resourceType: 'organization',
              resourceId: org.id,
              variables: { organisation: org.legalName },
            });
          }
        }
      }

      // 4. Close follow-up tasks whose watched document is no longer a concern:
      //    deleted, replaced by a valid category-mate, or pushed beyond the window.
      const watchKeys = docs
        .filter((d) => d.expiresAt)
        .map((d) => JSON.stringify({ docExpiryWatch: d.id }));
      if (watchKeys.length) {
        const openTasks = await this.prisma.task.findMany({
          where: {
            type: 'DOC_EXPIRY',
            status: { in: ['OPEN', 'IN_PROGRESS', 'BLOCKED'] },
            description: { in: watchKeys },
          },
        });
        for (const task of openTasks) {
          let docId: string | undefined;
          try {
            docId = JSON.parse(task.description ?? '{}').docExpiryWatch;
          } catch {
            continue;
          }
          if (!docId) continue;
          const doc = docs.find((d) => d.id === docId);
          const resolved =
            !doc ||
            (doc.expiresAt && doc.expiresAt <= now && categoryValid(doc.category)) ||
            (doc.expiresAt && doc.expiresAt > soon);
          if (resolved) {
            await this.prisma.task.update({
              where: { id: task.id },
              data: { status: 'DONE', completedAt: new Date() },
            });
          }
        }
      }
    }
    return summary;
  }

  private async resolveManagerIds(organizationId: string, ownerUserId: string | null): Promise<string[]> {
    if (ownerUserId) return [ownerUserId];
    const mgrs = await this.prisma.membership.findMany({
      where: {
        organizationId,
        deletedAt: null,
        role: { code: { in: ['Manager', 'Admin'] } },
      },
      select: { userId: true },
    });
    return mgrs.map((m) => m.userId);
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

  /**
   * FR-2.7: full-text search across organisations, contacts and cases.
   * Tenancy is enforced inside each query — a caller only ever sees results
   * their permissions already allow (staff see the book; clients and visitors
   * see their own organisations and cases).
   */
  async search(ctx: UserContext, q: string, limitParam?: number) {
    const term = String(q ?? '').trim();
    const limit = Math.min(Math.max(Number(limitParam) || 8, 1), 25);
    const empty = { q: term, facets: { organisations: 0, contacts: 0, cases: 0 }, organisations: [], contacts: [], cases: [] };
    if (!term) return empty;

    const like = { contains: term, mode: 'insensitive' as const };
    const isStaff =
      ctx.permissions.includes('*') ||
      ctx.permissions.includes('crm.read') ||
      ctx.permissions.includes('case.read.org') ||
      ctx.permissions.includes('case.read.all');

    let organisationScope: any;
    let caseWhere: any;
    if (isStaff) {
      organisationScope = { type: { in: ['CLIENT', 'PARTNER'] }, deletedAt: null };
      caseWhere = { deletedAt: null, OR: [{ reference: like }, { subject: like }] };
    } else {
      const memberships = await this.prisma.membership.findMany({
        where: { userId: ctx.id, deletedAt: null },
        select: { organizationId: true },
      });
      const ids = memberships.map((m) => m.organizationId);
      organisationScope = { id: { in: ids }, deletedAt: null };
      caseWhere = {
        deletedAt: null,
        AND: [
          { OR: [{ reference: like }, { subject: like }] },
          {
            OR: [
              { ownerUserId: ctx.id },
              { createdBy: ctx.id },
              ...(ids.length ? [{ clientOrgId: { in: ids } }] : []),
            ],
          },
        ],
      };
    }
    // Callers with no read permission over any module get nothing back.
    const maySearch =
      isStaff || ctx.permissions.includes('case.read.own') || ctx.permissions.includes('crm.read');
    if (!maySearch) return empty;

    const contactWhere = {
      deletedAt: null,
      organization: organisationScope,
      OR: [{ firstName: like }, { lastName: like }, { email: like }],
    };

    const [organisations, contacts, cases, orgCount, contactCount, caseCount] = await Promise.all([
      this.prisma.organization.findMany({
        where: { ...organisationScope, OR: [{ legalName: like }, { tradingName: like }, { taxId: like }] },
        select: { id: true, legalName: true, tradingName: true, type: true, complianceStatus: true },
        take: limit,
      }),
      this.prisma.contact.findMany({
        where: contactWhere,
        select: { id: true, firstName: true, lastName: true, email: true, organizationId: true },
        take: limit,
      }),
      this.prisma.case.findMany({
        where: caseWhere,
        select: { id: true, reference: true, subject: true, status: true, clientOrgId: true },
        take: limit,
      }),
      this.prisma.organization.count({
        where: { ...organisationScope, OR: [{ legalName: like }, { tradingName: like }, { taxId: like }] },
      }),
      this.prisma.contact.count({ where: contactWhere }),
      this.prisma.case.count({ where: caseWhere }),
    ]);

    return {
      q: term,
      facets: { organisations: orgCount, contacts: contactCount, cases: caseCount },
      organisations,
      contacts,
      cases,
    };
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
