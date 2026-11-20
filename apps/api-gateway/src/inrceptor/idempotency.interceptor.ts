// apps/api-gateway/src/inrceptor/idempotency.interceptor.ts
import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
  OnModuleDestroy,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Observable, from, of, throwError } from 'rxjs';
import { catchError, mergeMap, tap } from 'rxjs/operators';
import * as crypto from 'crypto';
import { PrismaService } from 'apps/user-service/src/prisma/prisma.service';
import { canonicalJson, isFinancialRoute, ownerOf, requestKeyOf } from './idempotency.util';

/**
 * ✅ IDEMPOTENCE DES OPÉRATIONS FINANCIÈRES (anti double traitement)
 *
 * Sur les routes qui déplacent de l'argent (recharge, retrait, envoi, paiement, conversion, validation…) :
 *  1. Clé explicite : en-tête `Idempotency-Key` (ou `X-Idempotency-Key`, ou `idempotencyKey` / `requestId` du corps).
 *     → la même clé renvoie TOUJOURS le même résultat (rejoué tel quel, en-tête `Idempotent-Replayed: true`),
 *       sans refaire l'opération. Même clé avec un contenu différent → 422.
 *  2. Sans clé (anciennes applications) : empreinte automatique (compte + route + contenu exact) pendant
 *     IDEMPOTENCY_AUTO_WINDOW_SECONDS (30 s) → un double clic ou une répétition immédiate n'est pas exécuté deux fois.
 *  3. Requête identique encore en cours → 409 « opération déjà en cours ».
 *  4. Timeout / erreur serveur (le wallet-service peut avoir terminé) → la clé reste bloquée
 *     IDEMPOTENCY_UNCERTAIN_LOCK_MINUTES (10 min) : on ne relance pas à l'aveugle une opération peut-être faite.
 *  5. Refus métier (4xx : solde insuffisant, PIN faux…) → la clé est libérée : l'utilisateur peut corriger et réessayer.
 *
 * Stockage : table `idempotency_requests` (partagée entre instances du gateway, nettoyée automatiquement).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IdempotencyInterceptor.name);
  private cleanupTimer: NodeJS.Timeout | null = null;
  private tableMissingLogged = false;

  constructor(private readonly prisma: PrismaService) {}

  private num(name: string, def: number): number {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : def;
  }

  private get enabled(): boolean {
    return String(process.env.IDEMPOTENCY_ENABLED ?? 'true').toLowerCase() !== 'false';
  }

  onModuleInit() {
    this.cleanupTimer = setInterval(() => void this.cleanup(), 60 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  private async cleanup() {
    try {
      await (this.prisma as any).$executeRawUnsafe(
        'DELETE FROM `idempotency_requests` WHERE `expires_at` < NOW(3) LIMIT 5000',
      );
    } catch {
      /* table absente : rien à nettoyer */
    }
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (!this.enabled || context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const method = String(req.method || '').toUpperCase();
    const path = String(req.path || req.url || '').split('?')[0];
    if (!['POST', 'PUT', 'PATCH'].includes(method) || !isFinancialRoute(path)) return next.handle();

    const owner = ownerOf(req);
    const explicitKey = requestKeyOf(req);
    const requestHash = crypto
      .createHash('sha256')
      .update(`${method} ${path} ${canonicalJson(req.body ?? {})} ${canonicalJson(req.params ?? {})}`)
      .digest('hex');
    const key = explicitKey ? `key:${explicitKey}` : `auto:${requestHash}`;
    const ttlSeconds = explicitKey
      ? this.num('IDEMPOTENCY_KEY_TTL_HOURS', 24) * 3600
      : this.num('IDEMPOTENCY_AUTO_WINDOW_SECONDS', 30);

    return from(this.begin(owner, key, method, path, requestHash, !!explicitKey, ttlSeconds)).pipe(
      mergeMap((state) => {
        if (state.kind === 'replay') {
          try {
            res.setHeader('Idempotent-Replayed', 'true');
            res.status(state.status);
          } catch {
            /* en-têtes déjà envoyés */
          }
          return of(state.body);
        }
        if (state.kind === 'skip') return next.handle();
        const id = state.id;
        return next.handle().pipe(
          tap((body) => void this.finish(id, res?.statusCode || 200, body, ttlSeconds)),
          catchError((err) => {
            void this.fail(id, err);
            return throwError(() => err);
          }),
        );
      }),
    );
  }

  /** Réserve la clé (INSERT unique) ou décide : rejouer / refuser / exécuter */
  private async begin(
    owner: string,
    key: string,
    method: string,
    path: string,
    requestHash: string,
    explicit: boolean,
    ttlSeconds: number,
  ): Promise<{ kind: 'run'; id: string } | { kind: 'replay'; status: number; body: any } | { kind: 'skip' }> {
    const db: any = this.prisma;
    const id = crypto.randomUUID();
    const processingTtl = this.num('IDEMPOTENCY_PROCESSING_TTL_SECONDS', 180);
    try {
      await db.$executeRawUnsafe(
        'INSERT INTO `idempotency_requests` (`id`, `owner`, `idem_key`, `method`, `path`, `request_hash`, `status`, `created_at`, `updated_at`, `expires_at`) ' +
          'VALUES (?, ?, ?, ?, ?, ?, \'PROCESSING\', NOW(3), NOW(3), DATE_ADD(NOW(3), INTERVAL ? SECOND))',
        id,
        owner.slice(0, 120),
        key.slice(0, 200),
        method,
        path.slice(0, 255),
        requestHash,
        processingTtl,
      );
      return { kind: 'run', id };
    } catch (e: any) {
      const msg = String(e?.message || '');
      if (/doesn't exist|ER_NO_SUCH_TABLE|1146/i.test(msg)) {
        if (!this.tableMissingLogged) this.logger.warn('Table idempotency_requests absente : protection désactivée (exécutez le SQL)');
        this.tableMissingLogged = true;
        return { kind: 'skip' };
      }
      if (!/Duplicate|1062|Unique constraint/i.test(msg)) {
        this.logger.warn(`Idempotence indisponible (${msg}) : requête exécutée sans protection`);
        return { kind: 'skip' };
      }
    }

    // Clé déjà connue
    const rows: any[] = await db.$queryRawUnsafe(
      'SELECT `id`, `status`, `request_hash`, `response_status`, `response_body`, (`expires_at` < NOW(3)) AS `expired` ' +
        'FROM `idempotency_requests` WHERE `owner` = ? AND `idem_key` = ? LIMIT 1',
      owner.slice(0, 120),
      key.slice(0, 200),
    );
    const row = rows?.[0];
    if (!row) return { kind: 'skip' };

    if (Number(row.expired) === 1) {
      // Ancienne entrée expirée : on la reprend (une seule requête y parvient)
      const claimed = await db.$executeRawUnsafe(
        'UPDATE `idempotency_requests` SET `status` = \'PROCESSING\', `request_hash` = ?, `method` = ?, `path` = ?, ' +
          '`response_status` = NULL, `response_body` = NULL, `updated_at` = NOW(3), `expires_at` = DATE_ADD(NOW(3), INTERVAL ? SECOND) ' +
          'WHERE `id` = ? AND `expires_at` < NOW(3)',
        requestHash,
        method,
        path.slice(0, 255),
        processingTtl,
        row.id,
      );
      if (Number(claimed) === 1) return { kind: 'run', id: row.id };
      throw new ConflictException({
        statusCode: 409,
        code: 'IDEMPOTENCY_IN_PROGRESS',
        message: 'Cette opération est déjà en cours de traitement. Patientez puis consultez votre historique.',
      });
    }

    if (explicit && row.request_hash !== requestHash) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: "Cette clé d'idempotence a déjà été utilisée pour une autre opération. Générez une nouvelle clé.",
      });
    }

    if (row.status === 'COMPLETED' && row.response_body != null) {
      let body: any = row.response_body;
      try {
        body = JSON.parse(row.response_body);
      } catch {
        /* texte brut */
      }
      return { kind: 'replay', status: Number(row.response_status) || 200, body };
    }

    throw new ConflictException({
      statusCode: 409,
      code: row.status === 'UNCERTAIN' ? 'IDEMPOTENCY_UNCERTAIN' : 'IDEMPOTENCY_IN_PROGRESS',
      message:
        row.status === 'UNCERTAIN'
          ? "Une opération identique n'a pas reçu de réponse et a peut-être été effectuée. Vérifiez votre historique avant de réessayer (quelques minutes)."
          : 'Cette opération est déjà en cours de traitement. Patientez puis consultez votre historique.',
    });
  }

  private async finish(id: string, status: number, body: any, ttlSeconds: number) {
    try {
      let json = JSON.stringify(body ?? null);
      if (json.length > 60000) json = JSON.stringify({ message: (body as any)?.message ?? 'OK', truncated: true });
      await (this.prisma as any).$executeRawUnsafe(
        'UPDATE `idempotency_requests` SET `status` = \'COMPLETED\', `response_status` = ?, `response_body` = ?, ' +
          '`updated_at` = NOW(3), `expires_at` = DATE_ADD(NOW(3), INTERVAL ? SECOND) WHERE `id` = ?',
        status,
        json,
        ttlSeconds,
        id,
      );
    } catch (e: any) {
      this.logger.warn(`Idempotence : résultat non enregistré (${e?.message})`);
    }
  }

  private async fail(id: string, err: any) {
    const status = err instanceof HttpException ? err.getStatus() : Number(err?.status || err?.statusCode) || 500;
    try {
      if (status >= 400 && status < 500 && status !== 408 && status !== 409) {
        // Refus métier définitif (rien n'a été fait) : clé libérée
        await (this.prisma as any).$executeRawUnsafe('DELETE FROM `idempotency_requests` WHERE `id` = ?', id);
      } else {
        // Timeout / erreur serveur : l'opération a peut-être abouti → blocage temporaire
        await (this.prisma as any).$executeRawUnsafe(
          'UPDATE `idempotency_requests` SET `status` = \'UNCERTAIN\', `response_status` = ?, `updated_at` = NOW(3), ' +
            '`expires_at` = DATE_ADD(NOW(3), INTERVAL ? MINUTE) WHERE `id` = ?',
          status,
          this.num('IDEMPOTENCY_UNCERTAIN_LOCK_MINUTES', 10),
          id,
        );
      }
    } catch {
      /* best effort */
    }
  }
}
