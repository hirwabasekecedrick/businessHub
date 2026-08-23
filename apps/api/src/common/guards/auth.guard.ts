import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit.service';
import { UserContext } from '../abilities/case-ability.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);

    let userId: string | undefined;
    let impersonating = false;
    if (token) {
      try {
        const payload = await this.jwtService.verifyAsync(token);
        // Impersonation tokens carry imp=true plus act=<super admin id>.
        impersonating = payload.imp === true;
        userId = payload.sub;
        request.jwt = payload;
        request.actorUserId = impersonating ? payload.act : payload.sub;
      } catch {
        throw new UnauthorizedException({ code: 'AUTH_REQUIRED' });
      }
    } else {
      // Local-development header authentication (DEV_HEADER_AUTH, default on).
      // Production must set DEV_HEADER_AUTH=false.
      const devMode = (process.env.DEV_HEADER_AUTH ?? 'true') === 'true';
      const headerUser = request.headers['x-user-id'];
      if (!devMode || !headerUser) {
        throw new UnauthorizedException({ code: 'AUTH_REQUIRED' });
      }
      userId = headerUser;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: { where: { deletedAt: null }, include: { role: true, organization: true } },
      },
    });

    if (!user || user.status === 'DISABLED' || user.deletedAt) {
      throw new UnauthorizedException({ code: 'AUTH_REQUIRED' });
    }

    const requestedOrg = request.headers['x-organization-id'];
    let membership = user.memberships.find((m) => m.organizationId === requestedOrg);
    if (requestedOrg && !membership) {
      await this.audit.record({
        actorUserId: user.id,
        organizationId: requestedOrg,
        action: 'ORG_SWITCH_DENIED',
        resourceType: 'organization',
        resourceId: requestedOrg,
        outcome: 'DENIED',
      });
      throw new ForbiddenException({ code: 'ORG_FORBIDDEN' });
    }
    membership = membership ?? user.memberships.find((m) => m.isDefault) ?? user.memberships[0];

    const ctx: UserContext = {
      id: user.id,
      organizationId: membership?.organizationId,
      permissions: membership ? [...membership.role.permissions] : [],
      isImpersonating: impersonating,
      email: user.email,
      roleCode: membership?.role.code,
      approvalLevel: membership?.role.approvalLevel ?? 0,
      memberships: user.memberships.map((m) => ({
        organizationId: m.organizationId,
        roleId: m.roleId,
        roleCode: m.role.code,
        isDefault: m.isDefault,
      })),
    };
    request.context = ctx;
    return true;
  }

  private extractTokenFromHeader(request: any): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
