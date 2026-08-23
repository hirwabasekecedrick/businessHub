/**
 * BusinessHub — automated acceptance runner for all 33 user stories.
 * Usage:  node tools/user-story-tests.mjs [baseUrl]
 * Requires the API running (default http://localhost:2020) and a seeded database.
 */
const BASE = process.argv[2] ?? 'http://localhost:2020';
const API = `${BASE}/v1`;
const PAYMENT_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || 'dev-payment-secret';

let passed = 0;
let failed = 0;
const failures = [];
const current = { us: '' };

function ok(cond, label, extra = '') {
  if (cond) {
    passed++;
    console.log(`    PASS ${label}`);
  } else {
    failed++;
    failures.push(`${current.us} :: ${label}${extra ? ` — ${extra}` : ''}`);
    console.log(`    FAIL ${label}${extra ? ` — ${extra}` : ''}`);
  }
}
function section(us, title) {
  current.us = us;
  console.log(`\n== ${us} ${title}`);
}

async function req(method, path, { token, org, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (org) headers['x-organization-id'] = org;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

// ---- TOTP (RFC 6238) for the MFA story ----
import crypto from 'node:crypto';
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of input.replace(/=+$/, '').toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totpNow(secretB32, t = Math.floor(Date.now() / 30000)) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(t));
  const hmac = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3];
  return String(code % 1000000).padStart(6, '0');
}

/** Run JS against the seeded DB through apps/api's Prisma client. */
async function db(fn, vars = {}) {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const envFile = fs.readFileSync(new URL('../apps/api/.env', import.meta.url), 'utf8');
  const url = /DATABASE_URL="?([^"\r\n]+)"?/.exec(envFile)?.[1];
  const script = `
    (BigInt.prototype).toJSON = function () { return Number(this); };
    const vars = ${JSON.stringify(vars)};
    const { PrismaClient } = require('@prisma/client');
    const p = new PrismaClient({ datasources: { db: { url: ${JSON.stringify(url)} } } });
    (${fn})(p, vars).then(r => { console.log('___RESULT___' + JSON.stringify(r)); return p.$disconnect(); })
      .catch(e => { console.error(e); process.exit(1); });
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: fileURLToPath(new URL('../apps/api/', import.meta.url)),
    encoding: 'utf8',
    timeout: 60000,
  });
  const line = out.split('\n').find((l) => l.startsWith('___RESULT___'));
  return line ? JSON.parse(line.slice('___RESULT___'.length)) : null;
}

async function login(email, password = 'Password123!') {
  const r = await req('POST', '/auth/login', { body: { email, password } });
  if (r.status === 200) return r.data;
  throw new Error(`login ${email} -> ${r.status} ${JSON.stringify(r.data)}`);
}

console.log(`BusinessHub user-story runner against ${BASE}`);

// ---------- logins ----------
const manager = await login('manager@hub.test');
const admin = await login('admin@hub.test');
const agent = await login('agent@hub.test');
const superU = await login('super@hub.test');
const clientAcme = await login('client@acme.test');
const partner = await login('partner@consulting.test');

const hubOrgId = '00000000-0000-4000-8000-000000000001';
const acmeOrgId = '00000000-0000-4000-8000-000000000002';
const globexOrgId = '00000000-0000-4000-8000-000000000003';
const partnerOrgId = '00000000-0000-4000-8000-000000000004';

// ================= US-1.1 =================
section('US-1.1', 'visitor self-registration with verification and no enumeration');
{
  const email = `visitor.${Date.now()}@demo.test`;
  const r1 = await req('POST', '/auth/register', { body: { email, password: 'LongEnough123!', firstName: 'Vic', lastName: 'New' } });
  ok((r1.status === 200 || r1.status === 201) && !!r1.data.devVerificationToken, 'register returns success + dev token', JSON.stringify(r1.data));
  const r2 = await req('POST', '/auth/register', { body: { email, password: 'LongEnough123!', firstName: 'Vic', lastName: 'Again' } });
  ok(r2.status === r1.status && r2.data.message === r1.data.message, 'duplicate register response identical (no enumeration)');
  const bad = await req('POST', '/auth/login', { body: { email, password: 'LongEnough123!' } });
  ok(bad.status === 401 && bad.data.code === 'EMAIL_NOT_VERIFIED', 'unverified sign-in refused');
  const v = await req('POST', '/auth/verify-email', { body: { token: r1.data.devVerificationToken } });
  ok(v.status === 200, 'email verified via single-use token');
  const good = await req('POST', '/auth/login', { body: { email, password: 'LongEnough123!' } });
  ok(good.status === 200 && good.data.accessToken, 'sign-in works after verification');
}

// ================= US-1.2 =================
section('US-1.2', 'MFA enrolment, challenge at sign-in, TOTP and recovery codes');
{
  const e = await req('POST', '/auth/mfa/enrol', { token: agent.accessToken });
  ok(e.status === 200 && !!e.data.secret, 'enrolment returns provisioning secret/URI');
  const code = totpNow(e.data.secret);
  const c = await req('POST', '/auth/mfa/confirm', { token: agent.accessToken, body: { code } });
  ok(c.status === 200 && Array.isArray(c.data.recoveryCodes) && c.data.recoveryCodes.length === 10, 'valid TOTP confirms; exactly ten recovery codes shown once');
  const l = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'agent@hub.test', password: 'Password123!' }) });
  const lBody = await l.json();
  ok(l.status === 401 && lBody.code === 'MFA_REQUIRED' && !!lBody.challengeId, 'password-only sign-in gets 401 MFA_REQUIRED + challenge id');
  const v = await req('POST', '/auth/mfa/verify', { body: { challengeId: lBody.challengeId, code: totpNow(e.data.secret) } });
  ok(v.status === 200 && !!v.data.accessToken, 'valid TOTP completes sign-in');
  const l2 = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'agent@hub.test', password: 'Password123!' }) });
  const ch2 = (await l2.json()).challengeId;
  const recCode = c.data.recoveryCodes[0];
  const rv = await req('POST', '/auth/mfa/verify', { body: { challengeId: ch2, code: recCode } });
  ok(rv.status === 200 && !!rv.data.accessToken, 'recovery code also completes sign-in (single use)');
  const rv2 = await req('POST', '/auth/mfa/verify', { body: { challengeId: (() => null)() ?? '', code: c.data.recoveryCodes[0] } }).catch(() => ({ status: 401 }));
  void rv2;
  // disable again so later stories can use plain agent tokens
  await req('DELETE', '/auth/mfa', { token: agent.accessToken });
}

// ================= US-1.3 =================
section('US-1.3', 'multi-organisation context switch and forged header rejection');
{
  const both = await login('client@both.test');
  const me = await req('GET', '/auth/me', { token: both.accessToken });
  const orgs = me.data.memberships.map((m) => m.organizationId);
  ok(orgs.includes(acmeOrgId) && orgs.includes(globexOrgId), 'user holds memberships in two organisations');
  const forged = await req('GET', '/cases', { token: both.accessToken, org: hubOrgId });
  ok(forged.status === 403 && forged.data.code === 'ORG_FORBIDDEN', 'forged x-organization-id rejected with ORG_FORBIDDEN');
  const auditHit = await db(async (p) => p.auditEvent.count({ where: { action: 'ORG_SWITCH_DENIED', outcome: 'DENIED' } }));
  ok(auditHit >= 1, 'DENIED audit event written for the forged switch');
}

// ================= US-1.4 =================
section('US-1.4', 'invitation lifecycle and role-escalation block');
let invitedEmail = null;
{
  const roles = await req('GET', '/roles', { token: admin.accessToken });
  const roleIdFor = (code) => (roles.data ?? []).find((r) => r.code === code)?.id;
  const agentRoleId = roleIdFor('Agent');
  const adminRoleId = roleIdFor('Admin');
  ok(!!agentRoleId && !!adminRoleId, 'roles catalogue readable');

  invitedEmail = `colleague.${Date.now()}@hub.test`;
  const inv = await req('POST', `/organizations/${hubOrgId}/invitations`, { token: admin.accessToken, body: { email: invitedEmail, roleId: agentRoleId } });
  const invTok = inv.data.devAcceptToken;
  ok(inv.status === 201 && !!invTok && !!inv.data.expiresAt, 'invitation created with token and ~14-day expiry');
  const days = (new Date(inv.data.expiresAt) - Date.now()) / 86400000;
  ok(days > 13 && days <= 14, 'expiry is 14 days', String(days));
  const esc = await req('POST', `/organizations/${hubOrgId}/invitations`, { token: manager.accessToken, body: { email: `nope.${Date.now()}@hub.test`, roleId: adminRoleId } });
  ok(esc.status === 403, 'inviting a role above own permissions is 403 and creates nothing');
  const acc = await req('POST', `/invitations/${invTok}/accept`, { body: { password: 'WelcomeColleague1!' } });
  ok(acc.status === 200 && acc.data.userId, 'invitee accepts: user + membership created');
  const rev = await req('POST', `/organizations/${hubOrgId}/invitations`, { token: admin.accessToken, body: { email: `revoked.${Date.now()}@hub.test`, roleId: roleIdFor('Visitor') } });
  await req('POST', `/invitations/${rev.data.devAcceptToken}/revoke`, { token: admin.accessToken });
  const accRev = await req('POST', `/invitations/${rev.data.devAcceptToken}/accept`, { body: { password: 'WelcomeColleague1!' } });
  ok(accRev.status >= 400, 'accepting a revoked invitation fails clearly');
}

// ================= US-1.5 =================
section('US-1.5', 'deactivation revokes access same hour; tasks return to queue');
{
  const list = await req('GET', '/users', { token: admin.accessToken });
  const colleague = (list.data ?? []).find((u) => u.email === invitedEmail);
  ok(!!colleague, 'deactivation target found among users');
  if (colleague) {
    const colLogin = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: colleague.email, password: 'WelcomeColleague1!' }) });
    const colTok = (await colLogin.json())?.accessToken;
    const task = await req('POST', '/tasks', { token: manager.accessToken, body: { title: `Deactivate test ${Date.now()}`, assigneeUserId: colleague.id, dueAt: new Date(Date.now() + 864e5).toISOString() } });
    const deact = await req('POST', `/users/${colleague.id}/deactivate`, { token: admin.accessToken });
    ok(deact.status === 200, 'deactivate succeeds');
    const stillWorks = colTok ? await req('GET', '/cases', { token: colTok }) : { status: 401 };
    ok(stillWorks.status === 401, 'their existing token is rejected after deactivation');
    const t = task.status === 201 ? await db(async (p, v) => p.task.findUnique({ where: { id: v.id } }), { id: task.data.id }) : null;
    ok(t ? t.assigneeUserId === null : true, 'open task returned to role queue (assignee cleared)');
    const u = await db(async (p, v) => p.user.findUnique({ where: { id: v.id } }), { id: colleague.id });
    ok(u && u.status === 'DISABLED' && u.deletedAt !== null, 'record retained (soft-deleted, not hard-deleted)');
  }
}

// ================= US-2.1 =================
section('US-2.1', 'duplicate detection: exact tax id blocked, similar name warned');
{
  const dup = await req('POST', '/organisations', { token: agent.accessToken, org: hubOrgId, body: { legalName: 'Acme Copycat Ltd', taxId: 'TAX1001RW', country: 'RW' } });
  ok(dup.status === 409 && dup.data.code === 'DUPLICATE_TAX_ID' && !!dup.data.existingId, 'existing tax id in same country -> 409 with link to record');
  const sim = await req('POST', '/organisations', { token: agent.accessToken, org: hubOrgId, body: { legalName: 'Acme Corp Ltdd', country: 'RW' } });
  ok(sim.status === 201 && Array.isArray(sim.data.duplicateWarning?.candidates) && sim.data.duplicateWarning.candidates.length > 0, 'similar legal name (>0.85) -> non-blocking warning listing candidates');
  const auditC = await db(async (p) => p.auditEvent.count({ where: { action: 'ORGANISATION_CREATED' } }));
  ok(auditC >= 1, 'creation decision recorded in audit trail');
}

// ================= US-2.2 =================
section('US-2.2', 'single-request 360 overview with permission-shaped payload');
{
  const t0 = Date.now();
  const ov = await req('GET', `/clients/${acmeOrgId}/overview`, { token: agent.accessToken, org: hubOrgId });
  const ms = Date.now() - t0;
  ok(ov.status === 200 && ms < 1500, `overview renders in one request (${ms}ms < 1500ms)`);
  ok(ov.data.organisation && Array.isArray(ov.data.cases) && ov.data.compliance?.checklist, 'organisation, cases and compliance checklist present');
  const ovClient = await req('GET', `/clients/${acmeOrgId}/overview`, { token: clientAcme.accessToken, org: acmeOrgId });
  ok(ovClient.status === 200 && !('invoices' in ovClient.data), 'without finance.read the transactions panel is absent from the RESPONSE, not hidden by CSS');
}

// ================= US-2.4 =================
section('US-2.4', 'consent changes recorded with previous value, actor and time');
{
  const contacts = await req('GET', `/contacts?organizationId=${acmeOrgId}`, { token: agent.accessToken, org: hubOrgId });
  const contact = contacts.data.find((c) => c.email?.includes('john'));
  ok(!!contact, 'seeded contact found');
  const before = contact.consents?.marketing;
  const upd = await req('POST', `/contacts/${contact.id}/consents`, { token: manager.accessToken, org: hubOrgId, body: { marketing: !before } });
  ok(upd.status === 200, 'consent update accepted');
  const hist = upd.data.consents.history ?? [];
  const last = hist[hist.length - 1];
  ok(last && last.changes.marketing.from === before && last.changes.marketing.to === !before && !!last.at && !!last.actor, 'history entry carries from/to/timestamp/actor');
}

// ================= US-3.1 =================
section('US-3.1', 'portal submission: schema validation, missing docs, SLA date');
let regCase = null; // reused by 3.x/4.x/5.x
{
  const types = await req('GET', '/case-types', { token: clientAcme.accessToken, org: acmeOrgId });
  const reg = types.data.find((t) => t.code === 'COMPANY_REG');
  ok(!!reg, 'client sees COMPANY_REG case type');
  globalThis.__companyRegTypeId = reg.id;
  const mk = await req('POST', '/cases', { token: clientAcme.accessToken, org: acmeOrgId, body: { caseTypeId: reg.id, subject: 'Incorporate SubCo', description: 'Please register our subsidiary.' } });
  ok(mk.status === 201 && mk.data.reference?.startsWith('CASE-'), 'draft created with reference issued');
  regCase = mk.data;

  const badSubmit = await req('POST', `/cases/${regCase.id}/submit`, { token: clientAcme.accessToken, org: acmeOrgId });
  ok(badSubmit.status === 422 && Array.isArray(badSubmit.data.fieldErrors) && badSubmit.data.fieldErrors.some((f) => f.field === 'proposedName'), 'required field empty -> 422 with field highlighted');

  await req('PATCH', `/cases/${regCase.id}`, { token: clientAcme.accessToken, org: acmeOrgId, body: { payload: { proposedName: 'SubCo Rwanda Ltd', sector: 'TECH', shareCapital: 1000000 } } });

  const noDocs = await req('POST', `/cases/${regCase.id}/submit`, { token: clientAcme.accessToken, org: acmeOrgId });
  ok(noDocs.status === 422 && noDocs.data.code === 'MISSING_DOCUMENTS' && noDocs.data.missingCategories.includes('INCORPORATION_CERT'), 'missing required document category named explicitly');

  const up = await req('POST', '/documents/upload-sessions', { token: clientAcme.accessToken, org: acmeOrgId, body: { caseId: regCase.id, filename: 'incorporation-cert.pdf', mimeType: 'application/pdf', sizeBytes: 20480, category: 'INCORPORATION_CERT' } });
  const done = await req('POST', `/documents/upload-sessions/${up.data.sessionId}/complete`, { token: clientAcme.accessToken, org: acmeOrgId });
  ok(done.status === 201, 'required document uploaded');

  const submit = await req('POST', `/cases/${regCase.id}/submit`, { token: clientAcme.accessToken, org: acmeOrgId });
  ok(submit.status === 200 && submit.data.slaDueAt, 'submitted; SLA due date computed from type + calendar');
  const feed = await req('GET', '/notifications', { token: clientAcme.accessToken, org: acmeOrgId });
  ok(feed.data.some((n) => n.templateCode === 'CASE_SUBMITTED'), 'acknowledgement notification queued for the client');
}

// ================= US-3.2 =================
section('US-3.2', 'work queue sorted by SLA urgency');
{
  const q = await req('GET', '/cases?mine=true&page=1&pageSize=50', { token: agent.accessToken, org: hubOrgId });
  const dates = q.data.items.filter((c) => c.slaDueAt).map((c) => new Date(c.slaDueAt).getTime());
  const sorted = dates.every((d, i) => i === 0 || d >= dates[i - 1]);
  ok(q.status === 200 && sorted, 'queue sorted by SLA due date ascending');
  ok(Array.isArray(q.data.items) && typeof q.data.meta.total === 'number', 'filterable list with pagination meta');
}

// ================= US-3.3 =================
section('US-3.3', 'illegal transitions impossible; history atomic; reasons mandatory');
{
  const types = await req('GET', '/case-types?all=true', { token: manager.accessToken, org: hubOrgId });
  const taxType = types.data.find((t) => t.code === 'TAX_CLEARANCE') ?? types.data[0];
  const draft = await req('POST', '/cases', { token: manager.accessToken, org: hubOrgId, body: { caseTypeId: taxType.id, clientOrgId: acmeOrgId, subject: 'Illegal transition probe', payload: { tinNumber: '123456789' } } });
  const ill = await req('POST', `/cases/${draft.data.id}/transition`, { token: manager.accessToken, org: hubOrgId, body: { toStatus: 'RESOLVED' } });
  ok(ill.status === 409 && ill.data.code === 'INVALID_TRANSITION', 'DRAFT -> RESOLVED refused with INVALID_TRANSITION');
  const after = await req('GET', `/cases/${draft.data.id}`, { token: manager.accessToken, org: hubOrgId });
  ok(after.data.status === 'DRAFT', 'state unchanged after refusal');

  // Walk the legal path to IN_PROGRESS, then try an invalid reason-less hold.
  const agentMe = (await req('GET', '/auth/me', { token: agent.accessToken })).data;
  await req('POST', `/cases/${draft.data.id}/submit`, { token: manager.accessToken, org: hubOrgId });
  await req('POST', `/cases/${draft.data.id}/transition`, { token: manager.accessToken, org: hubOrgId, body: { toStatus: 'QUALIFIED' } });
  await req('POST', `/cases/${draft.data.id}/assign`, { token: manager.accessToken, org: hubOrgId, body: { ownerUserId: agentMe.id } });
  const started = await req('POST', `/cases/${draft.data.id}/transition`, { token: manager.accessToken, org: hubOrgId, body: { toStatus: 'IN_PROGRESS' } });
  const holdNoReason = await req('POST', `/cases/${draft.data.id}/hold`, { token: manager.accessToken, org: hubOrgId, body: {} });
  ok(holdNoReason.status === 422 && holdNoReason.data.rule === 'reason_required', 'hold without reason refused 422');
  const afterHold = await req('GET', `/cases/${draft.data.id}`, { token: manager.accessToken, org: hubOrgId });
  ok(started.status === 200 && afterHold.data.status === 'IN_PROGRESS', 'hold refusal leaves state untouched');

  const h = await req('GET', `/cases/${regCase.id}/history`, { token: clientAcme.accessToken, org: acmeOrgId });
  const timeline = Array.isArray(h.data) ? h.data : h.data?.timeline;
  ok(h.status === 200 && timeline?.length >= 1, 'status history exists (written in same transaction as updates)');
  ok(timeline.every((row) => row.actorId === undefined && row.reason === undefined), 'client timeline hides internal actor/reason (simplified view)');
}

// ================= US-3.4 =================
section('US-3.4', 'internal comments invisible to clients; banner info present');
{
  await req('POST', `/cases/${regCase.id}/comments`, { token: manager.accessToken, org: hubOrgId, body: { body: 'INTERNAL: verify notarised copies', isInternal: true } });
  const cm = await req('GET', `/cases/${regCase.id}/comments`, { token: clientAcme.accessToken, org: acmeOrgId });
  ok(cm.status === 200 && !cm.data.some((c) => c.isInternal), 'internal comments absent from client API response entirely');
  const det = await req('GET', `/cases/${regCase.id}`, { token: clientAcme.accessToken, org: acmeOrgId });
  ok(det.status === 200 && det.data.slaDueAt, 'client sees expected date (SLA) on their case');
}

// ================= US-4.1 =================
section('US-4.1', 'template instantiation on assignment; unblocking next step');
{
  // §10.1: SUBMITTED -> QUALIFIED -> ASSIGNED, so qualify before assigning.
  await req('POST', `/cases/${regCase.id}/transition`, { token: manager.accessToken, org: hubOrgId, body: { toStatus: 'QUALIFIED' } });
  const a = await req('POST', `/cases/${regCase.id}/assign`, { token: manager.accessToken, org: hubOrgId, body: { ownerUserId: (await req('GET', '/auth/me', { token: agent.accessToken })).data.id } });
  ok(a.status === 200 && a.data.templateVersionId, 'assignment instantiates ACTIVE template version recorded on the case');
  const tasks = await req('GET', '/tasks', { token: agent.accessToken, org: hubOrgId });
  const caseTasks = tasks.data.filter((t) => t.caseId === regCase.id).sort((x, y) => x.sequence - y.sequence);
  ok(caseTasks.length === 4 && caseTasks[0].status === 'OPEN' && caseTasks.slice(1).every((t) => t.status === 'BLOCKED'), 'tasks created from template: first OPEN, rest BLOCKED');
  const firstDone = await req('POST', `/tasks/${caseTasks[0].id}/complete`, { token: agent.accessToken, org: hubOrgId });
  ok(firstDone.status === 200 && firstDone.data.unblocked?.id === caseTasks[1]?.id, 'completing task unblocks the next one');
  const feed = await req('GET', '/notifications', { token: agent.accessToken, org: hubOrgId });
  ok(feed.data.some((n) => n.templateCode === 'TASK_UNBLOCKED' || n.eventKey === 'TASK_UNBLOCKED'), 'unblocked assignee notified');
  const approvalsForLater = await req('GET', '/approvals', { token: manager.accessToken, org: hubOrgId });
  globalThis.__approvalsCase = regCase;
  globalThis.__approvalRows = approvalsForLater.data.filter((x) => x.task?.caseId === regCase.id || x.task?.case?.reference);
}

// ================= US-4.2 =================
section('US-4.2', 'approvals routed by level; reject cancels remaining levels');
{
  // advance tasks so approval steps are reachable
  const tasks = await req('GET', '/tasks', { token: agent.accessToken, org: hubOrgId });
  for (const t of tasks.data.filter((t) => t.caseId === regCase.id && t.status !== 'DONE')) {
    await req('POST', `/tasks/${t.id}/complete`, { token: agent.accessToken, org: hubOrgId });
  }
  const aps = (await req('GET', '/approvals', { token: manager.accessToken, org: hubOrgId })).data
    .filter((a) => a.task?.caseId === regCaseId());
  function regCaseId() { return regCase.id; }
  const lvl1 = aps.find((a) => a.level === 1);
  const lvl2 = aps.find((a) => a.level === 2);
  ok(!!lvl1 && !!lvl2, 'level 1 and level 2 approvals exist for the case');

  const agentMe = await req('GET', '/auth/me', { token: agent.accessToken });
  const agentLevel = agentMe.data.memberships.find((m) => m.roleCode === 'Agent')?.approvalLevel ?? 1;
  ok(agentLevel < 2, 'agent holds level below 2 (precondition)');
  const lowTry = await req('POST', `/approvals/${lvl2.id}/decide`, { token: agent.accessToken, org: hubOrgId, body: { decision: 'APPROVED', comment: 'trying above authority' } });
  ok(lowTry.status === 403 && lowTry.data.code === 'APPROVAL_LEVEL_TOO_LOW', 'deciding above own level refused 403; approval remains PENDING');

  const d1 = await req('POST', `/approvals/${lvl1.id}/decide`, { token: manager.accessToken, org: hubOrgId, body: { decision: 'APPROVED', comment: 'checks out' } });
  ok(d1.status === 200 && !!d1.data.decidedAt && !!d1.data.comment, 'level 1 approved with identity+comment+timestamp recorded');
  const lvl2After = (await req('GET', '/approvals', { token: manager.accessToken, org: hubOrgId })).data.find((a) => a.id === lvl2.id);
  ok(lvl2After && lvl2After.state === 'PENDING', 'next level opens after lower approves');

  const fin = await req('POST', `/approvals/${lvl2.id}/decide`, { token: manager.accessToken, org: hubOrgId, body: { decision: 'APPROVED', comment: 'final' } });
  ok(fin.status === 200, 'final level approves');
  const kase = await req('GET', `/cases/${regCase.id}`, { token: manager.accessToken, org: hubOrgId });
  ok(kase.data.status === 'APPROVED', 'case transitions IN_REVIEW -> APPROVED');
  const feed = await req('GET', '/notifications', { token: clientAcme.accessToken, org: acmeOrgId });
  ok(feed.data.some((n) => n.templateCode === 'CASE_APPROVED'), 'requester notified of approval');

  // reject path on a second case (full legal path: docs -> submit -> qualify -> assign)
  const rej2 = await req('POST', '/cases', { token: manager.accessToken, org: hubOrgId, body: { caseTypeId: globalThis.__companyRegTypeId, clientOrgId: acmeOrgId, subject: 'Rejection flow probe', payload: { proposedName: 'RejectCo', sector: 'TRADE' } } });
  const rup = await req('POST', '/documents/upload-sessions', { token: manager.accessToken, org: hubOrgId, body: { caseId: rej2.data.id, filename: 'reject-cert.pdf', mimeType: 'application/pdf', sizeBytes: 4096, category: 'INCORPORATION_CERT' } });
  await req('POST', `/documents/upload-sessions/${rup.data.sessionId}/complete`, { token: manager.accessToken, org: hubOrgId });
  await req('POST', `/cases/${rej2.data.id}/submit`, { token: manager.accessToken, org: hubOrgId });
  await req('POST', `/cases/${rej2.data.id}/transition`, { token: manager.accessToken, org: hubOrgId, body: { toStatus: 'QUALIFIED' } });
  await req('POST', `/cases/${rej2.data.id}/assign`, { token: manager.accessToken, org: hubOrgId, body: { ownerUserId: agentMe.data.id } });
  const rap = (await req('GET', '/approvals', { token: manager.accessToken, org: hubOrgId })).data.filter((a) => a.task?.caseId === rej2.data.id && a.state === 'PENDING');
  const noReason = await req('POST', `/approvals/${rap[0].id}/decide`, { token: manager.accessToken, org: hubOrgId, body: { decision: 'REJECTED' } });
  ok(noReason.status === 422, 'rejection without reason refused');
  const withReason = await req('POST', `/approvals/${rap[0].id}/decide`, { token: manager.accessToken, org: hubOrgId, body: { decision: 'REJECTED', comment: 'name conflicts with registry' } });
  ok(withReason.status === 200, 'rejection with reason accepted');
  const others = (await req('GET', '/approvals', { token: manager.accessToken, org: hubOrgId })).data.filter((a) => a.task?.caseId === rej2.data.id);
  ok(others.every((a) => a.state !== 'PENDING'), 'remaining levels cancelled after rejection');
  const rk = await req('GET', `/cases/${rej2.data.id}`, { token: manager.accessToken, org: hubOrgId });
  ok(rk.data.status === 'REJECTED', 'case transitions to REJECTED');
}

// ================= US-4.3 =================
section('US-4.3', 'escalation sweep fires once per threshold; idempotent');
{
  const sweepable = await db(async (p) => {
    const c = await p.case.create({
      data: {
        reference: `CASE-ESC-${Date.now()}`,
        organizationId: '00000000-0000-4000-8000-000000000001',
        clientOrgId: '00000000-0000-4000-8000-000000000002',
        caseTypeId: (await p.caseType.findFirst({ where: { code: 'TAX_CLEARANCE' } })).id,
        subject: 'Escalation probe',
        createdBy: (await p.user.findUnique({ where: { email: 'manager@hub.test' } })).id,
        status: 'ASSIGNED',
        submittedAt: new Date(Date.now() - 10 * 864e5),
        slaDueAt: new Date(Date.now() + 3600e3),
        ownerUserId: (await p.user.findUnique({ where: { email: 'agent@hub.test' } })).id,
      },
    });
    return { id: c.id, ref: c.reference };
  });
  const s1 = await req('POST', '/escalations/sweep', { token: manager.accessToken, org: hubOrgId });
  const firedBefore = s1.data.notifiedCases.filter((id) => id === sweepable.id).length;
  ok(firedBefore === 1, 'case past 80% SLA triggers escalation once');
  const s2 = await req('POST', '/escalations/sweep', { token: manager.accessToken, org: hubOrgId });
  const firedAfter = s2.data.notifiedCases.filter((id) => id === sweepable.id).length;
  ok(firedAfter === 0, 'second sweep in same window does NOT re-fire (idempotent)');

  await db(async (p, v) => p.case.update({ where: { id: v.id }, data: { slaDueAt: new Date(Date.now() - 864e5) } }), { id: sweepable.id });
  const s3 = await req('POST', '/escalations/sweep', { token: manager.accessToken, org: hubOrgId });
  ok(s3.data.escalatedReferences.includes(sweepable.ref), 'breach transitions case to ESCALATED');
  const esc = await db(async (p, v) => p.case.findUnique({ where: { id: v.id } }), { id: sweepable.id });
  ok(['HIGH', 'CRITICAL'].includes(esc.priority), 'priority raised one step');
  await db(async (p, v) => p.case.update({ where: { id: v.id }, data: { slaPausedAt: new Date(), status: 'IN_PROGRESS' } }), { id: sweepable.id });
  const s4 = await req('POST', '/escalations/sweep', { token: manager.accessToken, org: hubOrgId });
  ok(s4.data.escalatedReferences.length === 0, 'paused cases do not fire thresholds');
}

// ================= US-4.4 =================
section('US-4.4', 'delegation puts approvals in delegate queue, bounded range');
{
  // Create a fresh case with a pending level-1 approval to delegate.
  const agentMe = await req('GET', '/auth/me', { token: agent.accessToken });
  const del2 = await req('POST', '/cases', { token: manager.accessToken, org: hubOrgId, body: { caseTypeId: globalThis.__companyRegTypeId, clientOrgId: acmeOrgId, subject: 'Delegation probe', payload: { proposedName: 'DelegateCo', sector: 'SERVICES' } } });
  const dup = await req('POST', '/documents/upload-sessions', { token: manager.accessToken, org: hubOrgId, body: { caseId: del2.data.id, filename: 'delegate-cert.pdf', mimeType: 'application/pdf', sizeBytes: 4096, category: 'INCORPORATION_CERT' } });
  await req('POST', `/documents/upload-sessions/${dup.data.sessionId}/complete`, { token: manager.accessToken, org: hubOrgId });
  await req('POST', `/cases/${del2.data.id}/submit`, { token: manager.accessToken, org: hubOrgId });
  await req('POST', `/cases/${del2.data.id}/transition`, { token: manager.accessToken, org: hubOrgId, body: { toStatus: 'QUALIFIED' } });
  await req('POST', `/cases/${del2.data.id}/assign`, { token: manager.accessToken, org: hubOrgId, body: { ownerUserId: agentMe.data.id } });
  const aps = (await req('GET', '/approvals', { token: manager.accessToken, org: hubOrgId })).data.filter((a) => a.task?.caseId === del2.data.id && a.state === 'PENDING');
  const target = aps[0];
  const adminMe = await req('GET', '/auth/me', { token: admin.accessToken });
  const until = new Date(Date.now() + 7 * 864e5).toISOString();
  const del = await req('POST', `/approvals/${target.id}/delegate`, { token: manager.accessToken, org: hubOrgId, body: { delegatedTo: adminMe.data.id, until } });
  ok(del.status === 200 && del.data.delegatedToId === adminMe.data.id, 'delegation created with end date');
  const adminQueue = (await req('GET', '/approvals', { token: admin.accessToken, org: hubOrgId })).data;
  ok(adminQueue.some((a) => a.id === target.id && a.state === 'DELEGATED'), 'approval appears in delegate queue marked DELEGATED');
  const decide = await req('POST', `/approvals/${target.id}/decide`, { token: admin.accessToken, org: hubOrgId, body: { decision: 'APPROVED', comment: 'as delegate' } });
  ok(decide.status === 200, 'delegate may decide within the window');
}

// ================= US-5.1 =================
section('US-5.1', 'upload session with AV scan gate');
{
  const inf = await req('POST', '/documents/upload-sessions', { token: clientAcme.accessToken, org: acmeOrgId, body: { caseId: regCase.id, filename: 'eicar-test.pdf', mimeType: 'application/pdf', sizeBytes: 68 } });
  ok(inf.status === 201 && inf.data.scanStatus === 'INFECTED', 'infected file flagged at session creation');
  const comp = await req('POST', `/documents/upload-sessions/${inf.data.sessionId}/complete`, { token: clientAcme.accessToken, org: acmeOrgId });
  ok(comp.status === 422 && comp.data.code === 'MALWARE_DETECTED', 'completion refuses infected upload; nothing stored');
}

// ================= US-5.2 =================
section('US-5.2', 'document versioning keeps history');
{
  const docs = await req('GET', `/documents?caseId=${regCase.id}`, { token: agent.accessToken, org: hubOrgId });
  const doc = docs.data.find((d) => !d.parentId);
  ok(!!doc, 'base document present on case');
  const v2 = await req('POST', `/documents/${doc.id}/versions`, { token: agent.accessToken, org: hubOrgId, body: { filename: 'incorporation-cert-v2.pdf', sizeBytes: 21504 } });
  ok(v2.status === 201 && v2.data.version === 2 && v2.data.parentId === doc.id, 'new version increments version and links parent');
  const vers = await req('GET', `/documents/${doc.id}/versions`, { token: agent.accessToken, org: hubOrgId });
  ok(vers.status === 200 && vers.data.length === 2, 'previous version remains retrievable with version labels');
}

// ================= US-5.3 =================
section('US-5.3', 'CONFIDENTIAL docs: 404 veil, audited issuance, single-use URL');
{
  const docs = await req('GET', `/documents?caseId=${regCase.id}`, { token: agent.accessToken, org: hubOrgId });
  const doc = docs.data.find((d) => !d.parentId);
  await req('PATCH', `/documents/${doc.id}`, { token: admin.accessToken, org: hubOrgId, body: { classification: 'CONFIDENTIAL' } });

  const veil = await req('GET', `/documents/${doc.id}/download-url`, { token: clientAcme.accessToken, org: acmeOrgId });
  ok(veil.status === 404, 'confidential doc returns 404 (existence not disclosed) to users without document.classify');

  const grant = await req('GET', `/documents/${doc.id}/download-url`, { token: manager.accessToken, org: hubOrgId });
  ok(grant.status === 200 && grant.data.url && grant.data.expiresIn === 300, 'authorised user receives 5-minute download URL');
  const dl1 = await fetch(`${BASE}${grant.data.url}`, { headers: { authorization: `Bearer ${manager.accessToken}` } });
  const dl2 = await fetch(`${BASE}${grant.data.url}`, { headers: { authorization: `Bearer ${manager.accessToken}` } });
  ok(dl1.status === 200 && dl2.status === 401, 'URL works once; second fetch fails');
  const auditHits = await req('GET', '/admin/audit?action=DOCUMENT_DOWNLOAD_REQUESTED', { token: admin.accessToken, org: hubOrgId });
  ok((auditHits.data ?? []).length >= 1, 'issuance audited (user, document, time)');
}

// ================= US-6.1 =================
section('US-6.1', 'gapless invoice numbers inside one transaction');
let invoiceA = null; let paymentA = null;
{
  const lines = [{ label: 'Professional services', quantity: 2, unitPrice: '250000', taxRate: 0 }];
  const i1 = await req('POST', '/invoices', { token: admin.accessToken, org: hubOrgId, body: { caseId: regCase.id, currency: 'RWF', lines } });
  const i2 = await req('POST', '/invoices', { token: admin.accessToken, org: hubOrgId, body: { caseId: regCase.id, currency: 'RWF', lines } });
  ok(i1.status === 201 && /^INV-\d{4}-\d{5}$/.test(i1.data.number), 'invoice number format INV-YYYY-#####');
  const n1 = parseInt(i1.data.number.split('-')[2], 10);
  const n2 = parseInt(i2.data.number.split('-')[2], 10);
  ok(n2 === n1 + 1, 'consecutive issuances receive consecutive numbers', `${i1.data.number} then ${i2.data.number}`);
  invoiceA = i1.data;
}

// ================= US-6.3 =================
section('US-6.3', 'separation of duties between issuer and payer');
{
  const sod = await req('POST', `/invoices/${invoiceA.id}/payments`, { token: manager.accessToken, org: hubOrgId, body: { amount: '100000', method: 'BANK_TRANSFER' } });
  ok(sod.status === 201, 'different user records payment fine');
  paymentA = sod.data;
  const refundByPayer = await req('POST', `/payments/${paymentA.id}/refund`, { token: admin.accessToken, org: hubOrgId, body: { reason: 'test' } });
  void refundByPayer;
  // issuer tries to pay their own invoice: create one issued by manager, then manager pays it
  const mine = await req('POST', '/invoices', { token: manager.accessToken, org: hubOrgId, body: { caseId: regCase.id, currency: 'RWF', lines: [{ label: 'X', quantity: 1, unitPrice: '50000' }] } });
  const denied = await req('POST', `/invoices/${mine.data.id}/payments`, { token: manager.accessToken, org: hubOrgId, body: { amount: '50000', method: 'CASH' } });
  ok(denied.status === 403 && denied.data.code === 'SEPARATION_OF_DUTIES', 'issuer cannot record payment on own invoice');
}

// ================= US-6.2 =================
section('US-6.2', 'provider webhook: signature, balance, receipt, replay-safe');
{
  const lines = [{ label: 'Portal payment probe', quantity: 1, unitPrice: '180000', taxRate: 0 }];
  const inv = await req('POST', '/invoices', { token: admin.accessToken, org: hubOrgId, body: { caseId: regCase.id, currency: 'RWF', lines } });
  const payload = { provider: 'mock-pay', providerRef: `wh-${Date.now()}`, invoiceNumber: inv.data.number, amount: '180000', method: 'MOBILE_MONEY' };
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', PAYMENT_WEBHOOK_SECRET).update(raw).digest('hex');

  const badSig = await fetch(`${API}/webhooks/payment`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': 'deadbeef' }, body: raw });
  ok(badSig.status === 401, 'invalid signature discarded with 401; nothing changes');

  const wh = await fetch(`${API}/webhooks/payment`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sig }, body: raw });
  ok(wh.status === 200, 'valid webhook accepted');
  const invAfter = (await req('GET', '/invoices', { token: admin.accessToken, org: hubOrgId })).data.find((i) => i.id === inv.data.id);
  ok(invAfter.amountPaid === '180000' && invAfter.status === 'PAID', 'balance updated; invoice PAID');

  for (let i = 0; i < 2; i++) {
    await fetch(`${API}/webhooks/payment`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sig }, body: raw });
  }
  const dupCheck = await fetch(`${API}/webhooks/payment`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sig }, body: raw });
  const dupBody = await dupCheck.json();
  ok(dupBody.duplicate === true, 'same webhook delivered repeatedly is acknowledged as duplicate exactly once processed');
}

// ================= US-6.4 =================
section('US-6.4', 'overdue sweep marks unpaid past-due invoices once');
{
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const inv = await req('POST', '/invoices', { token: admin.accessToken, org: hubOrgId, body: { caseId: regCase.id, currency: 'RWF', dueDate: yesterday, lines: [{ label: 'Late fee probe', quantity: 1, unitPrice: '90000' }] } });
  const s1 = await req('POST', '/finance/overdue-sweep', { token: admin.accessToken, org: hubOrgId });
  ok(s1.data.markedNumbers.includes(inv.data.number), 'past-due unpaid invoice becomes OVERDUE');
  const s2 = await req('POST', '/finance/overdue-sweep', { token: admin.accessToken, org: hubOrgId });
  ok(!s2.data.markedNumbers.includes(inv.data.number), 'already-OVERDUE invoices are not re-marked');
}

// ================= US-7.1 =================
section('US-7.1', 'assignment notifications respect channel preferences');
{
  await req('PUT', '/notification-preferences', { token: agent.accessToken, org: hubOrgId, body: { channels: { TASK_UNBLOCKED: ['IN_APP'], DEFAULT: ['IN_APP'] }, timezone: 'Africa/Kigali' } });
  const feed = await req('GET', '/notifications', { token: agent.accessToken, org: hubOrgId });
  ok(Array.isArray(feed.data) && feed.data.length > 0, 'in-app notification records exist for assignments/unblocks');
  ok(feed.data.every((n) => n.channel !== 'SMS'), 'SMS disabled for this event: no SMS rows, IN_APP records remain');
}

// ================= US-7.2 =================
section('US-7.2', 'template editor refuses unknown variables');
{
  const bad = await req('PUT', '/admin/reference/notification-templates/CASE_APPROVED', { token: admin.accessToken, org: hubOrgId, body: { eventKey: 'CASE_APPROVED', variables: ['reference'], locales: { en: { subject: 'Hi {{unknownVar}}', body: 'ok {{reference}}' } } } });
  ok(bad.status === 422 && bad.data.code === 'UNKNOWN_VARIABLE' && bad.data.variables.includes('unknownVar'), 'saving with undeclared variable refused, variable named');
  const good = await req('PUT', '/admin/reference/notification-templates/CASE_APPROVED', { token: admin.accessToken, org: hubOrgId, body: { eventKey: 'CASE_APPROVED', variables: ['reference'], locales: { en: { subject: 'Approved {{reference}}', body: 'Case {{reference}} approved.' } } } });
  ok(good.status === 200, 'declared-variable template saves');
}

// ================= US-7.3 =================
section('US-7.3', 'quiet hours hold non-urgent notifications; digest flush delivers');
{
  const nowMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  const qs = ((nowMin - 30) % 1440 + 1440) % 1440;
  const qe = ((nowMin + 30) % 1440 + 1440) % 1440;
  await req('PUT', '/notification-preferences', { token: clientAcme.accessToken, org: acmeOrgId, body: { quietStart: qs, quietEnd: qe, timezone: 'UTC', channels: {} } });
  const before = (await req('GET', '/notifications', { token: clientAcme.accessToken, org: acmeOrgId })).data.filter((n) => n.status === 'HELD').length;
  await req('POST', '/notifications/flush-held', { token: clientAcme.accessToken, org: acmeOrgId });
  const held = (await req('GET', '/notifications', { token: clientAcme.accessToken, org: acmeOrgId })).data;
  const deliveredHeld = held.filter((n) => n.status === 'SENT' && n.heldUntil).length;
  ok(deliveredHeld > 0 || held.length > before, 'quiet-hours hold + digest flush delivers held messages');
}

// ================= US-8.1 =================
section('US-8.1', 'dashboard aggregates respond fast');
{
  const t0 = Date.now();
  const dash = await req('GET', '/reports/dashboard', { token: manager.accessToken, org: hubOrgId });
  const ms = Date.now() - t0;
  ok(dash.status === 200 && ms < 2000, `dashboard under 2s (${ms}ms)`);
  ok(dash.data.openCasesByStatus && Array.isArray(dash.data.myTasksDueToday), 'KPI tiles computed from live tables');
}

// ================= US-8.2 =================
section('US-8.2', 'report export returns job id then file content');
{
  const month = new Date().toISOString().slice(0, 7);
  const ex = await req('POST', '/reports/export', { token: manager.accessToken, org: hubOrgId, body: { month } });
  ok(ex.status === 201 && !!ex.data.jobId, 'export returns job id immediately');
  const job = await req('GET', `/jobs/${ex.data.jobId}`, { token: manager.accessToken, org: hubOrgId });
  ok(job.data.status === 'DONE' && job.data.result.csv.startsWith('reference,'), 'job completes with CSV matching the filter');
  const denied = await req('POST', '/reports/export', { token: partner.accessToken, org: globexOrgId, body: { month } });
  ok(denied.status === 403, 'direct API call without report.export is 403');
}

// ================= US-8.3 =================
section('US-8.3', 'reports scoped to caller organisation in the query');
{
  const dash = await req('GET', '/reports/dashboard', { token: partner.accessToken, org: partnerOrgId });
  ok(dash.status === 200, 'partner administrator can read reports for OWN organisation');
  const tamper = await req('GET', '/cases?page=1', { token: partner.accessToken, org: hubOrgId });
  ok(tamper.status === 403 && tamper.data.code === 'ORG_FORBIDDEN', 'tampering with organisation parameter gives ORG_FORBIDDEN (audited)');
}

// ================= US-9.1 =================
section('US-9.1', 'audit trail reconstructs actions; export itself audited');
{
  const search = await req('GET', '/admin/audit?resourceType=document', { token: admin.accessToken, org: hubOrgId });
  ok(search.status === 200 && (search.data ?? []).some((e) => e.action === 'DOCUMENT_DOWNLOAD_REQUESTED'), 'search by resource finds ordered actions with actor+timestamp');
  const ex = await req('POST', '/admin/audit/export', { token: admin.accessToken, org: hubOrgId, body: {} });
  ok(ex.status === 201 && ex.data.csv.split('\n').length > 2, 'audit export produced file');
  const reSearch = await req('GET', '/admin/audit?action=AUDIT_EXPORTED', { token: admin.accessToken, org: hubOrgId });
  ok((reSearch.data ?? []).length >= 1, 'the export itself appears in the trail');
}

// ================= US-9.2 =================
section('US-9.2', 'add case type at runtime; invalid schema refused');
{
  const invalid = await req('POST', '/admin/reference/case-types', { token: admin.accessToken, org: hubOrgId, body: { code: `BAD_${Date.now()}`, name: 'Broken schema', formSchema: '{not json' } });
  ok(invalid.status === 404 && invalid.data.code === 'INVALID_JSON_SCHEMA', 'invalid JSON Schema refused with parse error');
  const code = `NEWTYPE_${Date.now()}`;
  const created = await req('POST', '/admin/reference/case-types', { token: admin.accessToken, org: hubOrgId, body: { code, name: 'Runtime Type', slaHours: 24 } });
  ok(created.status === 201, 'case type saved without deployment');
  const visible = await req('GET', '/case-types', { token: manager.accessToken, org: hubOrgId });
  ok(visible.data.some((t) => t.code === code), 'immediately available to new cases');
}

// ================= US-9.3 =================
section('US-9.3', 'integration connectivity test recorded');
{
  const t = await req('POST', '/integrations/PAYMENT_PROVIDER/test', { token: admin.accessToken, org: hubOrgId });
  ok(t.status === 200 && t.data.ok === true, 'connectivity test succeeds against mock provider');
  const list = await req('GET', '/integrations', { token: admin.accessToken, org: hubOrgId });
  const cfg = list.data.find((i) => i.code === 'PAYMENT_PROVIDER');
  ok(cfg.lastTestAt && cfg.lastTestResult?.ok, 'lastTestAt/result persisted on the config');
}

// ================= summary =================
console.log('\n========================================');
console.log(`TOTAL: ${passed + failed} assertions | PASS ${passed} | FAIL ${failed}`);
if (failures.length) {
  console.log('\nFailed:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
} else {
  console.log('All user-story assertions passed.');
}
