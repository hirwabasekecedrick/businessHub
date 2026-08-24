import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  ForbiddenException,
} from '@nestjs/common';

/**
 * Spec requirement: users must never see *which* permission was checked when
 * access is denied — only that they have no ability to access the resource.
 * Strip permission identifiers from every PERMISSION_DENIED payload.
 */
@Catch(ForbiddenException)
export class SanitizeDenialFilter implements ExceptionFilter {
  catch(exception: ForbiddenException, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const body = exception.getResponse();

    if (typeof body === 'object' && body !== null) {
      const sanitized: Record<string, unknown> = { ...(body as object) };
      delete sanitized['required'];
      delete sanitized['missingPermission'];
      delete sanitized['permission'];
      return res.status(exception.getStatus()).json(sanitized);
    }

    return res.status(exception.getStatus()).json({
      code: 'PERMISSION_DENIED',
      message: 'You do not have ability to access this resource',
    });
  }
}
