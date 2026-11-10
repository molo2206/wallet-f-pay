// apps/api-gateway/src/maintenance/maintenance.interceptor.ts
import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { PrismaService } from 'apps/user-service/src/prisma/prisma.service';
import { MaintenanceService } from './maintenance.service';
import { MaintenanceWindow, blockingDecision, isExempt, modulesOfRoute, retryAfterSeconds } from './maintenance.util';

/**
 * ✅ Application du mode maintenance à CHAQUE requête HTTP (côté serveur, impossible à contourner par l'application).
 *  Réponse 503 { code: 'MAINTENANCE', message (langue de l'en-tête lang), maintenance: { scope, modules, endsAt } }
 *  + en-tête Retry-After. Les personnes exemptées (rôles / comptes / IP de la fenêtre) passent normalement.
 *  Connexion pendant une maintenance complète : seuls les comptes exemptés peuvent se connecter.
 */
@Injectable()
export class MaintenanceInterceptor implements NestInterceptor {
  constructor(
    private readonly maintenance: MaintenanceService,
    private readonly prisma: PrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http' || String(process.env.MAINTENANCE_ENABLED ?? 'true').toLowerCase() === 'false') return next.handle();
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    return from(this.check(req, res)).pipe(mergeMap(() => next.handle()));
  }

  private clientIp(req: any): string {
    const fwd = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    return fwd || req?.ip || req?.socket?.remoteAddress || '';
  }

  /** Rôle du compte qui tente de se connecter (identifiant = téléphone, e-mail ou numéro de compte) */
  private async loginRole(body: any): Promise<{ id: string; role: string } | null> {
    const identifier = String(body?.identifier || body?.email || body?.phone || '').trim();
    if (!identifier) return null;
    const digits = identifier.replace(/[^0-9]/g, '');
    const rows: any[] = await (this.prisma as any)
      .$queryRawUnsafe(
        'SELECT `id`, `role` FROM `user` WHERE (`email` = ? OR `account_number` = ? OR (? <> \'\' AND `phone` = ?)) AND (`deleted` = 0 OR `deleted` IS NULL) LIMIT 1',
        identifier,
        identifier,
        digits,
        digits,
      )
      .catch(() => []);
    return rows?.[0] ?? null;
  }

  private async check(req: any, res: any): Promise<void> {
    const actives: MaintenanceWindow[] = await this.maintenance.allActive().catch(() => []);
    if (!actives.length) return;
    const method = String(req.method || 'GET').toUpperCase();
    const path = String(req.path || req.url || '').split('?')[0];
    const user = req.currentUser || req.user || null;
    const requester = { method, path, ip: this.clientIp(req), role: user?.role ?? null, userId: user?.id ?? null };

    for (const w of actives) {
      let decision = blockingDecision(w, requester);
      if (!decision) continue;
      // Connexion : on regarde à qui appartient l'identifiant (les comptes exemptés peuvent se connecter)
      if (!user && modulesOfRoute(method, path).includes('LOGIN')) {
        const target = await this.loginRole(req.body);
        if (target && isExempt(w, { ...requester, role: target.role, userId: target.id })) decision = null;
      }
      if (!decision) continue;

      const lang = String(req.headers?.['lang'] || req.headers?.['accept-language'] || 'fr').slice(0, 2);
      try {
        res.setHeader('Retry-After', String(retryAfterSeconds(w)));
      } catch {
        /* en-têtes déjà envoyés */
      }
      throw new HttpException(
        {
          statusCode: 503,
          code: 'MAINTENANCE',
          message: await this.maintenance.message(w, lang),
          maintenance: {
            id: w.legacy ? null : w.id,
            title: w.title,
            scope: w.scope,
            modules: w.scope === 'MODULES' ? decision.modules : w.modules,
            endsAt: w.endsAt,
            endsAtLabel: await this.maintenance.formatDate(w.endsAt, lang),
          },
        },
        503,
      );
    }
  }
}
