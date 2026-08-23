import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { UserContext } from '../abilities/case-ability.service';

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): UserContext => {
  const request = ctx.switchToHttp().getRequest();
  return request.context;
});
