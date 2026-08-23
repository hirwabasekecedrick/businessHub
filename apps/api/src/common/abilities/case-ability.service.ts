import { Injectable, ForbiddenException } from '@nestjs/common';
import { Case, CaseStatus } from '@prisma/client';

export interface UserContext {
  id: string;
  organizationId: string | undefined;
  permissions: string[];
  isImpersonating?: boolean;
  email?: string;
  roleCode?: string;
  approvalLevel?: number;
  memberships?: { organizationId: string; roleId: string; roleCode: string; isDefault: boolean }[];
}

@Injectable()
export class CaseAbilityService {
  /**
   * R-01 Tenant Check
   */
  checkTenant(context: UserContext, caseRecord: Case) {
    if (context.permissions.includes('case.read.all')) {
      return true; // Super-admin bypass
    }
    if (
      caseRecord.organizationId !== context.organizationId &&
      caseRecord.clientOrgId !== context.organizationId
    ) {
      throw new ForbiddenException('ORG_FORBIDDEN');
    }
    return true;
  }

  /**
   * R-02 Ownership Check
   * In a real implementation, we'd also check if the user is an assignee on a task.
   */
  checkOwnership(context: UserContext, caseRecord: Case) {
    if (
      context.permissions.includes('case.read.all') ||
      context.permissions.includes('case.read.org')
    ) {
      return true;
    }
    if (context.permissions.includes('case.read.own')) {
      if (
        caseRecord.ownerUserId === context.id ||
        caseRecord.createdBy === context.id
      ) {
        return true;
      }
      throw new ForbiddenException('PERMISSION_DENIED');
    }
    throw new ForbiddenException('PERMISSION_DENIED');
  }

  /**
   * R-07 Closed Records
   */
  checkNotClosedForMutation(caseRecord: Case, isReopen: boolean = false) {
    if (
      (caseRecord.status === CaseStatus.CLOSED ||
        caseRecord.status === CaseStatus.ARCHIVED) &&
      !isReopen
    ) {
      throw new ForbiddenException(
        'INVALID_TRANSITION',
        'Closed records cannot be mutated.',
      );
    }
  }

  /**
   * R-08 Impersonation
   */
  checkNotImpersonatingForWrite(context: UserContext) {
    if (context.isImpersonating) {
      throw new ForbiddenException(
        'PERMISSION_DENIED',
        'Writes disabled during impersonation.',
      );
    }
  }

  /**
   * Composite Read Check
   */
  canRead(context: UserContext, caseRecord: Case) {
    this.checkTenant(context, caseRecord);
    this.checkOwnership(context, caseRecord);
    return true;
  }

  /**
   * Composite Write Check
   */
  canWrite(context: UserContext, caseRecord: Case, isReopen: boolean = false) {
    this.checkNotImpersonatingForWrite(context);
    this.checkTenant(context, caseRecord);
    this.checkOwnership(context, caseRecord);
    this.checkNotClosedForMutation(caseRecord, isReopen);
    return true;
  }
}
