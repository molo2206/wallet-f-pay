// apps/auth-service/src/utility/decorators/current-user-decorator.ts

import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    
    // ✅ Essayer plusieurs sources possibles
    const user = request.user || request.currentUser || request.userData || null;
    
    console.log('[CurrentUser] User récupéré:', {
      hasUser: !!request.user,
      hasCurrentUser: !!request.currentUser,
      hasUserData: !!request.userData,
      userId: user?.id,
      branchId: user?.branchId || user?.branch?.id,
    });
    
    return user;
  },
);