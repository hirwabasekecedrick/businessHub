import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { UserContext } from '../../common/abilities/case-ability.service';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../../common/audit.service';
import { NotificationService } from '../../common/notification.service';
import * as argon2 from 'argon2';
import { JwtService } from '@nestjs/jwt';
// @ts-ignore
import * as crypto from 'crypto';

const JWT_ACCESS_TTL_S = parseInt(process.env.JWT_ACCESS_TTL || '900', 10);

@Injectable()
export class IdentityService {
  private mfaChallenges = new Map<string, { userId: string; expiresAt: number; attempts: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  private getPepper() {
    return process.env.PASSWORD_PEPPER || '';
  }

  private hash(value: string) {
    return argon2.hash(value + this.getPepper(), {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });
  }

  async register(data: any) {
    const email = String(data.email ?? '').toLowerCase();
    const password = String(data.password ?? '');
    if (!email || !password || password.length < 12) {
      throw new UnprocessableEntityException({
        code: 'VALIDATION_FAILED',
        rule: 'password_min_length_12',
        message: 'Password must be at least 12 characters',
      });
    }

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (!existing) {
      const passwordHash = await this.hash(password);
      await this.prisma.user.create({
        data: {
          email,
          passwordHash,
          firstName: data.firstName || 'Unknown',
          lastName: data.lastName || 'User',
          status: 'INVITED',
        },
      });
    }
    // Identical response either way: enumeration is not possible (US-1.1).
    const response: any = {
      message: 'Registration processed. If the email is valid, a verification link has been sent.',
    };
    if (process.env.DEV_HEADER_AUTH === 'true') {
      const issued = await this.issueEmailVerification(email);
      if (issued) response.devVerificationToken = issued.token;
    }
    return response;
  }

  /** Issues a single-use email verification token (returned in local dev for testing). */
  async issueEmailVerification(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || user.emailVerifiedAt) return null;
    const token = crypto.randomBytes(24).toString('hex');
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: await this.hash(token),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { userId: user.id, token };
  }

  async verifyEmail(token: string) {
    const rows = await this.prisma.passwordResetToken.findMany({
      where: { usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    let matched: (typeof rows)[number] | null = null;
    for (const row of rows) {
      if (await argon2.verify(row.tokenHash, token + this.getPepper()).catch(() => false)) {
        matched = row;
        break;
      }
    }
    if (!matched) throw new UnprocessableEntityException({ code: 'INVALID_TOKEN' });

    const user = await this.prisma.user.findUnique({ where: { id: matched.userId } });
    if (!user) throw new UnprocessableEntityException({ code: 'INVALID_TOKEN' });

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { status: 'ACTIVE', emailVerifiedAt: new Date() },
      }),
      this.prisma.passwordResetToken.update({ where: { id: matched.id }, data: { usedAt: new Date() } }),
    ]);
    await this.audit.record({ actorUserId: user.id, action: 'EMAIL_VERIFIED', resourceType: 'user', resourceId: user.id });
    return { message: 'Email verified successfully' };
  }

  async login(email: string, password: string, ip: string, userAgent: string) {
    const user = await this.prisma.user.findUnique({ where: { email: String(email ?? '').toLowerCase() } });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS' });
    }
    if (user.status === 'INVITED' && !user.emailVerifiedAt) {
      throw new UnauthorizedException({ code: 'EMAIL_NOT_VERIFIED', message: 'Please verify your email first' });
    }
    if (user.status === 'DISABLED') {
      throw new UnauthorizedException({ code: 'ACCOUNT_DEACTIVATED' });
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException({ code: 'ACCOUNT_LOCKED' });
    }

    const valid = await argon2.verify(user.passwordHash, password + this.getPepper()).catch(() => false);
    if (!valid) {
      const failedAttempts = user.failedAttempts + 1;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedAttempts,
          lockedUntil: failedAttempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null,
        },
      });
      await this.audit.record({
        actorUserId: user.id,
        action: 'LOGIN_FAILED',
        resourceType: 'session',
        ip,
        userAgent,
        outcome: 'DENIED',
      });
      if (failedAttempts >= 5) {
        await this.notifications.notify({
          recipientId: user.id,
          eventKey: 'SECURITY_ACCOUNT_LOCKED',
          urgent: true,
          variables: { reason: 'Five consecutive failed sign-in attempts' },
        });
      }
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS' });
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    await this.audit.record({ actorUserId: user.id, action: 'LOGIN', resourceType: 'session', ip, userAgent });

    if (user.mfaSecret && user.mfaEnabledAt) {
      const challengeId = crypto.randomUUID();
      this.mfaChallenges.set(challengeId, { userId: user.id, expiresAt: Date.now() + 5 * 60 * 1000, attempts: 0 });
      throw new UnauthorizedException({
        code: 'MFA_REQUIRED',
        challengeId,
      });
    }

    return this.generateTokens(user.id, ip, userAgent);
  }

  private async generateTokens(userId: string, ip: string, userAgent: string, familyId?: string) {
    const accessToken = this.jwtService.sign(
      { sub: userId },
      familyId ? {} : {},
    );
    // Opaque refresh token: <sessionId>.<secret> so it can be looked up cheaply.
    const sessionId = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString('hex');
    const refreshTokenHash = await argon2.hash(secret);
    await this.prisma.session.create({
      data: {
        id: sessionId,
        userId,
        refreshTokenHash,
        familyId: familyId ?? crypto.randomUUID(),
        userAgent,
        ip: ip?.startsWith('::1') ? '127.0.0.1' : ip || '0.0.0.0',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    return {
      accessToken,
      expiresIn: JWT_ACCESS_TTL_S,
      refreshToken: `${sessionId}.${secret}`,
    };
  }

  async verifyMfa(challengeId: string, code: string, ip: string, userAgent: string) {
    const challenge = this.mfaChallenges.get(challengeId);
    if (!challenge || challenge.expiresAt < Date.now()) {
      this.mfaChallenges.delete(challengeId);
      throw new UnauthorizedException({ code: 'MFA_CHALLENGE_INVALID' });
    }
    const user = await this.prisma.user.findUnique({ where: { id: challenge.userId } });
    if (!user || !user.mfaSecret) throw new UnauthorizedException({ code: 'MFA_CHALLENGE_INVALID' });

    let isValid = false;
    try {
      isValid = this.verifyTotp(user.mfaSecret, String(code ?? ''));
    } catch {
      isValid = false;
    }

    if (!isValid) {
      // Recovery code path (format XXXX-XXXX)
      if (/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
        const codes = await this.prisma.recoveryCode.findMany({
          where: { userId: user.id, usedAt: null },
        });
        let consumed: string | null = null;
        for (const rc of codes) {
          if (this.scryptVerify(rc.codeHash, code)) {
            consumed = rc.id;
            break;
          }
        }
        if (consumed) {
          await this.prisma.recoveryCode.update({ where: { id: consumed }, data: { usedAt: new Date() } });
          await this.notifications.notify({
            recipientId: user.id,
            eventKey: 'SECURITY_RECOVERY_CODE_USED',
            urgent: true,
            variables: { at: new Date().toISOString() },
          });
          this.mfaChallenges.delete(challengeId);
          return this.generateTokens(user.id, ip, userAgent);
        }
      }
      challenge.attempts += 1;
      if (challenge.attempts >= 3) this.mfaChallenges.delete(challengeId);
      throw new UnauthorizedException({ code: 'MFA_CODE_INVALID' });
    }

    this.mfaChallenges.delete(challengeId);
    return this.generateTokens(user.id, ip, userAgent);
  }

  async refresh(refreshToken: string, ip: string, userAgent: string) {
    const [sessionId, secret] = String(refreshToken ?? '').split('.');
    if (!sessionId || !secret) throw new UnauthorizedException({ code: 'INVALID_REFRESH' });

    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    const hashOk = session
      ? await argon2.verify(session.refreshTokenHash, secret + this.getPepper()).catch(() => false)
      : false;

    if (!session || !hashOk) throw new UnauthorizedException({ code: 'INVALID_REFRESH' });

    if (session.revokedAt) {
      // Reuse of a consumed token: revoke the whole family and raise an alert.
      await this.prisma.session.updateMany({
        where: { familyId: session.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.notifications.notify({
        recipientId: session.userId,
        eventKey: 'SECURITY_TOKEN_REUSE',
        urgent: true,
        variables: { at: new Date().toISOString() },
      });
      await this.audit.record({
        actorUserId: session.userId,
        action: 'REFRESH_TOKEN_REUSE',
        resourceType: 'session',
        resourceId: session.id,
        outcome: 'DENIED',
        ip,
        userAgent,
      });
      throw new UnauthorizedException({ code: 'TOKEN_FAMILY_REVOKED' });
    }

    if (session.expiresAt < new Date()) throw new UnauthorizedException({ code: 'INVALID_REFRESH' });

    // Single use with rotation.
    await this.prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    return this.generateTokens(session.userId, ip, userAgent, session.familyId);
  }

  async logout(refreshToken: string, ctx?: UserContext, ip?: string, userAgent?: string) {
    const [sessionId] = String(refreshToken ?? '').split('.');
    if (sessionId) {
      const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
      if (session && (!ctx || session.userId === ctx.id)) {
        await this.prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
        await this.audit.record({ actorUserId: session.userId, action: 'LOGOUT', resourceType: 'session', resourceId: sessionId, ip, userAgent });
      }
    }
    return { message: 'Signed out' };
  }

  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email: String(email ?? '').toLowerCase() } });
    let devToken: string | undefined;
    if (user && user.status !== 'DISABLED') {
      const token = crypto.randomBytes(24).toString('hex');
      devToken = ((process.env.DEV_HEADER_AUTH ?? 'true') === 'true') ? token : undefined;
      await this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: await this.hash(token),
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });
      await this.notifications.notify({
        recipientId: user.id,
        eventKey: 'AUTH_PASSWORD_RESET_REQUESTED',
        urgent: true,
        variables: {},
      });
    }
    return {
      message: 'If an account exists, a reset link was sent.',
      ...(devToken ? { devResetToken: devToken } : {}),
    };
  }

  async resetPassword(token: string, newPassword: string) {
    if (!newPassword || newPassword.length < 12) {
      throw new UnprocessableEntityException({
        code: 'VALIDATION_FAILED',
        rule: 'password_min_length_12',
      });
    }
    const rows = await this.prisma.passwordResetToken.findMany({
      where: { usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    let matched: (typeof rows)[number] | null = null;
    for (const row of rows) {
      if (await argon2.verify(row.tokenHash, token + this.getPepper()).catch(() => false)) {
        matched = row;
        break;
      }
    }
    if (!matched) throw new UnprocessableEntityException({ code: 'INVALID_TOKEN' });

    const passwordHash = await this.hash(newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: matched.userId }, data: { passwordHash } }),
      this.prisma.passwordResetToken.update({ where: { id: matched.id }, data: { usedAt: new Date() } }),
      // Reset revokes all existing sessions (FR-1.4)
      this.prisma.session.updateMany({ where: { userId: matched.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await this.audit.record({ actorUserId: matched.userId, action: 'PASSWORD_RESET', resourceType: 'user', resourceId: matched.userId });
    return { message: 'Password updated. All sessions were revoked.' };
  }

  async getMe(ctx: UserContext) {
    const user = await this.prisma.user.findUnique({
      where: { id: ctx.id },
      include: {
        memberships: { where: { deletedAt: null }, include: { role: true, organization: true } },
      },
    });
    if (!user) throw new UnauthorizedException({ code: 'AUTH_REQUIRED' });
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      locale: user.locale,
      timezone: user.timezone,
      status: user.status,
      mfaEnabled: !!user.mfaEnabledAt,
      memberships: user.memberships.map((m) => ({
        organizationId: m.organization.id,
        legalName: m.organization.legalName,
        type: m.organization.type,
        roleId: m.role.id,
        roleCode: m.role.code,
        roleName: m.role.name,
        permissions: m.role.permissions,
        approvalLevel: m.role.approvalLevel,
        isDefault: m.isDefault,
      })),
    };
  }

  async getSessions(ctx: UserContext) {
    const sessions = await this.prisma.session.findMany({
      where: { userId: ctx.id },
      orderBy: { createdAt: 'desc' },
    });
    return sessions.map((s) => ({
      id: s.id,
      device: s.userAgent,
      ip: s.ip,
      lastSeen: s.createdAt,
      expiresAt: s.expiresAt,
      revokedAt: s.revokedAt,
      active: !s.revokedAt && s.expiresAt > new Date(),
    }));
  }

  async revokeSession(ctx: UserContext, sessionId: string) {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== ctx.id) throw new ForbiddenException({ code: 'PERMISSION_DENIED' });
    await this.prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
    await this.audit.record({ actorUserId: ctx.id, action: 'SESSION_REVOKED', resourceType: 'session', resourceId: sessionId });
    return { message: 'Session revoked' };
  }

  async enrolMfa(ctx: UserContext) {
    const secret = this.generateTotpSecret();
    await this.prisma.user.update({ where: { id: ctx.id }, data: { mfaSecret: secret, mfaEnabledAt: null } });
    const uri = this.totpKeyuri(ctx.email ?? ctx.id, 'BusinessHub', secret);
    return { uri, secret }; // QR is rendered client-side from the otpauth URI.
  }

  // ---- RFC 6238 TOTP (self-contained; no external OTP dependency) ----

  private readonly BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  private generateTotpSecret(): string {
    const buf = crypto.randomBytes(20);
    let bits = '';
    for (const byte of buf) bits += byte.toString(2).padStart(8, '0');
    let out = '';
    for (let i = 0; i + 5 <= bits.length; i += 5) out += this.BASE32[parseInt(bits.slice(i, i + 5), 2)];
    return out;
  }

  private base32Decode(input: string): Buffer {
    let bits = '';
    for (const ch of input.replace(/=+$/, '').toUpperCase()) {
      const idx = this.BASE32.indexOf(ch);
      if (idx === -1) continue;
      bits += idx.toString(2).padStart(5, '0');
    }
    const bytes: number[] = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
    return Buffer.from(bytes);
  }

  private totpAt(secretB32: string, counter: number): string {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', this.base32Decode(secretB32)).update(buf).digest();
    const off = hmac[hmac.length - 1] & 0xf;
    const code =
      ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3];
    return String(code % 1_000_000).padStart(6, '0');
  }

  /** Accepts the current window plus one step of clock drift either way. */
  verifyTotp(secretB32: string, token: string): boolean {
    const t = Math.floor(Date.now() / 30_000);
    return [t - 1, t, t + 1].some((c) => this.totpAt(secretB32, c) === String(token ?? ''));
  }

  private totpKeyuri(account: string, issuer: string, secret: string): string {
    return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  }

  async confirmMfa(ctx: UserContext, code: string) {
    const user = await this.prisma.user.findUnique({ where: { id: ctx.id } });
    if (!user?.mfaSecret) throw new UnprocessableEntityException({ code: 'MFA_NOT_ENROLLED' });
    const ok = this.verifyTotp(user.mfaSecret, String(code ?? ''));
    if (!ok) throw new UnprocessableEntityException({ code: 'MFA_CODE_INVALID' });

    const codes = Array.from({ length: 10 }, () =>
      `${crypto.randomBytes(2).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`,
    );
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: ctx.id }, data: { mfaEnabledAt: new Date() } }),
      ...codes.map((c) => this.prisma.recoveryCode.create({ data: { userId: ctx.id, codeHash: this.hashSync(c) } })),
    ]);
    await this.audit.record({ actorUserId: ctx.id, action: 'MFA_ENABLED', resourceType: 'user', resourceId: ctx.id });
    return { message: 'MFA enabled', recoveryCodes: codes };
  }

  private hashSync(value: string): string {
    // Deterministic-enough sync hashing for recovery codes using scrypt.
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(value + this.getPepper(), salt, 32).toString('hex');
    return `scrypt:${salt}:${derived}`;
  }

  private scryptVerify(stored: string, value: string): boolean {
    const [scheme, salt, hex] = String(stored ?? '').split(':');
    if (scheme !== 'scrypt' || !salt || !hex) return false;
    const derived = crypto.scryptSync(value + this.getPepper(), salt, 32).toString('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(derived), Buffer.from(hex));
    } catch {
      return false;
    }
  }

  async disableMfa(ctx: UserContext) {
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: ctx.id }, data: { mfaSecret: null, mfaEnabledAt: null } }),
      this.prisma.recoveryCode.deleteMany({ where: { userId: ctx.id } }),
    ]);
    await this.audit.record({ actorUserId: ctx.id, action: 'MFA_DISABLED', resourceType: 'user', resourceId: ctx.id });
    return { message: 'MFA disabled' };
  }
}
