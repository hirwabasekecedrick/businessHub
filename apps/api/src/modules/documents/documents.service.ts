import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { UserContext } from '../../common/abilities/case-ability.service';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../../common/audit.service';

interface DownloadGrant {
  documentId: string;
  userId: string;
  expiresAt: number;
}

@Injectable()
export class DocumentsService {
  /** Single-use download grants (5 minutes); production would use storage signing. */
  private readonly grants = new Map<string, DownloadGrant>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  requirePermission(ctx: UserContext, permission: string) {
    if (!ctx.permissions?.includes(permission) && !ctx.permissions?.includes('*')) {
      throw new ForbiddenException({ code: 'PERMISSION_DENIED', required: permission });
    }
  }

  private scopeToClientOrg(ctx: UserContext): string | undefined {
    return ['Client', 'Visitor'].includes(ctx.roleCode ?? '') ? ctx.organizationId : undefined;
  }

  async getDocuments(ctx: UserContext, filters: { caseId?: string }) {
    const scopedOrg = this.scopeToClientOrg(ctx);
    if (!scopedOrg) this.requirePermission(ctx, 'document.read');
    return this.prisma.document.findMany({
      where: {
        deletedAt: null,
        ...(scopedOrg ? { organizationId: scopedOrg } : {}),
        ...(filters.caseId ? { caseId: filters.caseId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * FR-5.1 / US-5.1: two-phase upload; session tracked as a Job so it survives
   * restarts. Mock AV engine flags EICAR test files INFECTED.
   */
  async createUploadSession(ctx: UserContext, data: any) {
    const kase = await this.prisma.case.findUnique({ where: { id: data.caseId } });
    if (!kase || kase.deletedAt) throw new NotFoundException({ code: 'CASE_NOT_FOUND' });
    const scopedOrg = this.scopeToClientOrg(ctx);
    if (scopedOrg && kase.clientOrgId !== scopedOrg) {
      throw new ForbiddenException({ code: 'PERMISSION_DENIED' });
    }
    this.requirePermission(ctx, 'document.upload');

    const scanStatus = String(data.filename || '').toLowerCase().includes('eicar') ? 'INFECTED' : 'CLEAN';
    const session = await this.prisma.job.create({
      data: {
        organizationId: kase.organizationId,
        type: 'DOCUMENT_UPLOAD',
        status: 'RUNNING',
        createdBy: ctx.id,
        params: {
          caseId: data.caseId,
          filename: data.filename,
          mimeType: data.mimeType,
          sizeBytes: String(data.sizeBytes ?? '0'),
          checksumSha256: data.checksumSha256 ?? crypto.randomBytes(32).toString('hex'),
          category: data.category ?? null,
          expiresAt: data.expiresAt ?? undefined,
          scanStatus,
        },
      },
    });
    return {
      sessionId: session.id,
      uploadUrl: `mock://storage/upload/${session.id}`,
      scanStatus,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
  }

  async completeUploadSession(ctx: UserContext, sessionId: string) {
    const session = await this.prisma.job.findUnique({ where: { id: sessionId } });
    if (!session || session.type !== 'DOCUMENT_UPLOAD') throw new NotFoundException({ code: 'SESSION_NOT_FOUND' });
    if (session.status === 'DONE') throw new UnprocessableEntityException({ code: 'ALREADY_COMPLETED', sessionId });
    if (((session.params as any) as any)?.scanStatus === 'INFECTED') {
      await this.prisma.job.update({ where: { id: sessionId }, data: { status: 'FAILED', error: 'MALWARE_DETECTED' } });
      throw new UnprocessableEntityException({
        code: 'MALWARE_DETECTED',
        message: 'The file failed the antivirus scan and was rejected',
      });
    }
    const p = (session.params as any) as any;
    const document = await this.prisma.document.create({
      data: {
        organizationId: session.organizationId!,
        caseId: p.caseId,
        filename: p.filename,
        mimeType: p.mimeType ?? 'application/octet-stream',
        sizeBytes: BigInt(p.sizeBytes ?? '0'),
        checksumSha256: p.checksumSha256,
        storageKey: `${session.organizationId}/${session.id}/${p.filename}`,
        category: p.category,
        expiresAt: p.expiresAt ? new Date(p.expiresAt) : null,
        scanStatus: p.scanStatus,
        uploadedById: session.createdBy!,
      },
    });
    await this.prisma.job.update({
      where: { id: sessionId },
      data: { status: 'DONE', completedAt: new Date(), result: { documentId: document.id } },
    });
    await this.audit.record({
      actorUserId: ctx.id,
      organizationId: session.organizationId,
      action: 'DOCUMENT_UPLOADED',
      resourceType: 'document',
      resourceId: document.id,
      after: { filename: document.filename, caseId: document.caseId },
    });
    return document;
  }

  async getDownloadUrl(ctx: UserContext, id: string) {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    const scopedOrg = this.scopeToClientOrg(ctx);
    // FR-5.2 / US-5.3: CONFIDENTIAL docs are invisible (404, never 403) without
    // document.read.confidential — a 403 would confirm existence.
    const confidentialHidden =
      !scopedOrg &&
      doc?.classification === 'CONFIDENTIAL' &&
      !ctx.permissions.includes('document.classify') &&
      !ctx.permissions.includes('*');
    if (!doc || doc.deletedAt || (scopedOrg && doc.organizationId !== scopedOrg) || confidentialHidden) {
      throw new NotFoundException({ code: 'NOT_FOUND' });
    }
    if (!ctx.permissions.includes('document.read') && !ctx.permissions.includes('*')) {
      throw new ForbiddenException({ code: 'PERMISSION_DENIED', required: 'document.read' });
    }
    const token = crypto.randomBytes(24).toString('base64url');
    this.grants.set(token, { documentId: id, userId: ctx.id, expiresAt: Date.now() + 5 * 60 * 1000 });
    await this.audit.record({
      actorUserId: ctx.id,
      action: 'DOCUMENT_DOWNLOAD_REQUESTED',
      resourceType: 'document',
      resourceId: id,
    });
    return { url: `/v1/documents/${id}/download?token=${token}`, expiresIn: 300, note: 'Single-use URL' };
  }

  consumeGrant(token: string): DownloadGrant | null {
    const grant = this.grants.get(token);
    if (!grant) return null;
    this.grants.delete(token);
    return grant.expiresAt < Date.now() ? null : grant;
  }

  async downloadByGrant(id: string, token: string) {
    const grant = this.consumeGrant(token);
    if (!grant || grant.documentId !== id) {
      throw new UnauthorizedException({ code: 'INVALID_OR_USED_TOKEN' });
    }
    return this.prisma.document.findUnique({ where: { id } });
  }

  async updateDocument(ctx: UserContext, id: string, data: any) {
    this.requirePermission(ctx, 'document.update');
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc || doc.deletedAt) throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND' });
    return this.prisma.document.update({
      where: { id },
      data: {
        classification: data.classification,
        category: data.category,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
      },
    });
  }

  /** US-5.2: new version chains onto parentId, increments version, keeps history. */
  async uploadNewVersion(ctx: UserContext, id: string, data: any) {
    this.requirePermission(ctx, 'document.upload');
    const parent = await this.prisma.document.findUnique({ where: { id } });
    if (!parent || parent.deletedAt) throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND' });
    const latest = await this.prisma.document.findFirst({
      where: { OR: [{ id }, { parentId: id }], deletedAt: null },
      orderBy: { version: 'desc' },
    });
    const created = await this.prisma.document.create({
      data: {
        organizationId: parent.organizationId,
        caseId: parent.caseId,
        parentId: id,
        version: (latest?.version ?? parent.version) + 1,
        filename: data.filename ?? parent.filename,
        mimeType: data.mimeType ?? parent.mimeType,
        sizeBytes: BigInt(String(data.sizeBytes ?? parent.sizeBytes)),
        checksumSha256: data.checksumSha256 ?? crypto.randomBytes(32).toString('hex'),
        storageKey: `${parent.organizationId}/${crypto.randomUUID()}/${data.filename ?? parent.filename}`,
        classification: parent.classification,
        category: parent.category,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : parent.expiresAt,
        scanStatus: 'CLEAN',
        uploadedById: ctx.id,
      },
    });
    await this.audit.record({
      actorUserId: ctx.id,
      action: 'DOC_VERSION_CREATED',
      resourceType: 'document',
      resourceId: created.id,
      before: { version: latest?.version ?? parent.version },
      after: { version: created.version },
    });
    return created;
  }

  async getVersions(ctx: UserContext, id: string) {
    const parent = await this.prisma.document.findUnique({ where: { id } });
    if (!parent) throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND' });
    return this.prisma.document.findMany({
      where: { OR: [{ id }, { parentId: id }] },
      orderBy: { version: 'asc' },
      select: { id: true, version: true, filename: true, createdAt: true, uploadedById: true },
    });
  }

  /** Logical delete only — documents are never hard-deleted (audit trail). */
  async deleteDocument(ctx: UserContext, id: string) {
    this.requirePermission(ctx, 'document.delete');
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc || doc.deletedAt) throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND' });
    await this.prisma.document.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.record({
      actorUserId: ctx.id,
      action: 'DOC_DELETED',
      resourceType: 'document',
      resourceId: id,
      before: { filename: doc.filename },
    });
    return { message: 'Document logically deleted' };
  }

  // ---------- E-SIGNATURES (mocked provider) ----------

  /** FR-5.3: request signatures on a document version; provider mocked. */
  async createSignatureRequest(ctx: UserContext, documentId: string, data: any) {
    this.requirePermission(ctx, 'document.upload');
    const doc = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!doc || doc.deletedAt) throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND' });
    const signers = Array.isArray(data.signers) ? data.signers : [];
    if (!signers.length) {
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED', rule: 'signers_required' });
    }
    const req = await this.prisma.signatureRequest.create({
      data: {
        documentId,
        provider: 'mock-esign',
        providerRef: crypto.randomUUID(),
        signers,
        status: 'SENT',
      },
    });
    await this.audit.record({
      actorUserId: ctx.id,
      action: 'ESIGN_REQUESTED',
      resourceType: 'signature_request',
      resourceId: req.id,
      after: { documentId, signers },
    });
    return req;
  }

  async getSignatureRequest(ctx: UserContext, id: string) {
    return this.prisma.signatureRequest.findUnique({ where: { id } });
  }

  /** Webhook from the e-sign provider; HMAC-SHA256 over the raw body required. */
  verifyEsignSignature(rawBody: Buffer | string, signature: string | undefined): boolean {
    const secret = process.env.ESIGN_WEBHOOK_SECRET || 'dev-esign-secret';
    const expected = crypto.createHmac('sha256', secret).update(rawBody as any).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature ?? '', 'utf8'));
    } catch {
      return false;
    }
  }

  async esignWebhook(data: any) {
    const ref = data?.providerRef ?? data?.provider_ref;
    if (!ref) throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED', rule: 'providerRef_required' });
    const req = await this.prisma.signatureRequest.findFirst({ where: { providerRef: ref } });
    if (!req) throw new NotFoundException({ code: 'SIGNATURE_REQUEST_NOT_FOUND' });
    const status = String(data.status ?? '').toUpperCase();
    if (status === 'COMPLETED') {
      const updated = await this.prisma.signatureRequest.update({
        where: { id: req.id },
        data: { status: 'COMPLETED', completedAt: new Date(), evidenceKey: data.evidenceKey ?? null },
      });
      await this.audit.record({
        actorUserId: undefined,
        action: 'ESIGN_COMPLETED',
        resourceType: 'signature_request',
        resourceId: req.id,
      });
      return updated;
    }
    return this.prisma.signatureRequest.update({ where: { id: req.id }, data: { status: status || 'SENT' } });
  }
}
