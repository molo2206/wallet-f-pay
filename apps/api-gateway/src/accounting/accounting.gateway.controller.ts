// apps/api-gateway/src/accounting/accounting.gateway.controller.ts
import { Body, Controller, Get, HttpException, HttpStatus, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AuthentificationGuard } from 'apps/auth-service/src/utility/guards/authentification.guard';
import { JwtAuthGuard } from 'apps/auth-service/src/utility/guards/jwt-auth.guard';
import { CurrentUser } from 'apps/auth-service/src/utility/decorators/current-user-decorator';
import { PrismaService } from 'apps/user-service/src/prisma/prisma.service';
import { assertAdminResource, createRmqClient, rpcSend } from '../work-schedules/rpc-client.util';

const RESOURCE = 'ACCOUNTING';

/** CSV (séparateur « ; », compatible Excel français), BOM UTF-8 pour les accents */
function toCsv(headers: string[], rows: any[][]): string {
  const esc = (v: any) => {
    const s = v === null || v === undefined ? '' : typeof v === 'number' ? v.toFixed(3).replace('.', ',') : String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [headers.map(esc).join(';'), ...rows.map((r) => r.map(esc).join(';'))].join('\r\n');
}

/**
 * ✅ COMPTABILITÉ SYSCOHADA (OHADA) — SUPER_ADMIN, ou ADMIN avec la ressource ACCOUNTING
 *  Filtres communs : from, to (AAAA-MM-JJ) ou period=today|month|year (mois en cours par défaut),
 *  currency (devise d'affichage, devise comptable par défaut), branchId (ce que gagne une agence).
 *  Exports : ?format=csv sur la balance, le grand livre et le journal.
 */
@Controller('admin/accounting')
@UseGuards(JwtAuthGuard, AuthentificationGuard)
export class AccountingGatewayController {
  private readonly wallet: ClientProxy = createRmqClient('WALLET_QUEUE', 'wallet_queue');

  constructor(private readonly prisma: PrismaService) {}

  private csv(res: any, filename: string, content: string) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return content;
  }

  /** Ce que F-Pay gagne : produits par source, charges, résultat net, évolution (groupBy=day|month) */
  @Get('earnings')
  async earnings(@CurrentUser() user: any, @Query() q: any) {
    await assertAdminResource(this.prisma, user, RESOURCE, false);
    return rpcSend(this.wallet, 'accounting.earnings', q, 60000);
  }

  @Get('income-statement')
  async incomeStatement(@CurrentUser() user: any, @Query() q: any) {
    await assertAdminResource(this.prisma, user, RESOURCE, false);
    return rpcSend(this.wallet, 'accounting.income_statement', q, 60000);
  }

  @Get('balance-sheet')
  async balanceSheet(@CurrentUser() user: any, @Query() q: any) {
    await assertAdminResource(this.prisma, user, RESOURCE, false);
    return rpcSend(this.wallet, 'accounting.balance_sheet', q, 60000);
  }

  @Get('trial-balance')
  async trialBalance(@CurrentUser() user: any, @Query() q: any, @Res({ passthrough: true }) res: any) {
    await assertAdminResource(this.prisma, user, RESOURCE, false);
    const r: any = await rpcSend(this.wallet, 'accounting.trial_balance', q, 60000);
    if (q.format !== 'csv') return r;
    const d = r.data;
    return this.csv(
      res,
      `balance_${d.period.from}_${d.period.to}.csv`,
      toCsv(
        ['Compte', 'Libellé', 'Solde ouverture débit', 'Solde ouverture crédit', 'Mouvements débit', 'Mouvements crédit', 'Solde clôture débit', 'Solde clôture crédit'],
        d.accounts.map((a: any) => [a.account, a.label, a.opening.debit, a.opening.credit, a.movements.debit, a.movements.credit, a.closing.debit, a.closing.credit]),
      ),
    );
  }

  /** ?account=7061 (ou 706* pour tous les sous-comptes) */
  @Get('general-ledger')
  async generalLedger(@CurrentUser() user: any, @Query() q: any, @Res({ passthrough: true }) res: any) {
    await assertAdminResource(this.prisma, user, RESOURCE, false);
    const r: any = await rpcSend(this.wallet, 'accounting.general_ledger', q.format === 'csv' ? { ...q, limit: 500, page: q.page || 1 } : q, 60000);
    if (q.format !== 'csv') return r;
    const d = r.data;
    return this.csv(
      res,
      `grand_livre_${q.account}_${d.period.from}_${d.period.to}.csv`,
      toCsv(
        ['Date', 'Journal', 'Référence', 'Libellé', 'Compte', 'Débit', 'Crédit', 'Solde', 'Devise origine', 'Débit origine', 'Crédit origine'],
        d.lines.map((l: any) => [l.date, l.journal, l.reference, l.label, l.account, l.debit, l.credit, l.balance, l.original.currency, l.original.debit, l.original.credit]),
      ),
    );
  }

  /** ?journal=MM|CA|VI|PR|CH|BQ|OD &source=AUTO|MANUAL|REVERSAL &search= */
  @Get('journal')
  async journal(@CurrentUser() user: any, @Query() q: any, @Res({ passthrough: true }) res: any) {
    await assertAdminResource(this.prisma, user, RESOURCE, false);
    const r: any = await rpcSend(this.wallet, 'accounting.journal', q.format === 'csv' ? { ...q, limit: 200 } : q, 60000);
    if (q.format !== 'csv') return r;
    const d = r.data;
    const rows: any[][] = [];
    for (const e of d.data) for (const l of e.lines) rows.push([e.date, e.journal, e.reference, e.label, l.account, l.label, l.debit, l.credit, e.currency]);
    return this.csv(res, `journal_${d.period.from}_${d.period.to}.csv`, toCsv(['Date', 'Journal', 'Référence', 'Libellé', 'Compte', 'Intitulé', 'Débit', 'Crédit', 'Devise'], rows));
  }

  @Get('accounts')
  async accounts(@CurrentUser() user: any) {
    await assertAdminResource(this.prisma, user, RESOURCE, false);
    return rpcSend(this.wallet, 'accounting.accounts', {});
  }

  /** { code, label } — sous-compte SYSCOHADA (ex. 6221 Loyer siège Goma) */
  @Post('accounts')
  async createAccount(@CurrentUser() user: any, @Body() dto: any) {
    await assertAdminResource(this.prisma, user, RESOURCE, true);
    return rpcSend(this.wallet, 'accounting.accounts.create', { dto, adminId: user.id });
  }

  /**
   * Écriture manuelle équilibrée :
   * { date: '2026-11-30', journal: 'OD', label: 'Facture PawaPay novembre', currency: 'USD', reference?,
   *   lines: [{ account: '6318', debit: 120 }, { account: '5311', credit: 120 }] }
   */
  @Post('entries')
  async createEntry(@CurrentUser() user: any, @Body() dto: any) {
    await assertAdminResource(this.prisma, user, RESOURCE, true);
    return rpcSend(this.wallet, 'accounting.entries.create', { dto, adminId: user.id });
  }

  /** { reason? } */
  @Post('entries/:id/reverse')
  async reverseEntry(@CurrentUser() user: any, @Param('id') id: string, @Body() body: any) {
    await assertAdminResource(this.prisma, user, RESOURCE, true);
    return rpcSend(this.wallet, 'accounting.entries.reverse', { id, adminId: user.id, reason: body?.reason });
  }

  @Get('provider-costs')
  async providerCosts(@CurrentUser() user: any) {
    await assertAdminResource(this.prisma, user, RESOURCE, false);
    return rpcSend(this.wallet, 'accounting.provider_costs', {});
  }

  /** { operation: DEPOSIT | PAYOUT, currency: 'CDF' | 'USD' | '*', percentage, fixedFee } */
  @Put('provider-costs')
  async setProviderCost(@CurrentUser() user: any, @Body() dto: any) {
    await assertAdminResource(this.prisma, user, RESOURCE, true);
    return rpcSend(this.wallet, 'accounting.provider_costs.set', { dto, adminId: user.id });
  }

  @Get('periods')
  async periods(@CurrentUser() user: any) {
    await assertAdminResource(this.prisma, user, RESOURCE, false);
    return rpcSend(this.wallet, 'accounting.periods', {});
  }

  /** { period: 'AAAA-MM', reopen?: true } — clôture réservée au SUPER_ADMIN */
  @Post('periods/close')
  async closePeriod(@CurrentUser() user: any, @Body() body: any) {
    if (user?.role !== 'SUPER_ADMIN') throw new HttpException('Clôture réservée au super administrateur', HttpStatus.FORBIDDEN);
    return rpcSend(this.wallet, 'accounting.periods.close', { period: body?.period, adminId: user.id, reopen: body?.reopen === true });
  }

  /** { mode: 'incremental' | 'full' } — passation immédiate (reprise de l'historique : full) */
  @Post('run')
  async run(@CurrentUser() user: any, @Body() body: any) {
    await assertAdminResource(this.prisma, user, RESOURCE, true);
    return rpcSend(this.wallet, 'accounting.run', { mode: body?.mode }, 600000);
  }
}
