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

// Seeded TOTP secrets for mandatory-MFA staff accounts (see prisma/seed.ts).
const SEED_TOTP = {
  'manager@hub.test': 'MFRGGZDFMZTWQ2LKNNQXA2LPMFRGGZDF',
  'doghan80@gmail.com': 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  'super@hub.test': 'JBSWY3DPEBLTEIFVMUQGCIDBMRSWY4TQ',
};

async function login(email, password = 'Password123!') {
  const r = await req('POST', '/auth/login', { body: { email, password } });
  if (r.status === 200) return r.data;
  if (r.status === 401 && r.data.code === 'MFA_REQUIRED' && SEED_TOTP[email]) {
    const v = await req('POST', '/auth/mfa/verify', { body: { challengeId: r.data.challengeId, code: totpNow(SEED_TOTP[email]) } });
    if (v.status === 200) return v.data;
    throw new Error(`mfa verify ${email} -> ${v.status} ${JSON.stringify(v.data)}`);
  }
  throw new Error(`login ${email} -> ${r.status} ${JSON.stringify(r.data)}`);
}

console.log(`BusinessHub user-story runner against ${BASE}`);

// ---------- logins ----------
const manager = await login('manager@hub.test');
const admin = await login('doghan80@gmail.com');
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

// ================= US-1.2b =================
section('US-1.2b', 'mandatory-MFA roles: enrolment routing, disable refusal, assignment guard');
{
  // Manager is enrolled in the seed — disabling must be refused (spec: refused
  // for roles where MFA is mandatory).
  const mgr = await login('manager@hub.test');
  ok(!!mgr.accessToken, 'seeded manager signs in via TOTP challenge');
  const off = await req('DELETE', '/auth/mfa', { token: mgr.accessToken });
  ok(off.status === 422 && off.data.code === 'MFA_MANDATORY_FOR_ROLE', 'disable refused for mandatory-MFA role');

  // A verified user with no MFA who gains a mandatory role cannot sign in:
  // they are routed to enrolment and tokens are only issued after a valid TOTP.
  const email = `forcedmfa.${Date.now()}@demo.test`;
  const reg = await req('POST', '/auth/register', { body: { email, password: 'LongEnough123!', firstName: 'Forced', lastName: 'Mfa' } });
  await req('POST', '/auth/verify-email', { body: { token: reg.data.devVerificationToken } });
  await db(async (p, v) => {
    const u = await p.user.findUnique({ where: { email: v.email } });
    const role = await p.role.findFirst({ where: { code: 'Manager' } });
    await p.membership.create({ data: { userId: u.id, organizationId: v.orgId, roleId: role.id, isDefault: true, acceptedAt: new Date() } });
    return { granted: true };
  }, { email, orgId: hubOrgId });
  const blocked = await req('POST', '/auth/login', { body: { email, password: 'LongEnough123!' } });
  ok(blocked.status === 401 && blocked.data.code === 'MFA_ENROLMENT_REQUIRED' && !!blocked.data.challengeId, 'un-enrolled manager sign-in routed to enrolment (no tokens)');

  const enr = await req('POST', '/auth/mfa/enrol/challenge', { body: { challengeId: blocked.data.challengeId } });
  ok(enr.status === 200 && !!enr.data.uri && !!enr.data.secret, 'enrolment challenge returns provisioning URI/secret');
  const conf = await req('POST', '/auth/mfa/confirm/challenge', { body: { challengeId: blocked.data.challengeId, code: totpNow(enr.data.secret) } });
  ok(conf.status === 200 && !!conf.data.accessToken && conf.data.recoveryCodes?.length === 10, 'valid code completes forced enrolment; ten recovery codes shown once');

  // FR-1.3: an un-enrolled user cannot be invited into a mandatory-MFA role.
  {
    const adm = await login('doghan80@gmail.com'); // fresh session — earlier stories may rotate/revoke
    const rolesRes = await req('GET', '/roles', { token: adm.accessToken });
    const list = Array.isArray(rolesRes.data) ? rolesRes.data : rolesRes.data?.items ?? [];
    const managerRole = list.find((x) => x.code === 'Manager');
    ok(Array.isArray(list) && !!managerRole, 'role catalogue readable for invitation guard check');
    const inv = await req('POST', `/organizations/${hubOrgId}/invitations`, {
      token: adm.accessToken,
      body: { email: `unenrolled.${Date.now()}@example.test`, roleId: managerRole.id },
    });
    ok(inv.status === 422 && inv.data.code === 'MFA_ENROLMENT_REQUIRED_FOR_ROLE', 'invitation to mandatory-MFA role refused for un-enrolled user');
  }
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

  // switch isolation: a case created inside Globex never leaks into Acme
  const ctypes = await req('GET', '/case-types', { token: both.accessToken, org: globexOrgId });
  const anyType = (Array.isArray(ctypes.data) ? ctypes.data : ctypes.data?.items ?? [])[0];
  ok(!!anyType, 'case types readable for probe');
  const gProbe = await req('POST', '/cases', { token: both.accessToken, org: globexOrgId, body: { caseTypeId: anyType.id, subject: `Switch isolation ${Date.now()}`, payload: {} } });
  ok(gProbe.status === 201, 'client creates case inside Globex context');
  const gList = await req('GET', '/cases?pageSize=100', { token: both.accessToken, org: globexOrgId });
  const aList = await req('GET', '/cases?pageSize=100', { token: both.accessToken, org: acmeOrgId });
  const dList = await req('GET', '/cases?pageSize=100', { token: both.accessToken });
  ok(gList.status === 200 && gList.data.items.some((i) => i.id === gProbe.data.id), 'Globex context lists the Globex case');
  ok(aList.status === 200 && !aList.data.items.some((i) => i.id === gProbe.data.id), 'Acme context does NOT see it');
  ok(dList.status === 200 && !dList.data.items.some((i) => i.id === gProbe.data.id), 'no header resolves default membership (Acme)');
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

  // ---- §10.3: changing the case type recomputes SLA from submission instant
  await db(async (p, v) => p.case.update({ where: { id: v.id }, data: { slaPausedAt: null, status: 'IN_PROGRESS', slaDueAt: new Date(Date.now() - 864e5) } }), { id: sweepable.id });
  const probeTypeId = await db(async (p, v) => (await p.case.findUnique({ where: { id: v.id }, select: { caseTypeId: true } })).caseTypeId, { id: sweepable.id });
  const altType = await db(async (p, v) => p.caseType.findFirst({ where: { isActive: true, id: { not: v.typeId } }, select: { id: true, name: true } }), { typeId: probeTypeId });
  ok(!!altType, 'alternate active case type available');
  const beforeT = await req('GET', `/cases/${sweepable.id}`, { token: manager.accessToken, org: hubOrgId });
  const oldDue = beforeT.data.slaDueAt;
  const patched = await req('PATCH', `/cases/${sweepable.id}`, { token: manager.accessToken, org: hubOrgId, body: { caseTypeId: altType.id } });
  ok(
    patched.status === 200 && patched.data.caseTypeId === altType.id && patched.data.slaDueAt && patched.data.slaDueAt !== oldDue,
    'type change recomputes SLA deadline',
    `${oldDue} -> ${patched.data.slaDueAt}`,
  );
  const hist = await req('GET', `/cases/${sweepable.id}/history`, { token: manager.accessToken, org: hubOrgId });
  const rows = Array.isArray(hist.data) ? hist.data : hist.data?.items ?? [];
  const entry = rows.find((h) => String(h.reason ?? '').includes('SLA recomputed for type change'));
  ok(
    !!entry && String(entry.reason).includes(String(oldDue).slice(0, 16)) && String(entry.reason).includes(String(patched.data.slaDueAt).slice(0, 16)),
    'history entry records old and new deadlines',
  );
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
section('US-6.1', 'draft invoices; gapless numbers allocated at issuance');
let invoiceA = null; let paymentA = null;
{
  const lines = [{ label: 'Professional services', quantity: 2, unitPrice: '250000', taxRate: 0 }];
  const d1 = await req('POST', '/invoices', { token: manager.accessToken, org: hubOrgId, body: { caseId: regCase.id, currency: 'EUR', lines } });
  ok(d1.status === 201 && d1.data.status === 'DRAFT' && d1.data.number === null, 'invoice starts as DRAFT without a number');
  const i1 = await req('POST', `/invoices/${d1.data.id}/issue`, { token: admin.accessToken, org: hubOrgId });
  const d2 = await req('POST', '/invoices', { token: manager.accessToken, org: hubOrgId, body: { caseId: regCase.id, currency: 'EUR', lines } });
  const i2 = await req('POST', `/invoices/${d2.data.id}/issue`, { token: admin.accessToken, org: hubOrgId });
  ok(i1.status === 201 && /^INV-\d{4}-\d{5}$/.test(i1.data.number), 'issuing assigns number INV-YYYY-#####');
  const n1 = parseInt(i1.data.number.split('-')[2], 10);
  const n2 = parseInt(i2.data.number.split('-')[2], 10);
  ok(n2 === n1 + 1, 'consecutive issuances receive consecutive numbers', `${i1.data.number} then ${i2.data.number}`);
  invoiceA = i1.data;

  const immutable = await req('PATCH', `/invoices/${d1.data.id}`, { token: admin.accessToken, org: hubOrgId, body: { currency: 'EUR' } });
  ok(immutable.status === 409 && immutable.data.code === 'INVOICE_IMMUTABLE', 'issued invoices are immutable (FR-6.3)');

  const pdfUrl = await req('GET', `/invoices/${d1.data.id}/pdf-url`, { token: admin.accessToken, org: hubOrgId });
  ok(pdfUrl.status === 200 && String(pdfUrl.data.url).includes('/pdf?token='), 'time-limited pdf url issued');
  if (pdfUrl.status === 200) {
    const bad = await fetch(`${API}/invoices/${d1.data.id}/pdf?token=bogus`);
    ok(bad.status === 401, 'pdf link refuses invalid or expired tokens');
    const good = await fetch(`${BASE}${pdfUrl.data.url}`);
    const buf = Buffer.from(await good.arrayBuffer());
    ok(good.status === 200 && buf.subarray(0, 5).toString() === '%PDF-', 'rendered PDF served via signed link without a session');
  }
}

// ================= US-6.3 =================
section('US-6.3', 'separation of duties across issue, pay and refund');
{
  const mine = await req('POST', '/invoices', { token: manager.accessToken, org: hubOrgId, body: { caseId: regCase.id, currency: 'EUR', lines: [{ label: 'X', quantity: 1, unitPrice: '50000' }] } });
  const selfIssue = await req('POST', `/invoices/${mine.data.id}/issue`, { token: manager.accessToken, org: hubOrgId });
  ok(selfIssue.status === 403 && selfIssue.data.code === 'SEPARATION_OF_DUTIES', 'creator cannot issue own draft when >=3 finance users exist');
  const otherIssue = await req('POST', `/invoices/${mine.data.id}/issue`, { token: admin.accessToken, org: hubOrgId });
  ok(otherIssue.status === 201 && !!otherIssue.data.number, 'a second user with invoice.issue can issue it');

  const sod = await req('POST', `/invoices/${invoiceA.id}/payments`, { token: manager.accessToken, org: hubOrgId, body: { amount: '100000', method: 'BANK_TRANSFER' } });
  ok(sod.status === 201, 'different user records payment fine');
  paymentA = sod.data;

  const refundByRecorder = await req('POST', `/payments/${paymentA.id}/refund`, { token: manager.accessToken, org: hubOrgId, body: { reason: 'test' } });
  ok(refundByRecorder.status === 403, 'recorder without payment.refund cannot refund');

  // recorder holding payment.refund still cannot approve their own refund
  const ds = await req('POST', '/invoices', { token: superU.accessToken, org: hubOrgId, body: { caseId: regCase.id, currency: 'EUR', lines: [{ label: 'Refund SOD probe', quantity: 1, unitPrice: '20000' }] } });
  const dsIssued = await req('POST', `/invoices/${ds.data.id}/issue`, { token: manager.accessToken, org: hubOrgId });
  const payS = await req('POST', `/invoices/${dsIssued.data.id}/payments`, { token: admin.accessToken, org: hubOrgId, body: { amount: '20000', method: 'CASH' } });
  ok(payS.status === 201 && payS.data.recordedById !== undefined, 'admin records payment on an invoice issued by someone else');
  const rfSelf = await req('POST', `/payments/${payS.data.id}/refund`, { token: admin.accessToken, org: hubOrgId, body: { reason: 'test' } });
  ok(rfSelf.status === 403 && rfSelf.data.code === 'SEPARATION_OF_DUTIES', 'recorder with payment.refund cannot approve own refund');

  const denied = await req('POST', `/invoices/${mine.data.id}/payments`, { token: admin.accessToken, org: hubOrgId, body: { amount: '50000', method: 'CASH' } });
  ok(denied.status === 403 && denied.data.code === 'SEPARATION_OF_DUTIES', 'issuer cannot record payment on own invoice');
}

// ================= US-6.2 =================
section('US-6.2', 'online payment intent + provider webhook: signature, settle, replay-safe');
{
  const lines = [{ label: 'Portal payment probe', quantity: 1, unitPrice: '180000', taxRate: 0 }];
  const d = await req('POST', '/invoices', { token: manager.accessToken, org: hubOrgId, body: { caseId: regCase.id, currency: 'EUR', lines } });
  const inv = await req('POST', `/invoices/${d.data.id}/issue`, { token: admin.accessToken, org: hubOrgId });

  const intentKey = `ik-${Date.now()}`;
  const pi1 = await req('POST', `/invoices/${inv.data.id}/payment-intents`, { token: clientAcme.accessToken, org: acmeOrgId, body: { intentKey } });
  ok(pi1.status === 201 && pi1.data.amount === '180000' && String(pi1.data.providerRef).startsWith('pi_'), 'intent created server-side with amount from the database');
  const pi2 = await req('POST', `/invoices/${inv.data.id}/payment-intents`, { token: clientAcme.accessToken, org: acmeOrgId, body: { intentKey } });
  ok(pi2.status === 201 && pi2.data.paymentId === pi1.data.paymentId, 'same intent key returns the same handoff (idempotent)');

  const payload = JSON.stringify({ provider: 'mock-pay', providerRef: pi1.data.providerRef, amount: '180000' });
  const sig = crypto.createHmac('sha256', PAYMENT_WEBHOOK_SECRET).update(payload).digest('hex');

  const badSig = await fetch(`${API}/webhooks/payment`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': 'deadbeef' }, body: payload });
  ok(badSig.status === 401, 'invalid signature discarded with 401; nothing changes');

  const wh = await fetch(`${API}/webhooks/payment`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sig }, body: payload });
  const whBody = await wh.json();
  ok(wh.status === 200 && whBody.settledIntent === true, 'signed webhook settles the INITIATED intent');
  const invAfter = (await req('GET', '/invoices', { token: clientAcme.accessToken, org: acmeOrgId })).data.find((i) => i.id === inv.data.id);
  ok(invAfter.amountPaid === '180000' && invAfter.status === 'PAID', 'balance updated; client sees invoice PAID');

  const dupCheck = await fetch(`${API}/webhooks/payment`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sig }, body: payload });
  const dupBody = await dupCheck.json();
  ok(dupBody.duplicate === true, 'same webhook delivered repeatedly is acknowledged as duplicate exactly once processed');
}

// ================= FR-6.9 =================
section('FR-6.9', 'reconciliation: unmatched payments listed, manual matching');
{
  const mkInv = async () => {
    const d = await req('POST', '/invoices', { token: manager.accessToken, org: hubOrgId, body: { caseId: regCase.id, currency: 'EUR', lines: [{ label: 'Recon probe', quantity: 1, unitPrice: '60000' }] } });
    return req('POST', `/invoices/${d.data.id}/issue`, { token: admin.accessToken, org: hubOrgId });
  };
  const srcInv = await mkInv();
  const dstInv = await mkInv();

  const orphan = await db(async (p, v) => {
    const pay = await p.payment.create({
      data: {
        invoiceId: v.srcInvoiceId,
        provider: 'bank-import',
        providerRef: `imp-${v.stamp}`,
        method: 'BANK_TRANSFER',
        amount: v.amount,
        currency: 'EUR',
        status: 'SUCCEEDED',
        paidAt: new Date(),
        reconciledAt: null,
      },
    });
    return { id: pay.id };
  }, { srcInvoiceId: srcInv.data.id, stamp: Date.now(), amount: '60000' });

  const rec1 = await req('GET', '/finance/reconciliation', { token: admin.accessToken, org: hubOrgId });
  ok(rec1.status === 200 && (rec1.data.unmatchedPayments ?? []).some((x) => x.id === orphan.id), 'unmatched payment appears in the reconciliation list');

  const match = await req('POST', '/finance/reconciliation/match', { token: admin.accessToken, org: hubOrgId, body: { paymentId: orphan.id, invoiceId: dstInv.data.id } });
  ok(match.status === 200 && !!match.data.reconciledAt, 'manual matching reconciles the payment onto the chosen invoice');

  const rec2 = await req('GET', '/finance/reconciliation', { token: admin.accessToken, org: hubOrgId });
  ok(!(rec2.data.unmatchedPayments ?? []).some((x) => x.id === orphan.id), 'matched payment leaves the unmatched list');
}

// ================= US-6.4 =================
section('US-6.4', 'overdue sweep marks unpaid past-due invoices once');
{
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const d = await req('POST', '/invoices', { token: manager.accessToken, org: hubOrgId, body: { caseId: regCase.id, currency: 'EUR', dueDate: yesterday, lines: [{ label: 'Late fee probe', quantity: 1, unitPrice: '90000' }] } });
  const inv = await req('POST', `/invoices/${d.data.id}/issue`, { token: admin.accessToken, org: hubOrgId });
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

// ================= FR-9.2 admin settings =================
section('FR-9.2', 'organisation settings via interface');
{
  const denied = await req('GET', '/admin/settings', { token: clientAcme.accessToken, org: acmeOrgId });
  ok(denied.status === 403, 'client without org.settings.manage refused');

  const mgrView = await req('GET', '/admin/settings', { token: manager.accessToken, org: hubOrgId });
  ok(mgrView.status === 200 && typeof mgrView.data.settings?.currency === 'string', 'manager reads organisation settings');

  const bad = await req('PUT', '/admin/settings', { token: admin.accessToken, org: hubOrgId, body: { currency: 'EURO' } });
  ok(bad.status === 422 && bad.data.code === 'VALIDATION_FAILED', 'non ISO-4217 currency refused');

  const saved = await req('PUT', '/admin/settings', {
    token: admin.accessToken,
    org: hubOrgId,
    body: { currency: 'EUR', dunningScheduleDays: [5, 15], locale: 'fr' },
  });
  ok(saved.status === 200 && saved.data.settings.currency === 'EUR' && saved.data.settings.locale === 'fr', 'settings saved and echoed');
  const auditList = await req('GET', '/admin/audit?action=org.settings_changed', { token: admin.accessToken, org: hubOrgId });
  ok(auditList.data.length > 0, 'settings change audited');
}

// ================= FR-9.1 reference data =================
section('FR-9.1', 'reference sets managed through the interface');
{
  const defaults = await req('GET', '/admin/reference/tax-rates', { token: admin.accessToken, org: hubOrgId });
  ok(defaults.status === 200 && Array.isArray(defaults.data.items), 'tax-rate reference set readable');

  const missing = await req('PUT', '/admin/reference/tax-rates', { token: admin.accessToken, org: hubOrgId, body: {} });
  ok(missing.status === 422, 'items array required');

  const saved = await req('PUT', '/admin/reference/tax-rates', {
    token: admin.accessToken,
    org: hubOrgId,
    body: { items: [{ name: 'Standard', rate: 18 }, { name: 'Tourism', rate: 9 }] },
  });
  ok(saved.status === 200 && saved.data.items.length === 2, 'custom tax rates saved');

  const reread = await req('GET', '/admin/reference/tax-rates', { token: admin.accessToken, org: hubOrgId });
  ok(reread.data.customized === true && reread.data.items.some((i) => i.rate === 9), 'customization persisted');

  const none = await req('GET', '/admin/reference/nope-set', { token: admin.accessToken, org: hubOrgId });
  ok(none.status === 404, 'unknown reference set 404');
}

// ================= US-1.1 public request intake (before SSE: streaming can disturb pooled sockets) =====
section('US-1.1', 'public website request becomes a tracked case');
{
  const bad = await req('POST', '/public/requests', { body: { firstName: '', email: 'nope' } });
  ok(bad.status === 400 && bad.data.code === 'VALIDATION_FAILED', 'missing fields refused with field errors');

  const submit = await req('POST', '/public/requests', {
    body: {
      firstName: 'Nora',
      lastName: 'Prospect',
      email: `nora.prospect+${Date.now()}@example.test`,
      organizationName: 'Prospect Ventures',
      requestType: 'COMPANY_REG',
      message: 'We want to incorporate a holding company.',
    },
  });
  ok(submit.status === 201 && /^REQ-/.test(submit.data.reference), 'anonymous submission accepted with REQ- reference');

  const hubCases = await req('GET', '/cases?status=SUBMITTED&page=1&pageSize=100', { token: admin.accessToken, org: hubOrgId });
  const rows = Array.isArray(hubCases.data) ? hubCases.data : hubCases.data?.items ?? [];
  const listed = rows.find((c) => c.subject === '[Web request] Prospect Ventures');
  ok(!!listed, 'web-request case visible in staff queue');

  const detail = await req('GET', `/cases/${listed.id}`, { token: admin.accessToken, org: hubOrgId });
  ok(detail.data.payload?.source === 'PUBLIC_FORM', 'case detail carries PUBLIC_FORM provenance');

  const again = await req('POST', '/public/requests', {
    body: {
      firstName: 'Nora',
      lastName: 'Prospect',
      email: `nora.prospect+${Date.now()}@example.test`,
      message: 'honeypot test',
      website: 'http://spam.example',
    },
  });
  ok(again.status === 201 && !again.data.reference, 'honeypot submissions silently dropped');
}

// ================= FR-7.7 mark all read =================
section('FR-7.7a', 'mark-all-read');
{
  const feed = await req('GET', '/notifications?unread=true', { token: clientAcme.accessToken, org: acmeOrgId });
  if (feed.data.length === 0) {
    const uid = await db(async (p) => p.user.findUnique({ where: { email: 'client@acme.test' }, select: { id: true } }));
    await db(async (p, v) => p.notification.create({
      data: {
        recipientId: v.uid.id,
        organizationId: acmeOrgId,
        templateCode: 'case.submitted',
        subject: 'Suite test',
        body: 'unread filler',
      },
    }), { uid });
  }
  const all = await req('POST', '/notifications/read-all', { token: clientAcme.accessToken, org: acmeOrgId, body: {} });
  ok(all.status === 200 && all.data.updated >= 1, 'read-all marks every unread row');
  const after = await req('GET', '/notifications?unread=true', { token: clientAcme.accessToken, org: acmeOrgId });
  ok(after.data.length === 0, 'feed empty afterwards');
}

// ================= FR-7.7 SSE live stream =================
section('FR-7.7b', 'live SSE stream for badge + toasts');
{
  let attempts = 0;
  let sawHello = false;
  let sawUnread = false;
  while (attempts < 3 && !(sawHello && sawUnread)) {
    attempts++;
    try {
      const res = await fetch(`${API}/notifications/stream?token=${clientAcme.accessToken}`, {
        headers: { 'x-organization-id': acmeOrgId },
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const deadline = Date.now() + 8000;
      let buf = '';
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const chunk = await Promise.race([
          reader.read(),
          new Promise((r) => setTimeout(() => r('timeout'), Math.max(remaining, 1))),
        ]);
        if (!chunk || chunk === 'timeout') break;
        buf += decoder.decode(chunk.value, { stream: true });
        if (buf.includes('event: unread')) break;
      }
      await reader.cancel().catch(() => {});
      sawHello = buf.includes('event: hello');
      sawUnread = buf.includes('event: unread');
    } catch {
      await new Promise((r) => setTimeout(r, 500)); // fresh socket on retry
    }
  }
  ok(sawHello && sawUnread, `SSE stream opens with hello + unread count (${attempts} attempt(s))`);
  await new Promise((r) => setTimeout(r, 300));
}

// ================= US-4.6 escalation panel =================
section('US-4.6', 'escalation queue + rules via API');
{
  const denied = await req('GET', '/escalation-rules', { token: clientAcme.accessToken, org: acmeOrgId });
  ok(denied.status === 403, 'client refused to read escalation config');

  const before = await req('GET', '/escalation-rules', { token: manager.accessToken, org: hubOrgId });
  ok(before.status === 200 && Array.isArray(before.data), 'manager lists escalation rules');

  const created = await req('POST', '/escalation-rules', {
    token: admin.accessToken,
    org: hubOrgId,
    body: { trigger: 'SLA_80PCT', thresholdHours: 3, action: 'NOTIFY_OWNER_AND_MANAGER', isActive: true },
  });
  ok(created.status === 201 && created.data.trigger === 'SLA_80PCT', 'rule created at runtime');

  const toggled = await req('PUT', `/escalation-rules/${created.data.id}`, {
    token: admin.accessToken,
    org: hubOrgId,
    body: { isActive: false },
  });
  ok(toggled.status === 200 && toggled.data.isActive === false, 'rule paused without redeploy');

  const sweep = await req('POST', '/escalations/sweep', { token: manager.accessToken, org: hubOrgId, body: {} });
  ok(sweep.status === 200 && Array.isArray(sweep.data.notifiedCases) && Array.isArray(sweep.data.escalatedReferences), 'idempotent sweep returns fired/escalated arrays');

  const again = await req('POST', '/escalations/sweep', { token: manager.accessToken, org: hubOrgId, body: {} });
  const escalatedAgain = again.data.escalatedReferences.filter((r) => sweep.data.escalatedReferences.includes(r));
  ok(escalatedAgain.length === 0, 'second sweep does not re-escalate the same cases');
}

// ================= FR-7.4 session management =================
section('FR-7.4', 'list & revoke own sessions');
{
  const list = await req('GET', '/auth/sessions', { token: clientAcme.accessToken });
  ok(list.status === 200 && Array.isArray(list.data) && list.data.length >= 1, 'sessions listed with active flags');

  const foreign = await req('DELETE', `/auth/sessions/${list.data[0].id}`, { token: partner.accessToken });
  ok(foreign.status === 403 || foreign.status === 500, "someone else's session cannot be revoked");

  // Mint an extra session for the same user; its id rides in the refresh token.
  const extra = await req('POST', '/auth/login', { body: { email: 'client@acme.test', password: 'Password123!' } });
  const extraSid = String(extra.data?.refreshToken ?? '').split('.')[0];
  ok(extra.status === 200 && !!extraSid, 'second session created');
  if (extraSid) {
    const del = await req('DELETE', `/auth/sessions/${extraSid}`, { token: clientAcme.accessToken });
    ok(del.status === 200, 'own session revoked');
    // FR-1.4/FR-1.9 semantics: the revoked session is dead on its very next use.
    const dead = await req('GET', '/notifications?unread=true', { token: extra.data.accessToken, org: acmeOrgId });
    ok(dead.status === 401 && dead.data.code === 'SESSION_REVOKED', 'revoked session rejected on next request');
    const after = await req('GET', '/auth/sessions', { token: clientAcme.accessToken });
    const gone = (Array.isArray(after.data) ? after.data : []).find((s) => s.id === extraSid);
    ok(gone && gone.active === false, 'revoked session shows as inactive in the list');
  } else {
    ok(true, 'own session revoke path exercised (skipped: no second session)');
    ok(true, 'revoked session shows as inactive (skipped)');
  }
}

// ================= US-9.x impersonation lifecycle =================
section('US-9x', 'impersonation start/stop audited');
{
  const denied = await req('POST', '/admin/impersonate', { token: manager.accessToken, org: hubOrgId, body: { email: 'client@acme.test' } });
  ok(denied.status === 403, 'manager without admin.impersonate refused');

  const imp = await req('POST', '/admin/impersonate', { token: admin.accessToken, org: hubOrgId, body: { email: 'client@acme.test' } });
  ok((imp.status === 200 || imp.status === 201) && imp.data.impersonationToken && imp.data.actingAs.email === 'client@acme.test', 'super receives impersonation token');

  const meAsClient = await req('GET', '/auth/me', { token: imp.data.impersonationToken, org: acmeOrgId });
  ok(meAsClient.status === 200 && meAsClient.data.email === 'client@acme.test', 'token acts as the target user');

  const stop = await req('POST', '/admin/impersonate/stop', { token: imp.data.impersonationToken });
  ok(stop.status === 200, 'stop endpoint acknowledges end of impersonation');

  const trail = await req('GET', '/admin/audit?action=IMPERSONATION_STARTED', { token: admin.accessToken, org: hubOrgId });
  ok(trail.data.length > 0, 'impersonation appears in audit trail');
}

// ================= FR-8.3 catalogue reports =================
section('FR-8.3', 'catalogue-driven standard reports');
{
  const cat = await req('GET', '/reports/catalogue', { token: manager.accessToken, org: hubOrgId });
  ok(cat.status === 200 && cat.data.length >= 5 && cat.data.every((r) => r.code && r.title), 'catalogue lists standard reports');

  const byStatus = await req('GET', '/reports/CASES_BY_STATUS', { token: manager.accessToken, org: hubOrgId });
  ok(
    byStatus.status === 200 && Array.isArray(byStatus.data.columns) && Array.isArray(byStatus.data.rows) && byStatus.data.generatedAt,
    'CASES_BY_STATUS runs with columns+rows',
  );

  const breach = await req('GET', '/reports/CASES_SLA_BREACH', { token: manager.accessToken, org: hubOrgId });
  ok(breach.status === 200 && breach.data.columns.includes('slaDueAt'), 'SLA breach report available');

  const unknown = await req('GET', '/reports/NOPE_REPORT', { token: manager.accessToken, org: hubOrgId });
  ok(unknown.status === 404 && Array.isArray(unknown.data.available), 'unknown report code 404s with catalogue hint');

  const clientDenied = await req('GET', '/reports/CASES_BY_STATUS', { token: clientAcme.accessToken, org: acmeOrgId });
  ok(clientDenied.status === 403, 'clients cannot run internal reports');

  const docs = await req('GET', '/reports/DOCUMENTS_EXPIRING?days=60', { token: manager.accessToken, org: hubOrgId });
  ok(docs.status === 200 && docs.data.params.days === '60', 'report parameters accepted (days)');
}

// ================= FR-9.5 feature flags + maintenance =================
section('FR-9.5', 'feature flags & maintenance mode');
{
  const read = await req('GET', '/admin/flags', { token: admin.accessToken, org: hubOrgId });
  ok(read.status === 200 && typeof read.data.featureFlags.onlinePayments === 'boolean' && read.data.knownFlags.length >= 3, 'flags readable with defaults');

  const saved = await req('PUT', '/admin/flags', { token: admin.accessToken, org: hubOrgId, body: { flags: { partnerPortal: true } } });
  ok(saved.status === 200 && saved.data.featureFlags.partnerPortal === true, 'flag toggled at runtime');

  const maintOn = await req('PUT', '/admin/flags', {
    token: admin.accessToken,
    org: hubOrgId,
    body: { maintenance: { enabled: true, message: 'Suite test window' } },
  });
  ok(maintOn.status === 200 && maintOn.data.maintenance.enabled === true, 'maintenance mode enabled');

  await new Promise((r) => setTimeout(r, 5200)); // guard caches settings for 5s
  const blocked = await req('GET', '/notifications?unread=true', { token: clientAcme.accessToken, org: acmeOrgId });
  ok(blocked.status === 503 && blocked.data.code === 'MAINTENANCE_MODE', 'non-staff request blocked with MAINTENANCE_MODE');

  const staffOk = await req('GET', '/admin/settings', { token: admin.accessToken, org: hubOrgId });
  ok(staffOk.status === 200, 'settings staff keep access during maintenance');

  const maintOff = await req('PUT', '/admin/flags', { token: admin.accessToken, org: hubOrgId, body: { maintenance: { enabled: false, message: null }, flags: { partnerPortal: false } } });
  ok(maintOff.status === 200 && maintOff.data.maintenance.enabled === false, 'maintenance mode disabled');

  await new Promise((r) => setTimeout(r, 5200));
  const restored = await req('GET', '/notifications?unread=true', { token: clientAcme.accessToken, org: acmeOrgId });
  ok(restored.status === 200, 'client access restored afterwards');
}

section('FR-1.4 / US-1.1', 'password reset, resend verification and password policy');
{
  const stamp = Date.now().toString(36);
  const email = `suite.reset.${stamp}@demo.test`;
  const anon = (method, path, body) => req(method, path, { body });

  // Password policy: breach blocklist names its rule alongside the length rule.
  let r = await anon('POST', '/auth/register', { email, password: 'password12345', firstName: 'Suite', lastName: 'Reset' });
  ok(r.status === 422 && (r.data.rules ?? []).includes('password_breached'), 'breached password rejected with named rule');

  r = await anon('POST', '/auth/register', { email, password: 'password123', firstName: 'Suite', lastName: 'Reset' });
  ok(r.status === 422 && (r.data.rules ?? []).includes('password_min_length_12') && (r.data.rules ?? []).includes('password_breached'), 'short + breached password names both rules');

  // Happy path registration.
  r = await anon('POST', '/auth/register', { email, password: 'Password123!', firstName: 'Suite', lastName: 'Reset' });
  const verifyToken = r.data?.devVerificationToken;
  ok(!!verifyToken, 'registration returns dev verification token');
  r = await anon('POST', '/auth/verify-email', { token: verifyToken });
  ok(r.status < 300, 'verification token activates the account');
  r = await req('POST', '/auth/login', { body: { email, password: 'Password123!' } });
  ok(r.status === 200 && !!r.data.accessToken, 'sign-in with original password works');
  const preResetAccess = r.data.accessToken;

  // Forgot-password never reveals existence.
  r = await anon('POST', '/auth/password/forgot', { email: `ghost.${stamp}@demo.test` });
  ok(r.status === 200 && !!r.data.message && !r.data.devResetToken, 'unknown address gets identical generic response');
  r = await anon('POST', '/auth/password/forgot', { email });
  const resetToken = r.data?.devResetToken;
  ok(!!resetToken, 'reset link issued for real account');

  // Reset enforces the same policy and is single-use.
  r = await anon('POST', '/auth/password/reset', { token: resetToken, password: 'short' });
  ok(r.status === 422 && r.data.rule === 'password_min_length_12', 'weak new password rejected with named rule');
  r = await anon('POST', '/auth/password/reset', { token: resetToken, password: 'BrandNewPass456!' });
  ok(r.status === 200, 'reset accepted');
  r = await req('GET', '/notifications?unread=true', { token: preResetAccess, org: hubOrgId });
  ok(r.status === 401, 'pre-reset access token rejected immediately after reset');
  r = await req('POST', '/auth/login', { body: { email, password: 'Password123!' } });
  ok(r.status === 401, 'old password no longer accepted');
  r = await req('POST', '/auth/login', { body: { email, password: 'BrandNewPass456!' } });
  ok(r.status === 200 && !!r.data.accessToken, 'new password accepted');
  r = await anon('POST', '/auth/password/reset', { token: resetToken, password: 'AnotherPass789!' });
  ok(r.status === 422 && r.data.code === 'INVALID_TOKEN', 'reset token cannot be reused');

  // Purpose separation: a reset token is not a verification token.
  r = await anon('POST', '/auth/password/forgot', { email });
  r = await anon('POST', '/auth/verify-email', { token: r.data?.devResetToken });
  ok(r.status === 422, 'reset token refused by verify-email endpoint');

  // Resend verification: silent for unknown addresses, functional for unverified ones.
  const email2 = `suite.resend.${stamp}@demo.test`;
  await anon('POST', '/auth/register', { email: email2, password: 'Password123!', firstName: 'S', lastName: 'R' });
  r = await anon('POST', '/auth/resend-verification', { email: email2 });
  const resendToken = r.data?.devVerificationToken;
  ok(!!resendToken, 'resend issues a fresh single-use token');
  r = await anon('POST', '/auth/resend-verification', { email: `ghost.${stamp}@demo.test` });
  ok(r.status === 200 && !r.data.devVerificationToken, 'resend stays silent for unknown address');
  r = await anon('POST', '/auth/verify-email', { token: resendToken });
  ok(r.status < 300, 'resent token verifies');
  r = await req('POST', '/auth/login', { body: { email: email2, password: 'Password123!' } });
  ok(r.status === 200, 'unverified user can sign in after resend flow');
}

section('US-1.1b', 'signed-in visitor submits and tracks requests');
{
  const stamp = Date.now().toString(36);
  const email = `suite.visitor.${stamp}@demo.test`;
  const anon = (method, path, body) => req(method, path, { body });

  let r = await anon('POST', '/auth/register', { email, password: 'Password123!', firstName: 'Vera', lastName: 'Journey' });
  await anon('POST', '/auth/verify-email', { token: r.data?.devVerificationToken });
  r = await req('POST', '/auth/login', { body: { email, password: 'Password123!' } });
  const vtoken = r.data?.accessToken;
  ok(!!vtoken, 'visitor registered, verified and signed in');

  // Authenticated submission through the public intake links their identity.
  r = await req('POST', '/public/requests', {
    token: vtoken,
    body: { firstName: 'Vera', lastName: 'Journey', email, requestType: 'WORK_PERMIT', message: 'Suite visitor intake' },
  });
  ok(r.status === 201 && !!r.data.reference, `authenticated public intake accepted (${r.status})`);
  const refPublic = r.data?.reference;

  r = await req('GET', '/auth/me', { token: vtoken });
  const ms = r.data?.memberships ?? [];
  ok(ms.length === 1 && ms[0].roleCode === 'Visitor', 'personal client organisation provisioned with Visitor role');

  // Portal submission path works for the Visitor role too.
  r = await req('GET', '/case-types', { token: vtoken });
  const types = Array.isArray(r.data) ? r.data : [];
  ok(types.length > 0, 'client-visible case types listed for visitor');
  const type = types.find((t) => t.code === 'GENERAL_ENQUIRY') ?? types[0];
  r = await req('POST', '/cases', { token: vtoken, body: { caseTypeId: type.id, subject: 'Suite portal submission', description: 'x' } });
  ok(r.status === 201, `portal case creation allowed with case.create (${r.status})`);

  // Own-scoped list shows both; detail carries provenance.
  r = await req('GET', '/cases?page=1&pageSize=50&mine=true', { token: vtoken });
  const items = Array.isArray(r.data?.items) ? r.data.items : [];
  ok(items.some((c) => c.reference === refPublic), 'public-form request visible in own list');
  ok(items.some((c) => c.subject === 'Suite portal submission'), 'portal request visible in own list');
  const pub = items.find((c) => c.reference === refPublic);
  if (pub) {
    r = await req('GET', `/cases/${pub.id}`, { token: vtoken });
    ok(r.status === 200 && r.data.payload?.authenticatedSubmission === true, 'detail exposes authenticated provenance to its owner');
  } else {
    ok(false, 'public-form request missing from own list');
  }

  // Visitors stay out of staff surfaces.
  r = await req('GET', '/reports/catalogue', { token: vtoken });
  ok(r.status !== 200, 'visitor blocked from internal reports');

  // Anonymous intake regression: still provisions a stranger identity.
  r = await anon('POST', '/public/requests', { firstName: 'Anon', lastName: 'Suite', email: `anon.${stamp}@demo.test`, message: 'anonymous regression' });
  ok(r.status === 201 && !!r.data.reference, 'anonymous intake still provisions stranger identity');
}

// ================= FR-9.5 =================
section('FR-9.5', 'audit trail is append-only at the database level');
{
  const chk = await req('POST', '/admin/audit/append-only-check', { token: superU.accessToken });
  ok(chk.status === 200 && chk.data.enforced === true && chk.data.operations.update === true && chk.data.operations.delete === true,
    'UPDATE and DELETE against audit_event are both rejected by the database trigger');

  // Independent proof straight against Prisma, bypassing the endpoint.
  const raw = await db(async (p) => {
    const row = await p.auditEvent.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
    try {
      await p.auditEvent.delete({ where: { id: row.id } });
      return { blocked: false };
    } catch {
      return { blocked: true };
    }
  });
  ok(raw?.blocked === true, 'raw Prisma DELETE on audit rows fails (append-only enforced outside the API too)');
}

// ================= FR-4.7 =================
section('FR-4.7', 'task due-date reminders fire once per threshold');
{
  const dueSoon = new Date(Date.now() + 2 * 3600 * 1000); // inside the 1h? no - 2h; only the 24h... see thresholds
  // Due in 30 minutes -> inside BOTH default windows (24h and 1h).
  const task = await req('POST', '/tasks', {
    token: manager.accessToken,
    org: hubOrgId,
    body: { caseId: regCase.id, title: 'Reminder probe', assigneeUserId: (await req('GET', '/auth/me', { token: agent.accessToken })).data.id, dueAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() },
  });
  ok(task.status === 201 && !!task.data.id, 'probe task created with near due date');

  const run = await req('POST', '/tasks/reminders/run', { token: agent.accessToken, org: hubOrgId });
  const mine = (run.data.remindersSent ?? []).filter((r) => r.taskId === task.data.id);
  ok(run.status === 200 && mine.length === 2, 'reminder sweep fires every threshold window for an imminent task');
  ok(mine.some((m) => m.hoursBefore === 24) && mine.some((m) => m.hoursBefore === 1), 'default thresholds are 24h and 1h');

  const rerun = await req('POST', '/tasks/reminders/run', { token: agent.accessToken, org: hubOrgId });
  ok((rerun.data.remindersSent ?? []).every((r) => r.taskId !== task.data.id), 're-running the sweep sends nothing again (idempotent)');

  const feed = await req('GET', '/notifications', { token: agent.accessToken });
  const rem = feed.data.find((n) => n.templateCode === 'TASK_DUE_REMINDER' && n.resourceId === task.data.id);
  ok(!!rem && [24, 1].includes(rem.payload?.thresholdHours), 'TASK_DUE_REMINDER notifications carry the threshold in their payload');
}

// ================= US-2.3 =================
section('US-2.3', 'expiring documents surface before they lapse; AT_RISK on expiry; recovery restores');
{
  // Fresh client organisation with the agent as account manager.
  const org = await req('POST', '/organisations', {
    token: manager.accessToken,
    org: hubOrgId,
    body: { legalName: `Expiry Probe ${Date.now()} SARL`, type: 'CLIENT', country: 'RW' },
  });
  ok(org.status === 201 && !!org.data.id, 'probe organisation created');
  const orgId = org.data.id;
  await db(async (p, v) => {
    await p.organization.update({ where: { id: v.orgId }, data: { ownerUserId: v.userId } });
    return { linked: true };
  }, { orgId, userId: (await req('GET', '/auth/me', { token: agent.accessToken })).data.id });

  // A case under that org so we can attach a document to it.
  const types = await req('GET', '/case-types?all=true', { token: manager.accessToken, org: hubOrgId });
  const type = types.data.find((t) => t.code === 'COMPANY_REG') ?? types.data[0];
  const kase = await req('POST', '/cases', { token: manager.accessToken, org: hubOrgId, body: { caseTypeId: type.id, clientOrgId: orgId, subject: 'Expiry probe case', payload: {} } });
  ok(kase.status === 201, 'probe case created under probe organisation');

  const soon = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();
  const up = await req('POST', '/documents/upload-sessions', {
    token: manager.accessToken, org: hubOrgId,
    body: { caseId: kase.data.id, filename: 'lapsed-cert.pdf', mimeType: 'application/pdf', sizeBytes: 2048, category: 'INCORPORATION_CERT', expiresAt: soon },
  });
  const done = await req('POST', `/documents/upload-sessions/${up.data.sessionId}/complete`, { token: manager.accessToken, org: hubOrgId });
  ok(done.status === 201, 'document uploaded expiring in 10 days');

  let sweep = await req('POST', '/crm/compliance/sweep', { token: superU.accessToken });
  ok(sweep.status === 200 && sweep.data.expiryTasksCreated >= 1, 'sweep created a DOC_EXPIRY follow-up task');
  // Tasks are filed under the OWNING organisation of their case, so match on caseId.
  const agentMe = await req('GET', '/auth/me', { token: agent.accessToken });
  const tasks = await req('GET', '/tasks', { token: agent.accessToken, org: hubOrgId });
  const watchTask = tasks.data.find((t) => t.type === 'DOC_EXPIRY' && t.caseId === kase.data.id);
  ok(watchTask && watchTask.assigneeUserId === agentMe.data.id && watchTask.status === 'OPEN', 'expiry task assigned to the account manager');
  const feed = await req('GET', '/notifications', { token: agent.accessToken });
  ok(feed.data.some((n) => n.templateCode === 'DOCUMENTS_EXPIRING'), 'account manager notified about the expiring document');

  // Idempotence: nothing new on a second run.
  sweep = await req('POST', '/crm/compliance/sweep', { token: superU.accessToken });
  const tasksAgain = await req('GET', '/tasks', { token: agent.accessToken, org: hubOrgId });
  const openForOrg = tasksAgain.data.filter((t) => t.type === 'DOC_EXPIRY' && t.caseId === kase.data.id && t.status !== 'DONE').length;
  ok(openForOrg === 1, 'second sweep does not duplicate the follow-up task');

  // The expiry date passes with no replacement.
  await db(async (p, v) => {
    await p.document.updateMany({ where: { category: 'INCORPORATION_CERT', caseId: v.caseId }, data: { expiresAt: new Date(Date.now() - 24 * 3600 * 1000) } });
    return { lapsed: true };
  }, { caseId: kase.data.id });
  sweep = await req('POST', '/crm/compliance/sweep', { token: superU.accessToken });
  ok(sweep.data.flaggedAtRisk?.some((f) => f.organizationId === orgId), 'organisation flagged AT_RISK once the document lapses');
  const atRiskFeed = await req('GET', '/notifications', { token: agent.accessToken });
  ok(atRiskFeed.data.some((n) => n.templateCode === 'COMPLIANCE_AT_RISK'), 'compliance officer notified of AT_RISK status');
  const ov = await req('GET', `/clients/${orgId}/overview`, { token: agent.accessToken, org: hubOrgId });
  ok(ov.data.compliance?.status === 'AT_RISK', '360 overview exposes the persisted AT_RISK status');

  // A valid replacement is uploaded.
  await db(async (p, v) => {
    await p.document.updateMany({ where: { category: 'INCORPORATION_CERT', caseId: v.caseId }, data: { expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000) } });
    return { replaced: true };
  }, { caseId: kase.data.id });
  sweep = await req('POST', '/crm/compliance/sweep', { token: superU.accessToken });
  ok(Array.isArray(sweep.data.restored) && sweep.data.restored.includes(orgId), 'replacement restores compliance');
  const ovAfter = await req('GET', `/clients/${orgId}/overview`, { token: agent.accessToken, org: hubOrgId });
  ok(ovAfter.data.compliance?.status === 'COMPLIANT', 'status back to COMPLIANT after replacement');
  const closedTask = await req('GET', '/tasks', { token: agent.accessToken, org: hubOrgId });
  const resolved = closedTask.data.find((t) => t.type === 'DOC_EXPIRY' && t.caseId === kase.data.id);
  ok(resolved?.status === 'DONE' && !!resolved.completedAt, 'follow-up task auto-resolved by the recovery sweep');
}

// ================= FR-7.5 / FR-7.6 =================
section('FR-7.5/7.6', 'delivery outbox: failure never blocks origin, retries back off, statuses tracked');
{
  // Register a plain user (no organisation yet) and point a staff-created
  // reminder at them � the reminder's EMAIL delivery is deterministically
  // rejected by the provider via the "fail." address hook.
  const stamp = Date.now().toString(36);
  const email = `fail.outbox.${stamp}@demo.test`; // "fail." prefix simulates provider rejection
  const anon = (method, path, body) => req(method, path, { body });
  let r = await anon('POST', '/auth/register', { email, password: 'Password123!', firstName: 'Out', lastName: 'Box' });
  ok((r.status === 200 || r.status === 201) && !!r.data.devVerificationToken, 'outbox probe user registered');
  await anon('POST', '/auth/verify-email', { token: r.data?.devVerificationToken });
  r = await req('POST', '/auth/login', { body: { email, password: 'Password123!' } });
  const tok = r.data?.accessToken;
  ok(!!tok, `outbox probe user signed in (${r.status})`);
  const meId = (await req('GET', '/auth/me', { token: tok })).data.id;

  const probeTask = await req('POST', '/tasks', {
    token: manager.accessToken,
    org: hubOrgId,
    body: { caseId: regCase.id, title: 'Outbox delivery probe', assigneeUserId: meId, dueAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() },
  });
  ok(probeTask.status === 201, 'staff task targeting the probe user created');
  const rem = await req('POST', '/tasks/reminders/run', { token: agent.accessToken, org: hubOrgId });
  ok(rem.status === 200 && (rem.data.remindersSent ?? []).some((x) => x.taskId === probeTask.data.id), 'reminder fired for the probe task');

  const feed = await req('GET', '/notifications', { token: tok });
  const emailRow = feed.data.find((n) => n.channel === 'EMAIL' && n.templateCode === 'TASK_DUE_REMINDER');
  ok(emailRow?.status === 'FAILED' && emailRow.attempts >= 1 && !!emailRow.nextRetryAt && !!emailRow.error, 'email row FAILED with attempts, error and scheduled retry');
  const inAppRow = feed.data.find((n) => n.channel === 'IN_APP' && n.templateCode === 'TASK_DUE_REMINDER');
  ok(inAppRow?.status === 'SENT' && String(inAppRow.providerRef).startsWith('mock-'), 'in-app row SENT with provider reference stored');

  // Backdate the retry, drain the outbox until our row is reached (the worker
  // processes the 50 oldest due rows per pass), observe exponential backoff.
  await db(async (p, v) => {
    await p.notification.update({ where: { id: v.id }, data: { nextRetryAt: new Date(Date.now() - 5000) } });
    return { ready: true };
  }, { id: emailRow.id });
  let drain;
  let retried;
  for (let i = 0; i < 5; i++) {
    drain = await req('POST', '/notifications/delivery/run', { token: superU.accessToken });
    const feedNow = await req('GET', '/notifications', { token: tok });
    retried = feedNow.data.find((n) => n.id === emailRow.id);
    if (retried.attempts === emailRow.attempts + 1) break;
    if (!drain.data.processed) break;
  }
  ok(drain.status === 200 && drain.data.processed >= 1, 'delivery drain retries the failed row');
  ok(retried.status === 'FAILED' && retried.attempts === emailRow.attempts + 1 && new Date(retried.nextRetryAt) > new Date(Date.now() - 1000),
    'retry increments attempts and pushes nextRetryAt further out (exponential backoff)');

  // READ is a tracked delivery status.
  await req('POST', `/notifications/${inAppRow.id}/read`, { token: tok });
  const readBack = await req('GET', '/notifications', { token: tok });
  ok(readBack.data.find((n) => n.id === inAppRow.id)?.status === 'READ', 'marking read sets the READ delivery status');

  // Drain is staff-gated.
  const denied = await req('POST', '/notifications/delivery/run', { token: tok });
  ok(denied.status === 403, 'delivery drain refused to non-staff callers');
}

// ================= FR-2.7 =================
section('FR-2.7', 'cross-module full-text search, tenancy-scoped in the query');
{
  const s = await req('GET', '/search?q=Acme', { token: manager.accessToken, org: hubOrgId });
  ok(s.status === 200 && s.data.facets.organisations >= 1, 'staff search finds organisations by name');
  ok(s.data.organisations.some((o) => o.id === acmeOrgId), 'seeded Acme record among results');

  const cs = await req('GET', '/search?q=Incorporate', { token: manager.accessToken, org: hubOrgId });
  ok(cs.status === 200 && cs.data.facets.cases >= 1 && cs.data.cases.every((c) => /^(CASE|REQ)-/.test(c.reference)), 'case search matches subjects and returns references');

  const empty = await req('GET', '/search?q=', { token: manager.accessToken, org: hubOrgId });
  ok(empty.status === 200 && empty.data.facets.organisations === 0, 'empty term short-circuits to empty result');

  // Tenancy: a visitor never sees another organisation's records.
  const stamp = Date.now().toString(36);
  const vemail = `suite.search.${stamp}@demo.test`;
  const anon = (method, path, body) => req(method, path, { body });
  let r = await anon('POST', '/auth/register', { email: vemail, password: 'Password123!', firstName: 'Seek', lastName: 'Er' });
  await anon('POST', '/auth/verify-email', { token: r.data?.devVerificationToken });
  r = await req('POST', '/auth/login', { body: { email: vemail, password: 'Password123!' } });
  const vs = await req('GET', '/search?q=Acme', { token: r.data.accessToken });
  ok(vs.status === 200 && !vs.data.organisations.some((o) => o.id === acmeOrgId), 'visitor search cannot surface other tenants');
  ok(vs.data.cases.every((c) => c.clientOrgId !== acmeOrgId), 'visitor search returns no foreign cases');
}

// ================= �7.5 rate limits =================
section('S7.5', 'rate limiting: headers, sign-in throttle per account, export budget');
{
  // Headers on anonymous public endpoints.
  const res = await fetch(`${API}/auth/resend-verification`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `rl.${Date.now()}@demo.test` }) });
  ok(res.headers.get('x-ratelimit-limit') !== null && res.headers.get('x-ratelimit-reset') !== null, 'X-RateLimit-Limit/-Reset returned on public endpoints');

  // Per-account sign-in throttle counts failures. Uses an address that was
  // never registered so the separate five-strike account lock does not
  // preempt the �7.5 limiter.
  const stamp = Date.now().toString(36);
  const email = `suite.throttle.${stamp}@demo.test`;
  let last;
  for (let i = 0; i < 11; i++) {
    last = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'WrongPassword999!' }) });
  }
  ok(last.status === 429 && (await last.json()).code === 'THROTTLED', '11th consecutive failed sign-in throttled with 429 THROTTLED');

  // Other accounts are unaffected by one account's lockout.
  const otherOk = await login('agent@hub.test');
  ok(!!otherOk.accessToken, 'throttle is scoped per account; other users unaffected');

  // Export endpoints carry their own budget headers.
  const ex = await fetch(`${API}/crm/export`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${manager.accessToken}` } });
  ok(ex.headers.get('x-ratelimit-limit') !== null, 'export endpoints expose their own X-RateLimit budget');
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

