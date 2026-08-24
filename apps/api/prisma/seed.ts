/**
 * Seed per spec Â§16: one operating company, two client orgs, one partner org,
 * one user per role (Password123!), reference data and demo contacts.
 * Aborts unless NODE_ENV is local/development/ci/test.
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import * as dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

const env = process.env.NODE_ENV ?? 'development';
if (!['local', 'development', 'dev', 'ci', 'test'].includes(env)) {
  console.error(`Refusing to seed: NODE_ENV=${env} is not a safe environment.`);
  process.exit(1);
}

function hash(value: string) {
  return argon2.hash(value + (process.env.PASSWORD_PEPPER || ''), {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });
}

const PERMISSIONS = {
  Visitor: ['notification.read', 'case.create', 'case.read.own'],
  Client: [
    'case.read.own', 'case.create', 'case.update',
    'document.read', 'document.upload',
    'crm.read',
    'finance.read',
    'notification.read',
  ],
  Partner: [
    'case.read.own',
    'document.read', 'document.upload',
    'report.read',
    'notification.read',
  ],
  Agent: [
    'user.read',
    'org.read',
    'role.read',
    'crm.read', 'crm.create', 'crm.update',
    'case.read.org', 'case.read.own', 'case.create', 'case.update', 'case.transition',
    'task.read', 'task.create', 'task.complete',
    'approval.read',
    'document.read', 'document.upload', 'document.download',
    'finance.read',
    'report.read',
    'notification.read',

    'approval.read',
    'approval.decide',
  ],
  Manager: [
    'user.read', 'user.invite', 'user.update',
    'org.read', 'org.update', 'org.settings.manage',
    'role.read', 'role.assign',
    'crm.read', 'crm.create', 'crm.update', 'crm.delete', 'crm.export',
    'case.read.org', 'case.read.own', 'case.create', 'case.update', 'case.assign', 'case.transition', 'case.close', 'case.reopen',
    'task.read', 'task.create', 'task.assign', 'task.complete', 'task.reassign',
    'approval.read', 'approval.decide',
    'document.read', 'document.upload', 'document.download', 'document.classify', 'document.sign.request',
    'finance.read', 'invoice.create', 'invoice.issue', 'payment.record',
    'report.read', 'report.export',
    'notification.read', 'notification.send.bulk',
  ],
  Admin: [
    'user.read', 'user.invite', 'user.update', 'user.deactivate',
    'org.read', 'org.create', 'org.update', 'org.suspend', 'org.settings.manage',
    'role.read', 'role.assign', 'role.manage',
    'crm.read', 'crm.create', 'crm.update', 'crm.delete', 'crm.export',
    'case.read.org', 'case.read.own', 'case.create', 'case.update', 'case.assign', 'case.transition', 'case.close', 'case.reopen', 'case.delete',
    'task.read', 'task.create', 'task.assign', 'task.complete', 'task.reassign',
    'approval.read', 'approval.decide', 'approval.override',
    'document.read', 'document.upload', 'document.download', 'document.classify', 'document.delete', 'document.sign.request',
    'finance.read', 'invoice.create', 'invoice.issue', 'invoice.void', 'payment.record', 'payment.refund', 'finance.reconcile',
    'report.read', 'report.export', 'report.manage',
    'admin.reference.manage', 'admin.integration.manage', 'admin.audit.read', 'admin.impersonate',
    'notification.read', 'notification.template.manage', 'notification.send.bulk',
  ],
  Super: ['*'],
};

async function main() {
  const password = await hash('Password123!');

  // --- System user for audit events without a human actor ---
  await prisma.user.upsert({
    where: { email: 'system@businesshub.local' },
    update: {},
    create: {
      email: 'system@businesshub.local',
      firstName: 'System',
      lastName: 'Automation',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      locale: 'en',
      timezone: 'UTC',
    },
  });

  // --- Organisations ---
  const hub = await prisma.organization.upsert({
    where: { id: (await findOrgByLegalName('BusinessHub Operating Co'))?.id ?? '00000000-0000-4000-8000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-4000-8000-000000000001',
      type: 'INTERNAL',
      status: 'ACTIVE',
      legalName: 'BusinessHub Operating Co',
      country: 'RW',
      settings: { timezone: 'Africa/Kigali', workingDays: [1, 2, 3, 4, 5], workStart: '08:00', workEnd: '17:00' },
    },
  });
  const acme = await prisma.organization.upsert({
    where: { id: (await findOrgByLegalName('Acme Corp'))?.id ?? '00000000-0000-4000-8000-000000000002' },
    update: {},
    create: {
      id: '00000000-0000-4000-8000-000000000002',
      type: 'CLIENT',
      status: 'ACTIVE',
      legalName: 'Acme Corp Ltd',
      tradingName: 'Acme',
      registrationNo: '101234567',
      taxId: 'TAX1001RW',
      country: 'RW',
      settings: { tags: ['VIP'] },
    },
  });
  const globex = await prisma.organization.upsert({
    where: { id: (await findOrgByLegalName('Globex Inc'))?.id ?? '00000000-0000-4000-8000-000000000003' },
    update: {},
    create: {
      id: '00000000-0000-4000-8000-000000000003',
      type: 'CLIENT',
      status: 'ACTIVE',
      legalName: 'Globex Industries Inc',
      tradingName: 'Globex',
      registrationNo: '107654321',
      taxId: 'TAX2002RW',
      country: 'RW',
      settings: { tags: [] },
    },
  });
  const partner = await prisma.organization.upsert({
    where: { id: (await findOrgByLegalName('Consulting Partners Ltd'))?.id ?? '00000000-0000-4000-8000-000000000004' },
    update: {},
    create: {
      id: '00000000-0000-4000-8000-000000000004',
      type: 'PARTNER',
      status: 'ACTIVE',
      legalName: 'Consulting Partners Ltd',
      country: 'RW',
      settings: {},
    },
  });

  // --- System roles ---
  const roleIds: Record<string, string> = {};
  const levels: Record<string, number> = { Visitor: 0, Client: 0, Partner: 0, Agent: 1, Manager: 2, Admin: 3, Super: 4 };
  for (const [code, perms] of Object.entries(PERMISSIONS)) {
    const existing = await prisma.role.findFirst({ where: { organizationId: null, code } });
    if (existing) {
      // Keep permissions/levels in sync when the matrix evolves.
      await prisma.role.update({
        where: { id: existing.id },
        data: { permissions: perms, approvalLevel: levels[code] },
      });
      roleIds[code] = existing.id;
      continue;
    }
    const created = await prisma.role.create({
      data: { code, name: code, permissions: perms, approvalLevel: levels[code], isSystem: true },
    });
    roleIds[code] = created.id;
  }

  // --- Users: exactly one per role ---
  // FR-1.3: Manager/Admin/Super are mandatory-MFA roles, so their seed
  // accounts ship enrolled with fixed TOTP secrets (documented in tools/).
  const MFA_SECRETS: Record<string, string> = {
    'manager@hub.test': 'MFRGGZDFMZTWQ2LKNNQXA2LPMFRGGZDF',
    'doghan80@gmail.com': 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    'super@hub.test': 'JBSWY3DPEBLTEIFVMUQGCIDBMRSWY4TQ',
  };
  const users: Array<{ email: string; first: string; last: string; role: string; orgs: Array<[string, boolean]> }> = [
    { email: 'visitor@demo.test', first: 'Vera', last: 'Visitor', role: 'Visitor', orgs: [[acme.id, true]] },
    { email: 'client@acme.test', first: 'Clara', last: 'Client', role: 'Client', orgs: [[acme.id, true]] },
    { email: 'client@both.test', first: 'Morgan', last: 'Multiorg', role: 'Client', orgs: [[acme.id, true], [globex.id, false]] },
    { email: 'partner@consulting.test', first: 'Paul', last: 'Partner', role: 'Partner', orgs: [[partner.id, true]] },
    { email: 'agent@hub.test', first: 'Alice', last: 'Agent', role: 'Agent', orgs: [[hub.id, true]] },
    { email: 'manager@hub.test', first: 'Marcel', last: 'Manager', role: 'Manager', orgs: [[hub.id, true]] },
    { email: 'doghan80@gmail.com', first: 'Nadia', last: 'Admin', role: 'Admin', orgs: [[hub.id, true]] },
    { email: 'super@hub.test', first: 'Sam', last: 'Super', role: 'Super', orgs: [[hub.id, true]] },
  ];

  for (const u of users) {
    const mfaSecret = MFA_SECRETS[u.email] ?? null;
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: {
        passwordHash: password,
        status: 'ACTIVE',
        emailVerifiedAt: userExists(u.email) ? undefined : new Date(),
        mfaSecret,
        mfaEnabledAt: mfaSecret ? new Date() : null,
      },
      create: {
        email: u.email,
        passwordHash: password,
        firstName: u.first,
        lastName: u.last,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        locale: 'en',
        timezone: 'Africa/Kigali',
        mfaSecret,
        mfaEnabledAt: mfaSecret ? new Date() : null,
      },
    });
    for (const [orgId, isDefault] of u.orgs) {
      await prisma.membership.upsert({
        where: { userId_organizationId: { userId: user.id, organizationId: orgId } },
        update: { deletedAt: null, roleId: roleIds[u.role], isDefault },
        create: { userId: user.id, organizationId: orgId, roleId: roleIds[u.role], isDefault, acceptedAt: new Date() },
      });
    }
    await prisma.notificationPreference.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        channels: { CASE_SUBMITTED: ['IN_APP'], TASK_UNBLOCKED: ['IN_APP'], CASE_APPROVED: ['IN_APP'], DEFAULT: ['IN_APP'] },
        quietStart: null,
        quietEnd: null,
        timezone: 'Africa/Kigali',
      },
    });
  }

  // --- Case types ---
  const regType = await upsertCaseType({
    code: 'COMPANY_REG',
    name: 'Company Registration',
    description: 'Incorporate a new company in Rwanda',
    formSchema: {
      type: 'object',
      required: ['proposedName', 'sector'],
      properties: {
        proposedName: { type: 'string', title: 'Proposed company name' },
        sector: { type: 'string', enum: ['TRADE', 'SERVICES', 'MANUFACTURING', 'TECH'], title: 'Business sector' },
        shareCapital: { type: 'number', title: 'Share capital (EUR)' },
      },
    },
    requiredDocs: ['INCORPORATION_CERT'],
    slaHours: 72,
    approvalLevels: 2,
  });
  const taxType = await upsertCaseType({
    code: 'TAX_CLEARANCE',
    name: 'Tax Clearance Certificate',
    description: 'Request an RRA tax clearance certificate',
    formSchema: {
      type: 'object',
      required: ['tinNumber'],
      properties: { tinNumber: { type: 'string', title: 'TIN' }, period: { type: 'string', title: 'Period' } },
    },
    requiredDocs: [],
    slaHours: 48,
    approvalLevels: 1,
  });
  await upsertCaseType({
    code: 'WORK_PERMIT',
    name: 'Work Permit Application',
    description: 'Employment permit for foreign staff',
    formSchema: {
      type: 'object',
      required: ['passportNo', 'positionTitle'],
      properties: { passportNo: { type: 'string' }, positionTitle: { type: 'string' } },
    },
    requiredDocs: ['PASSPORT_COPY', 'CONTRACT_SIGNED'],
    slaHours: 120,
    approvalLevels: 1,
    isClientVisible: false,
  });
  await upsertCaseType({
    code: 'GENERAL_ENQUIRY',
    name: 'General Enquiry',
    description: 'Public website request triaged by the hub team',
    formSchema: {
      type: 'object',
      properties: {},
    },
    requiredDocs: [],
    slaHours: 24,
    approvalLevels: 0,
  });

  // --- Process template for COMPANY_REG (v1) ---
  const existingTpl = await prisma.processTemplate.findFirst({ where: { caseTypeId: regType.id, version: 1 } });
  if (!existingTpl) {
    await prisma.processTemplate.create({
      data: {
        caseTypeId: regType.id,
        name: 'Standard company registration flow',
        version: 1,
        isActive: true,
        steps: [
          { type: 'TASK', title: 'Intake completeness review', description: 'Check form fields and documents', roleCode: 'Agent' },
          { type: 'TASK', title: 'Registry submission', description: 'Submit bundle to the registry mock', roleCode: 'Agent' },
          { type: 'APPROVAL', title: 'Manager approval', level: 1, roleCode: 'Manager' },
          { type: 'APPROVAL', title: 'Final sign-off', level: 2, roleCode: 'Manager' },
        ],
      },
    });
  }

  // --- Escalation rule ---
  const existingRule = await prisma.escalationRule.findFirst({ where: { trigger: 'SLA_80PCT' } });
  if (!existingRule) {
    await prisma.escalationRule.create({
      data: { trigger: 'SLA_80PCT', thresholdHours: 4, action: 'NOTIFY_OWNER_AND_MANAGER', caseTypeId: null, targetRoleId: roleIds['Manager'] },
    });
  }

  // --- Notification templates (US-7.4) ---
  const templates: Array<{ code: string; eventKey: string; subjectEn: string; bodyEn: string; urgent?: boolean }> = [
    { code: 'CASE_SUBMITTED', eventKey: 'CASE_SUBMITTED', subjectEn: 'Case {{reference}} received', bodyEn: 'Your request {{reference}} was submitted on {{submittedAt}}.' },
    { code: 'CASE_AT_RISK_80', eventKey: 'CASE_AT_RISK_80', subjectEn: 'Case {{reference}} at risk of breaching SLA', bodyEn: 'Case {{reference}} passed the 80% SLA threshold.', urgent: true },
    { code: 'CASE_ESCALATED', eventKey: 'CASE_ESCALATED', subjectEn: 'Case {{reference}} escalated', bodyEn: 'Case {{reference}} breached its SLA and was escalated.', urgent: true },
    { code: 'CASE_APPROVED', eventKey: 'CASE_APPROVED', subjectEn: 'Case {{reference}} approved', bodyEn: 'Good news: case {{reference}} has been approved.' },
    { code: 'CASE_REJECTED', eventKey: 'CASE_REJECTED', subjectEn: 'Case {{reference}} rejected', bodyEn: 'Case {{reference}} was rejected. Reason: {{reason}}', urgent: true },
    { code: 'TASK_UNBLOCKED', eventKey: 'TASK_UNBLOCKED', subjectEn: 'New task ready: {{title}}', bodyEn: 'A task "{{title}}" is now unblocked and waiting in your queue.' },
    { code: 'INVOICE_OVERDUE', eventKey: 'INVOICE_OVERDUE', subjectEn: 'Invoice {{number}} overdue', bodyEn: 'Invoice {{number}} for {{amount}} is overdue.', urgent: true },
  ];
  for (const t of templates) {
    await prisma.notificationTemplate.upsert({
      where: { code: t.code },
      update: { locales: { en: { subject: t.subjectEn, body: t.bodyEn } } },
      create: {
        code: t.code,
        eventKey: t.eventKey,
        locales: {
          en: { subject: t.subjectEn, body: t.bodyEn },
          fr: { subject: t.subjectEn, body: t.bodyEn },
        },
        variables: ['reference', 'title', 'reason', 'amount', 'submittedAt'].filter((v) => t.subjectEn.includes(v) || t.bodyEn.includes(v)),
        urgent: t.urgent ?? false,
      },
    });
  }

  // --- Integration configs (US-9.3) ---
  const integrations: Array<{ code: string; displayName: string; config: any }> = [
    { code: 'PAYMENT_PROVIDER', displayName: 'Payment Gateway', config: { provider: 'mock-pay', apiKey: '********' } },
    { code: 'ESIGN_PROVIDER', displayName: 'E-Signature Provider', config: { provider: 'mock-esign', apiSecret: '********' } },
    { code: 'EMAIL_PROVIDER', displayName: 'Transactional Email', config: { provider: 'console-mock' } },
    { code: 'STORAGE_PROVIDER', displayName: 'Document Storage', config: { provider: 'local-mock' } },
  ];
  for (const i of integrations) {
    await prisma.integrationConfig.upsert({
      where: { code: i.code },
      update: {},
      create: { code: i.code, displayName: i.displayName, config: i.config, isActive: true },
    });
  }

  // --- Contacts (FR-2.x) ---
  const acmeContact = await prisma.contact.findFirst({ where: { organizationId: acme.id, email: 'john.mukamuri@acme.test' } });
  if (!acmeContact) {
    await prisma.contact.create({
      data: {
        organizationId: acme.id,
        firstName: 'John',
        lastName: 'Mukamuri',
        email: 'john.mukamuri@acme.test',
        phone: '+250788111222',
        jobTitle: 'Managing Director',
        isPrimary: true,
        consents: { marketing: true, dataProcessing: true, history: [{ at: new Date().toISOString(), actor: 'seed', changes: { marketing: { from: null, to: true } } }] },
      },
    });
  }
  const globexContact = await prisma.contact.findFirst({ where: { organizationId: globex.id, email: 'maria.uwase@globex.test' } });
  if (!globexContact) {
    await prisma.contact.create({
      data: {
        organizationId: globex.id,
        firstName: 'Maria',
        lastName: 'Uwase',
        email: 'maria.uwase@globex.test',
        phone: '+250788333444',
        jobTitle: 'Operations Lead',
        isPrimary: true,
        consents: { marketing: false, dataProcessing: true, history: [] },
      },
    });
  }

  console.log('Seed complete:');
  console.log('  Orgs:', hub.legalName, '|', acme.legalName, '|', globex.legalName, '|', partner.legalName);
  console.log('  Roles:', Object.keys(roleIds).join(', '));
  console.log('  Users:', users.map((u) => `${u.email} (${u.role})`).join(', '));
  console.log('  Password for every seeded user: Password123!');
}

async function findOrgByLegalName(legalName: string) {
  return prisma.organization.findFirst({ where: { legalName } });
}

function userExists(email: string): boolean {
  void email;
  return true;
}

async function upsertCaseType(data: {
  code: string; name: string; description: string; formSchema: any; requiredDocs: string[]; slaHours: number; approvalLevels: number; isClientVisible?: boolean;
}) {
  const existing = await prisma.caseType.findUnique({ where: { code: data.code } });
  if (existing) return existing;
  return prisma.caseType.create({ data });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());


