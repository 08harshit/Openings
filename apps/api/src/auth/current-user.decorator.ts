import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from './auth.service';
import type { RequestWithUser } from './auth.guard';

/**
 * Injects the authenticated user, or a single field of it:
 *   handler(@CurrentUser() user: AuthenticatedUser)
 *   handler(@CurrentUser('id') userId: string)
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    return field ? request.user?.[field] : request.user;
  },
);
