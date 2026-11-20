// apps/wallet-service/src/controls/controls.controller.ts
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import { LedgerService } from './ledger.service';
import { TreasuryService } from './treasury.service';
import { ProviderReconciliationService } from './provider-reconciliation.service';
import { WalletServiceService } from '../wallet-service.service';
import { AccountingService } from './accounting/accounting.service';

/** Messages RabbitMQ (wallet_queue) des contrôles financiers — appelés par l'api-gateway */
@Controller()
export class ControlsController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly treasury: TreasuryService,
    private readonly provider: ProviderReconciliationService,
    private readonly wallet: WalletServiceService,
    private readonly accounting: AccountingService,
  ) {}

  // ---------- Double validation : exécution d'une recharge admin approuvée ----------
  @MessagePattern('admin_top_up_approved')
  adminTopUpApproved(@Payload() data: any) {
    const { approval, ...dto } = data || {};
    if (!approval?.requestId || !approval?.approvedBy) {
      throw new RpcException({ status: 'error', statusCode: 400, message: 'Validation manquante' });
    }
    return this.wallet.adminTopUp({ ...dto, __approval: approval } as any);
  }

  // ---------- Grand livre ----------
  @MessagePattern('ledger.trial_balance')
  trialBalance(@Payload() q: any) {
    return this.ledger.trialBalance(q || {});
  }

  @MessagePattern('ledger.wallet_check')
  walletCheck(@Payload() q: any) {
    return this.ledger.walletCheck(q || {});
  }

  @MessagePattern('ledger.entries')
  entries(@Payload() q: any) {
    return this.ledger.entries(q || {});
  }

  @MessagePattern('ledger.run')
  async run(@Payload() q: any) {
    const stats = await this.ledger.project(q?.mode === 'full' ? 'full' : 'incremental', q?.mode === 'full' ? 2000 : 200);
    return { message: 'Projection du grand livre effectuée', data: stats };
  }

  // ---------- Trésorerie / couverture / floats ----------
  @MessagePattern('treasury.accounts.list')
  listAccounts() {
    return this.treasury.listAccounts();
  }

  @MessagePattern('treasury.accounts.save')
  saveAccount(@Payload() data: { id?: string; dto: any; adminId: string }) {
    return this.treasury.saveAccount(data);
  }

  @MessagePattern('treasury.accounts.history')
  accountHistory(@Payload() data: { id: string }) {
    return this.treasury.accountHistory(data.id);
  }

  @MessagePattern('treasury.coverage')
  coverage(@Payload() q: any) {
    return this.treasury.coverage({ save: q?.save === true || q?.save === 'true', date: q?.date });
  }

  @MessagePattern('treasury.coverage.history')
  coverageHistory(@Payload() q: any) {
    return this.treasury.coverageHistory(q || {});
  }

  @MessagePattern('treasury.floats')
  async floats() {
    return { message: 'Floats opérateurs', data: await this.treasury.providerFloats() };
  }

  // ---------- Arrêtés de caisse ----------
  @MessagePattern('cash_closing.expected')
  expected(@Payload() q: { branchId: string; currency: string; date?: string }) {
    return this.treasury.expectedCash(q);
  }

  @MessagePattern('cash_closing.submit')
  submit(@Payload() data: { adminId: string; branchId: string; dto: any }) {
    return this.treasury.submitClosing(data);
  }

  @MessagePattern('cash_closing.list')
  listClosings(@Payload() q: any) {
    return this.treasury.listClosings(q || {});
  }

  @MessagePattern('cash_closing.review')
  review(@Payload() data: { id: string; adminId: string; decision: string; note?: string }) {
    return this.treasury.reviewClosing(data);
  }

  // ---------- PawaPay ----------
  @MessagePattern('pawapay_reconciliation_report')
  report(@Payload() q: any) {
    return this.provider.report(q || {});
  }


  // ---------- Comptabilité SYSCOHADA ----------
  @MessagePattern('accounting.earnings')
  earnings(@Payload() q: any) {
    return this.accounting.earnings(q || {});
  }

  @MessagePattern('accounting.income_statement')
  incomeStatement(@Payload() q: any) {
    return this.accounting.incomeStatement(q || {});
  }

  @MessagePattern('accounting.trial_balance')
  accountingTrialBalance(@Payload() q: any) {
    return this.accounting.trialBalance(q || {});
  }

  @MessagePattern('accounting.balance_sheet')
  balanceSheet(@Payload() q: any) {
    return this.accounting.balanceSheet(q || {});
  }

  @MessagePattern('accounting.general_ledger')
  generalLedger(@Payload() q: any) {
    return this.accounting.generalLedger(q || {});
  }

  @MessagePattern('accounting.journal')
  journal(@Payload() q: any) {
    return this.accounting.journal(q || {});
  }

  @MessagePattern('accounting.accounts')
  accountsList() {
    return this.accounting.accounts();
  }

  @MessagePattern('accounting.accounts.create')
  createAccount(@Payload() data: { dto: any; adminId: string }) {
    return this.accounting.createAccount(data.dto, data.adminId);
  }

  @MessagePattern('accounting.entries.create')
  createEntry(@Payload() data: { dto: any; adminId: string }) {
    return this.accounting.createManualEntry(data.dto, data.adminId);
  }

  @MessagePattern('accounting.entries.reverse')
  reverseEntry(@Payload() data: { id: string; adminId: string; reason?: string }) {
    return this.accounting.reverseEntry(data.id, data.adminId, data.reason);
  }

  @MessagePattern('accounting.provider_costs')
  providerCosts() {
    return this.accounting.providerCosts();
  }

  @MessagePattern('accounting.provider_costs.set')
  setProviderCost(@Payload() data: { dto: any; adminId: string }) {
    return this.accounting.setProviderCost(data.dto, data.adminId);
  }

  @MessagePattern('accounting.periods')
  periods() {
    return this.accounting.periods();
  }

  @MessagePattern('accounting.periods.close')
  closePeriod(@Payload() data: { period: string; adminId: string; reopen?: boolean }) {
    return this.accounting.closePeriod(data.period, data.adminId, data.reopen === true);
  }

  @MessagePattern('accounting.run')
  async runAccounting(@Payload() q: any) {
    const full = q?.mode === 'full';
    return { message: 'Passation des écritures effectuée', data: await this.accounting.project(full ? 'full' : 'incremental', full ? 2000 : 200) };
  }
}
