import { Controller, Get, Post, Param, Body, HttpCode } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { UserContext } from '../../common/abilities/case-ability.service';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

@Controller('v1')
export class CaseTypesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('case-types')
  async list(@CurrentUser() ctx: UserContext) {
    const isClient = ctx.roleCode === 'Client' || ctx.roleCode === 'Visitor';
    return this.prisma.caseType.findMany({
      where: { isActive: true, ...(isClient ? { isClientVisible: true } : {}) },
      orderBy: { name: 'asc' },
    });
  }

  /** US-9.2: administrators add a case type without a release; invalid JSON Schema refused. */
  @Post('admin/reference/case-types')
  @HttpCode(201)
  async create(@CurrentUser() ctx: UserContext, @Body() body: any) {
    if (!ctx.permissions.includes('admin.reference.manage') && !ctx.permissions.includes('*')) {
      throw new ForbiddenException({ code: 'PERMISSION_DENIED', required: 'admin.reference.manage' });
    }
    if (body.formSchema != null) {
      try {
        if (typeof body.formSchema === 'string') JSON.parse(body.formSchema);
      } catch (e) {
        throw new NotFoundException({ code: 'INVALID_JSON_SCHEMA', parseError: String(e) });
      }
    }
    return this.prisma.caseType.create({
      data: {
        code: body.code,
        name: body.name,
        description: body.description,
        formSchema: body.formSchema ?? {},
        requiredDocs: body.requiredDocs ?? [],
        slaHours: body.slaHours ?? 72,
        approvalLevels: body.approvalLevels ?? 1,
        isClientVisible: body.isClientVisible ?? true,
      },
    });
  }
}
