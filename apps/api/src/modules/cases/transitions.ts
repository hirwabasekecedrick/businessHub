import { CaseStatus } from '@prisma/client';

export interface TransitionRule {
  from: CaseStatus | 'ANY_ACTIVE';
  to: CaseStatus;
  permission: string;
  guardCondition: string; // descriptive for now, will map to validation logic in service
  sideEffects: string[];
  reasonMandatory?: boolean;
}

export const caseTransitions: TransitionRule[] = [
  {
    from: CaseStatus.DRAFT,
    to: CaseStatus.SUBMITTED,
    permission: 'case.create',
    guardCondition: 'All required fields and document categories supplied',
    sideEffects: [
      'Reference issued',
      'SLA clock starts',
      'Acknowledgement sent',
    ],
  },
  {
    from: CaseStatus.SUBMITTED,
    to: CaseStatus.QUALIFIED,
    permission: 'case.update',
    guardCondition: 'Case type and priority set',
    sideEffects: ['SLA recomputed for the confirmed type'],
  },
  {
    from: CaseStatus.SUBMITTED,
    to: CaseStatus.REJECTED,
    permission: 'case.transition',
    guardCondition: 'Reason mandatory',
    reasonMandatory: true,
    sideEffects: ['Client notified with the reason', 'Terminal'],
  },
  {
    from: CaseStatus.QUALIFIED,
    to: CaseStatus.ASSIGNED,
    permission: 'case.assign',
    guardCondition: 'Owner is an active member with the required role',
    sideEffects: ['Process template instantiated', 'Owner notified'],
  },
  {
    from: CaseStatus.ASSIGNED,
    to: CaseStatus.IN_PROGRESS,
    permission: 'case.transition',
    guardCondition: 'Owner has started at least one task',
    sideEffects: ['First-response timestamp recorded'],
  },
  {
    from: CaseStatus.IN_PROGRESS,
    to: CaseStatus.AWAITING_INFO,
    permission: 'case.transition',
    guardCondition: 'A request to the client names what is needed',
    sideEffects: ['SLA paused', 'Client notified with a deadline'],
  },
  {
    from: CaseStatus.AWAITING_INFO,
    to: CaseStatus.IN_PROGRESS,
    permission: 'case.transition',
    guardCondition: 'Requested items supplied, or the agent resumes manually',
    sideEffects: ['SLA resumed', 'Paused interval added to sla_paused_ms'],
  },
  {
    from: CaseStatus.IN_PROGRESS,
    to: CaseStatus.ON_HOLD,
    permission: 'case.transition',
    guardCondition: 'Reason mandatory',
    reasonMandatory: true,
    sideEffects: ['SLA paused', 'Escalation rules suspended'],
  },
  {
    from: CaseStatus.ON_HOLD,
    to: CaseStatus.IN_PROGRESS,
    permission: 'case.transition',
    guardCondition: 'None',
    sideEffects: ['SLA resumed'],
  },
  {
    from: CaseStatus.IN_PROGRESS,
    to: CaseStatus.IN_REVIEW,
    permission: 'case.transition',
    guardCondition: 'All mandatory tasks complete',
    sideEffects: ['Approval chain opened at level 1'],
  },
  {
    from: CaseStatus.IN_REVIEW,
    to: CaseStatus.APPROVED,
    permission: 'approval.decide',
    guardCondition: 'Every approval level approved',
    sideEffects: ['Case ready for delivery', 'Requester notified'],
  },
  {
    from: CaseStatus.IN_REVIEW,
    to: CaseStatus.REJECTED,
    permission: 'approval.decide',
    guardCondition: 'Any level rejects; reason mandatory',
    reasonMandatory: true,
    sideEffects: ['Remaining levels cancelled', 'Requester notified'],
  },
  {
    from: 'ANY_ACTIVE',
    to: CaseStatus.ESCALATED,
    permission: 'case.transition or system',
    guardCondition: 'SLA breach, block, or manual escalation with a reason',
    sideEffects: [
      'Priority raised one step',
      'Manager notified',
      'Appears in escalation panel',
    ],
  },
  {
    from: CaseStatus.ESCALATED,
    to: CaseStatus.IN_PROGRESS,
    permission: 'case.transition',
    guardCondition: 'Blocking cause resolved',
    sideEffects: ['Escalation closed with an outcome note'],
  },
  {
    from: CaseStatus.APPROVED,
    to: CaseStatus.RESOLVED,
    permission: 'case.transition',
    guardCondition: 'Deliverable attached or outcome recorded',
    sideEffects: ['Client notified', 'Satisfaction survey queued'],
  },
  {
    from: CaseStatus.RESOLVED,
    to: CaseStatus.CLOSED,
    permission: 'case.close',
    guardCondition: 'No open task, no unpaid mandatory invoice',
    sideEffects: ['Case becomes read-only', 'SLA metrics frozen'],
  },
  {
    from: CaseStatus.CLOSED,
    to: CaseStatus.IN_PROGRESS,
    permission: 'case.reopen',
    guardCondition: 'Within 30 days; reason mandatory',
    reasonMandatory: true,
    sideEffects: ['New shortened SLA', 'Owner and client notified'],
  },
  {
    from: CaseStatus.CLOSED,
    to: CaseStatus.ARCHIVED,
    permission: 'system',
    guardCondition: 'Retention period elapsed',
    sideEffects: ['Moved to cold storage', 'Documents purged per policy'],
  },
];

export function getTransition(
  fromStatus: CaseStatus,
  toStatus: CaseStatus,
): TransitionRule | undefined {
  const activeStatuses: CaseStatus[] = [
    CaseStatus.DRAFT,
    CaseStatus.SUBMITTED,
    CaseStatus.QUALIFIED,
    CaseStatus.ASSIGNED,
    CaseStatus.IN_PROGRESS,
    CaseStatus.AWAITING_INFO,
    CaseStatus.ON_HOLD,
    CaseStatus.IN_REVIEW,
    CaseStatus.ESCALATED,
    CaseStatus.APPROVED,
  ];
  const isAnyActive = activeStatuses.includes(fromStatus);

  return caseTransitions.find(
    (rule) =>
      (rule.from === fromStatus ||
        (rule.from === 'ANY_ACTIVE' && isAnyActive)) &&
      rule.to === toStatus,
  );
}
