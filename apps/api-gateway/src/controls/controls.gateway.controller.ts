// apps/api-gateway/src/controls/controls.gateway.controller.ts
import { Body, Controller, Get, Headers, HttpException, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AuthentificationGuard } from 'apps/auth-service/src/utility/guards/authentification.guard';
import { JwtAuthGuard } from 'apps/auth-service/src/utility/guards/jwt-auth.guard';
import { CurrentUser } from 'apps/auth-service/src/utility/decorators/current-user-decorator';
import { PrismaService } from 'apps/user-service/src/prisma/prisma.service';
import { assertAdminResource, createRmqClient, rpcSend } from '../work-schedules/rpc-client.util';
import { AdminApprovalService } from './admin-approval.service';
import { LimitsInterceptor } from './limits.interceptor';

/**
 * ✅ CONTRÔLES FINANCIERS (administration)
 *  Double validation        /admin/approvals…                  SUPER_ADMIN, ou ADMIN avec la ressource APPROVALS
 *  Grand livre              /admin/ledger/…                    SUPER_ADMIN, ou ADMIN avec la ressource TREASURY
 *  Trésorerie / couverture  /admin/treasury/…                  idem
 *  Rapport PawaPay          /admin/providers/pawapay/…         idem (consultation seule, aucune validation automatique)
 *  Arrêtés de caisse        /admin/cash-closings…              ADMIN de l'agence (soumission) ; validation SUPER_ADMIN / TREASURY
 *  Plafonds de l'utilisateur GET /wallet/me/limits                tout utilisateur connecté
 */
@Controller()
export class ControlsGatewayController {
  private readonly wallet: ClientProxy = createRmqClient('WALLET_QUEUE', 'wallet_queue');

  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: AdminApprovalService,
    private readonly limits: LimitsInterceptor,
  ) {}

  private lang(h?: string) {
    return ['fr', 'en', 'sw'].includes(String(h)) ? String(h) : 'fr';
  }

  // =================== Double validation ===================
  @Get('admin/approvals')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async listApprovals(@CurrentUser() user: any, @Query() q: any) {
    if (user?.role !== 'ADMIN' && user?.role !== 'SUPER_ADMIN') throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    // Un ADMIN sans le droit APPROVALS ne voit que ses propres demandes
    if (user.role !== 'SUPER_ADMIN') {
      try {
        await assertAdminResource(this.prisma, user, 'APPROVALS', false);
      } catch {
        q = { ...q, mine: 'true' };
      }
    }
    return this.approvals.list(q, user);
  }

  @Get('admin/approvals/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getApproval(@CurrentUser() user: any, @Param('id') id: string) {
    if (user?.role !== 'ADMIN' && user?.role !== 'SUPER_ADMIN') throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    return this.approvals.get(id);
  }

  /** { pin, note? } — PIN du validateur */
  @Post('admin/approvals/:id/approve')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async approve(@CurrentUser() user: any, @Param('id') id: string, @Body() body: any, @Headers('lang') lang?: string) {
    await assertAdminResource(this.prisma, user, 'APPROVALS', true);
    return this.approvals.approve(id, user, body?.pin, body?.note, this.lang(lang));
  }

  /** { note } — motif obligatoire */
  @Post('admin/approvals/:id/reject')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async reject(@CurrentUser() user: any, @Param('id') id: string, @Body() body: any) {
    await assertAdminResource(this.prisma, user, 'APPROVALS', true);
    return this.approvals.reject(id, user, body?.note);
  }

  @Post('admin/approvals/:id/cancel')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async cancel(@CurrentUser() user: any, @Param('id') id: string) {
    if (user?.role !== 'ADMIN' && user?.role !== 'SUPER_ADMIN') throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    return this.approvals.cancel(id, user);
  }

  // =================== Grand livre ===================
  @Get('admin/ledger/trial-balance')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async trialBalance(@CurrentUser() user: any, @Query() q: any) {
    await assertAdminResource(this.prisma, user, 'TREASURY', false);
    return rpcSend(this.wallet, 'ledger.trial_balance', { currency: q.currency, to: q.to }, 60000);
  }

  @Get('admin/ledger/wallet-check')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async walletCheck(@CurrentUser() user: any, @Query() q: any) {
    await assertAdminResource(this.prisma, user, 'TREASURY', false);
    return rpcSend(this.wallet, 'ledger.wallet_check', { currency: q.currency, limit: q.limit }, 120000);
  }

  /** ?account=CLEARING:MOBILE_MONEY:CDF | ?walletId= | ?transactionId= */
  @Get('admin/ledger/entries')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async entries(@CurrentUser() user: any, @Query() q: any) {
    await assertAdminResource(this.prisma, user, 'TREASURY', false);
    return rpcSend(this.wallet, 'ledger.entries', q);
  }

  /** { mode: 'incremental' | 'full' } */
  @Post('admin/ledger/run')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async runLedger(@CurrentUser() user: any, @Body() body: any) {
    await assertAdminResource(this.prisma, user, 'TREASURY', true);
    return rpcSend(this.wallet, 'ledger.run', { mode: body?.mode }, 600000);
  }

  // =================== Trésorerie / couverture ===================
  @Get('admin/treasury/coverage')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async coverage(@CurrentUser() user: any, @Query() q: any) {
    await assertAdminResource(this.prisma, user, 'TREASURY', false);
    return rpcSend(this.wallet, 'treasury.coverage', { save: false });
  }

  @Get('admin/treasury/coverage/history')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async coverageHistory(@CurrentUser() user: any, @Query() q: any) {
    await assertAdminResource(this.prisma, user, 'TREASURY', false);
    return rpcSend(this.wallet, 'treasury.coverage.history', { currency: q.currency, days: q.days });
  }

  @Get('admin/treasury/floats')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async floats(@CurrentUser() user: any) {
    await assertAdminResource(this.prisma, user, 'TREASURY', false);
    return rpcSend(this.wallet, 'treasury.floats', {});
  }

  @Get('admin/treasury/accounts')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async accounts(@CurrentUser() user: any) {
    await assertAdminResource(this.prisma, user, 'TREASURY', false);
    return rpcSend(this.wallet, 'treasury.accounts.list', {});
  }

  /** { name, kind: BANK | PROVIDER | CASH_OTHER | OTHER, currency, balance, reference? } */
  @Post('admin/treasury/accounts')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async createAccount(@CurrentUser() user: any, @Body() dto: any) {
    await assertAdminResource(this.prisma, user, 'TREASURY', true);
    return rpcSend(this.wallet, 'treasury.accounts.save', { dto, adminId: user.id });
  }

  /** { balance, note (obligatoire si le solde change), name?, reference?, isActive? } */
  @Patch('admin/treasury/accounts/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateAccount(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: any) {
    await assertAdminResource(this.prisma, user, 'TREASURY', true);
    return rpcSend(this.wallet, 'treasury.accounts.save', { id, dto, adminId: user.id });
  }

  @Get('admin/treasury/accounts/:id/history')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async accountHistory(@CurrentUser() user: any, @Param('id') id: string) {
    await assertAdminResource(this.prisma, user, 'TREASURY', false);
    return rpcSend(this.wallet, 'treasury.accounts.history', { id });
  }

  // =================== Réconciliation PawaPay ===================
  /** ?from&to (ISO, défaut 24 h) &limit (≤ 300) &onlyIssues=true */
  @Get('admin/providers/pawapay/reconciliation')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async providerReport(@CurrentUser() user: any, @Query() q: any) {
    await assertAdminResource(this.prisma, user, 'TREASURY', false);
    return rpcSend(this.wallet, 'pawapay_reconciliation_report', q, 300000);
  }

  // =================== Arrêtés de caisse ===================
  private async closingBranch(user: any, requested?: string): Promise<string> {
    if (user?.role === 'SUPER_ADMIN') {
      const b = requested || user.branchId;
      if (!b) throw new HttpException('Indiquez branchId', HttpStatus.BAD_REQUEST);
      return b;
    }
    if (user?.role !== 'ADMIN' || !user.branchId) throw new HttpException('Réservé aux administrateurs rattachés à une agence', HttpStatus.FORBIDDEN);
    return user.branchId;
  }

  @Get('admin/cash-closings/expected')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async expected(@CurrentUser() user: any, @Query() q: any) {
    const branchId = await this.closingBranch(user, q.branchId);
    return rpcSend(this.wallet, 'cash_closing.expected', { branchId, currency: q.currency || 'CDF', date: q.date });
  }

  /** { currency, countedAmount, note (obligatoire en cas d'écart), date? (AAAA-MM-JJ), branchId? (SUPER_ADMIN) } */
  @Post('admin/cash-closings')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async submitClosing(@CurrentUser() user: any, @Body() dto: any) {
    const branchId = await this.closingBranch(user, dto?.branchId);
    return rpcSend(this.wallet, 'cash_closing.submit', { adminId: user.id, branchId, dto });
  }

  @Get('admin/cash-closings')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async listClosings(@CurrentUser() user: any, @Query() q: any) {
    if (user?.role !== 'ADMIN' && user?.role !== 'SUPER_ADMIN') throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    let branchId = q.branchId;
    if (user.role !== 'SUPER_ADMIN') {
      try {
        await assertAdminResource(this.prisma, user, 'TREASURY', false);
      } catch {
        branchId = user.branchId || '__none__'; // un ADMIN d'agence ne voit que son agence
      }
    }
    return rpcSend(this.wallet, 'cash_closing.list', { ...q, branchId });
  }

  /** { decision: APPROVED | REJECTED, note } */
  @Patch('admin/cash-closings/:id/review')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async reviewClosing(@CurrentUser() user: any, @Param('id') id: string, @Body() body: any) {
    await assertAdminResource(this.prisma, user, 'TREASURY', true);
    return rpcSend(this.wallet, 'cash_closing.review', { id, adminId: user.id, decision: body?.decision, note: body?.note });
  }

  // =================== Plafonds de l'utilisateur connecté ===================
  @Get('wallet/me/limits')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async myLimits(@CurrentUser() user: any) {
    const r = await this.limits.evaluate(user.id, {}, { summary: true }).catch(() => null);
    return { message: 'Vos plafonds', data: r ? { limits: r.limits, usage: (r as any).usage ?? null, mode: (r as any).mode ?? null } : null };
  }
}
