/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// apps/wallet-service/src/wallet-service.controller.ts
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import { WalletServiceService } from './wallet-service.service';
import { PayDto, SendDto } from './dto/wallet-operation.dto';
import { PawapayService } from './pawapay/pawapay.service';
import { CreateCountryDto } from './pawapay/dto/create-country.dto';
import { UpdateCountryDto } from './pawapay/dto/update-country.dto';
import { CreateNetworkDto } from './pawapay/dto/create-network.dto';
import { UpdateNetworkDto } from './pawapay/dto/update-network.dto';
import { I18nService } from '@app/common'; // ✅ ajout
import { AdminCashoutDto, AdminPayDto, AdminSendDto, AdminTopUpDto } from './dto/admin-wallet.dto';
import { ConvertCurrencyDto, ExchangeRateDto } from './dto/currency-convert.dto';

@Controller()
export class WalletServiceController {
  constructor(
    private readonly walletService: WalletServiceService,
    private readonly pawapayService: PawapayService,
    private readonly i18nService: I18nService, // ✅ injection
  ) { }

  // ==================== MÉTHODES DE BASE ====================
  @MessagePattern('create_wallet')
  async createWallet(@Payload() data: { userId: string; currency?: string }) {
    console.log('[WalletService] create_wallet received:', data);
    try {
      return await this.walletService.createWallet(data);
    } catch (error) {
      console.error('[WalletService] create_wallet error:', error);
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('get_wallet')
  async getWallet(@Payload() data: { userId: string; lang?: string }) {
    console.log('[WalletService] get_wallet received:', data.userId);
    try {
      return await this.walletService.getUserWallets(data.userId);
    } catch (error) {
      console.error('[WalletService] get_wallet error:', error);
      const lang = data.lang || 'fr';
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : this.i18nService.translate('wallet.unknown_error', lang),
        statusCode: 404,
      });
    }
  }

  @MessagePattern('get_wallet_by_id')
  async getWalletById(@Payload() data: { walletId: string; userId?: string; lang?: string }) {
    console.log('[WalletService] get_wallet_by_id received:', data);
    try {
      return await this.walletService.getWalletById(data.walletId, data.lang);
    } catch (error) {
      console.error('[WalletService] get_wallet_by_id error:', error);
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('get_wallet_by_user')
  async getWalletByUser(@Payload() data: { userId: string; lang?: string }) {
    console.log('[WalletService] get_wallet received:', data.userId);
    try {
      return await this.walletService.getWalletById(data.userId);
    } catch (error) {
      console.error('[WalletService] get_wallet error:', error);
      const lang = data.lang || 'fr';
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : this.i18nService.translate('wallet.unknown_error', lang),
        statusCode: 404,
      });
    }
  }

  @MessagePattern('get_wallet_by_phone')
  async getWalletByPhone(@Payload() data: { phone: string; lang?: string }) {
    console.log('[WalletService] get_wallet_by_phone received:', data.phone);
    try {
      return await this.walletService.getWalletByPhone(data.phone);
    } catch (error) {
      console.error('[WalletService] get_wallet_by_phone error:', error);
      const lang = data.lang || 'fr';
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : this.i18nService.translate('wallet.unknown_error', lang),
        statusCode: 404,
      });
    }
  }

  @MessagePattern('get_merchant_by_code')
  async getMerchantByCode(@Payload() data: { merchantCode: string; lang?: string }) {
    console.log('[UserService] get_merchant_by_code received:', data.merchantCode);
    try {
      return await this.walletService.getMerchantByCode(data.merchantCode);
    } catch (error) {
      const lang = data.lang || 'fr';
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : this.i18nService.translate('wallet.unknown_error', lang),
        statusCode: 404,
      });
    }
  }

  @MessagePattern('get_transaction_by_id')
  async getTransactionById(@Payload() data: { transactionId: string; lang?: string }) {
    console.log('[WalletService] get_transaction_by_id received:', data.transactionId);
    try {
      return await this.walletService.getTransactionById(data.transactionId);
    } catch (error) {
      console.error('[WalletService] get_transaction_by_id error:', error);
      const lang = data.lang || 'fr';
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : this.i18nService.translate('wallet.unknown_error', lang),
        statusCode: 404,
      });
    }
  }

  @MessagePattern('list_transactions')
  async listTransactions(
    @Payload()
    data: {
      userId: string;
      page?: number;
      limit?: number;
      startDate?: Date;
      endDate?: Date;
      lang?: string;
    },
  ) {
    console.log('[WalletService] list_transactions received:', data);
    try {
      return await this.walletService.listTransactions(
        data.userId,
        data.page,
        data.limit,
        data.startDate,
        data.endDate,
      );
    } catch (error) {
      console.error('[WalletService] list_transactions error:', error);
      const lang = data.lang || 'fr';
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : this.i18nService.translate('wallet.unknown_error', lang),
        statusCode: 400,
      });
    }
  }

  @MessagePattern('get_transactions_by_wallet')
  async getTransactionsByWallet(
    @Payload()
    data: {
      walletId: string;
      page?: number;
      limit?: number;
      startDate?: string;
      endDate?: string;
      lang?: string;
    },
  ) {
    console.log('[WalletService] get_transactions_by_wallet received:', data);
    try {
      // Convertir les dates si présentes
      const startDate = data.startDate ? new Date(data.startDate) : undefined;
      const endDate = data.endDate ? new Date(data.endDate) : undefined;

      return await this.walletService.getTransactionsByWalletId(
        data.walletId,
        data.page || 1,
        data.limit || 10,
        startDate,
        endDate,
        data.lang || 'fr',
      );
    } catch (error) {
      console.error('[WalletService] get_transactions_by_wallet error:', error);
      const lang = data.lang || 'fr';
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : this.i18nService.translate('wallet.unknown_error', lang),
        statusCode: 400,
      });
    }
  }

  @MessagePattern('list_all_transactions')
  async listAllTransactions(
    @Payload()
    data: {
      page?: number;
      limit?: number;
      userId?: string;
      type?: string;
      status?: string;
      startDate?: string;
      endDate?: string;
      search?: string;
      lang?: string;
    },
  ) {
    console.log('[WalletService] list_all_transactions received:', data);
    try {
      const startDate = data.startDate ? new Date(data.startDate) : undefined;
      const endDate = data.endDate ? new Date(data.endDate) : undefined;
      return await this.walletService.listAllTransactions(
        data.page,
        data.limit,
        data.userId,
        data.type,
        data.status,
        startDate,
        endDate,
        data.search,
      );
    } catch (error) {
      console.error('[WalletService] list_all_transactions error:', error);
      const lang = data.lang || 'fr';
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : this.i18nService.translate('wallet.unknown_error', lang),
        statusCode: 400,
      });
    }
  }

  @MessagePattern('list_all_transactions_unpaginated')
  async listAllTransactionsUnpaginated(
    @Payload()
    data: {
      userId?: string;
      type?: string;
      status?: string;
      startDate?: Date;
      endDate?: Date;
      search?: string;
      lang?: string;
    },
  ) {
    try {
      return await this.walletService.listAllTransactionsWithoutPagination(
        data.userId,
        data.type,
        data.status,
        data.startDate,
        data.endDate,
        data.search,
      );
    } catch (error) {
      const lang = data.lang || 'fr';
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('wallet.unknown_error', lang),
        statusCode: 500,
      });
    }
  }

  @MessagePattern('list_all_trans')
  async listAllTransactionsWithoutPag(
    @Payload()
    data: {
      userId?: string;
      type?: string;
      status?: string;
      startDate?: string;
      endDate?: string;
      search?: string;
      lang?: string;
    },
  ) {
    console.log('[WalletService] list_all_trans received:', data);
    try {
      const startDate = data.startDate ? new Date(data.startDate) : undefined;
      const endDate = data.endDate ? new Date(data.endDate) : undefined;
      return await this.walletService.listAllTransactionsWithoutPag(
        data.userId,
        data.type,
        data.status,
        startDate,
        endDate,
        data.search,
      );
    } catch (error) {
      console.error('[WalletService] list_all_trans error:', error);
      const lang = data.lang || 'fr';
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : this.i18nService.translate('wallet.unknown_error', lang),
        statusCode: 400,
      });
    }
  }

  // ==================== OPÉRATIONS AVANCÉES (avec langue) ====================

  @MessagePattern('top_up')
  async topUp(
    @Payload()
    data: {
      userId: string;
      amount: number;
      pin: string;
      lang?: string;
      ipAddress?: string;
      walletId?: string;
      provider?: string;
      phone?: string;
    },
  ) {
    console.log('[WalletService] top_up received:', data);
    try {
      return await this.walletService.topUp(
        data.userId,
        data.amount,
        data.pin,
        data.lang || 'fr',
        data.ipAddress,
        data.walletId,
        data.provider,
        data.phone,
      );
    } catch (error) {
      console.error('[WalletService] top_up error:', error);
      const lang = data.lang || 'fr';
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : this.i18nService.translate('wallet.unknown_error', lang),
        statusCode: 400,
      });
    }
  }

  @MessagePattern('cashout')
  async cashout(
    @Payload()
    data: {
      userId: string;
      accountNumber?: string;     // optionnel pour MOMO
      amount: number;
      pin: string;
      lang?: string;
      ipAddress?: string;
      walletId?: string;          // pour cibler un wallet spécifique
      provider?: string;          // pour PawaPay (MOMO)
      phone?: string;             // pour PawaPay
    },
  ) {
    const lang = data.lang || 'fr';
    console.log('[WalletService] cashout received:', {
      userId: data.userId,
      accountNumber: data.accountNumber,
      amount: data.amount,
      lang,
      walletId: data.walletId,
      provider: data.provider,
      phone: data.phone,
    });
    try {
      return await this.walletService.cashout(
        data.userId,
        {
          accountNumber: data.accountNumber,
          amount: data.amount,
          pin: data.pin,
          walletId: data.walletId,
          provider: data.provider,
          phone: data.phone,
        },
        lang,
        data.ipAddress,
      );
    } catch (error) {
      console.error('[WalletService] cashout error:', error);
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : this.i18nService.translate('wallet.unknown_error', lang),
        statusCode: 400,
      });
    }
  }

  @MessagePattern('send')
  async send(@Payload() data: SendDto & { lang?: string }, ipAddress: string) {
    console.log('[WalletService] send received:', { from: data.fromWalletId, to: data.toPhone, amount: data.amount, lang: data.lang });
    try {
      return await this.walletService.send(data, data.lang || 'fr', ipAddress);
    } catch (error) {
      console.error('[WalletService] send error:', error);
      const lang = data.lang || 'fr';
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : this.i18nService.translate('wallet.unknown_error', lang),
        statusCode: 400,
      });
    }
  }

  @MessagePattern('pay')
  async pay(@Payload() data: PayDto & { lang?: string }, ipAddress: string) {
    console.log('[WalletService] pay received:', { ...data, lang: data.lang });
    try {
      return await this.walletService.pay(data, data.lang || 'fr', ipAddress);
    } catch (error) {
      console.error('[WalletService] pay error:', error);
      const lang = data.lang || 'fr';
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : this.i18nService.translate('wallet.unknown_error', lang),
        statusCode: 400,
      });
    }
  }

  @MessagePattern('link_account')
  async linkAccount(
    @Payload() data: { accountNumber: string; requestId?: string; lang?: string },
  ) {
    return this.walletService.linkAccount(data.accountNumber, data.requestId);
  }

  // ==================== ADMIN OPERATIONS (sans PIN) ====================

  @MessagePattern('admin_top_up')
  async adminTopUp(@Payload() data: AdminTopUpDto) {
    return this.walletService.adminTopUp(data);
  }

  @MessagePattern('admin_cashout')
  async adminCashout(@Payload() data: AdminCashoutDto) {
    return this.walletService.adminCashout(data);
  }

  @MessagePattern('admin_send')
  async adminSend(@Payload() data: AdminSendDto) {
    return this.walletService.adminSend(data);
  }

  @MessagePattern('admin_pay')
  async adminPay(@Payload() data: AdminPayDto) {
    return this.walletService.adminPay(data);
  }

  @MessagePattern('convert_currency')
  async convertCurrency(@Payload() data: ConvertCurrencyDto & { lang?: string }, ipAddress: string) {
    console.log('[WalletService] convert_currency received:', data);
    try {
      return await this.walletService.convertCurrency(data, data.lang || 'fr', ipAddress);
    } catch (error) {
      console.error('[WalletService] convert_currency error:', error);
      const lang = data.lang || 'fr';
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : this.i18nService.translate('wallet.unknown_error', lang),
        statusCode: 400,
      });
    }
  }

  // ==================== DOWNLOAD STATEMENT ====================

  @MessagePattern('generate_statement_pdf')
  async generateStatementPdf(
    @Payload()
    data: {
      userId: string;
      startDate?: string;
      endDate?: string;
      lang?: string;
    },
  ) {
    let startDate: Date | undefined = undefined;
    let endDate: Date | undefined = undefined;
    if (data.startDate && data.startDate.trim() !== '') {
      startDate = new Date(data.startDate);
      if (isNaN(startDate.getTime())) startDate = undefined;
    }
    if (data.endDate && data.endDate.trim() !== '') {
      endDate = new Date(data.endDate);
      if (isNaN(endDate.getTime())) endDate = undefined;
    }
    return this.walletService.generateStatement(
      data.userId,
      startDate,
      endDate,
      data.lang || 'fr',
    );
  }

  // ==================== PAWAPAY COUNTRY & NETWORK ====================

  @MessagePattern('create_country')
  async createCountry(@Payload() dto: CreateCountryDto) {
    return this.pawapayService.createCountry(dto);
  }

  @MessagePattern('update_country')
  async updateCountry(@Payload() data: { id: string; dto: UpdateCountryDto }) {
    return this.pawapayService.updateCountry(data.id, data.dto);
  }

  @MessagePattern('get_country')
  async getCountry(@Payload() data: { id: string }) {
    return this.pawapayService.getCountry(data.id);
  }

  @MessagePattern('get_all_countries')
  async getAllCountries() {
    return this.pawapayService.getAllCountries();
  }

  @MessagePattern('create_network')
  async createNetwork(@Payload() dto: CreateNetworkDto) {
    return this.pawapayService.createNetwork(dto);
  }

  @MessagePattern('update_network')
  async updateNetwork(@Payload() data: { id: string; dto: UpdateNetworkDto }) {
    return this.pawapayService.updateNetwork(data.id, data.dto);
  }

  @MessagePattern('get_network')
  async getNetwork(@Payload() data: { id: string }) {
    return this.pawapayService.getNetwork(data.id);
  }

  @MessagePattern('get_all_networks')
  async getAllNetworks() {
    return this.pawapayService.getAllNetworks();
  }

  @MessagePattern('get_networks_by_country')
  async getNetworksByCountry(@Payload() data: { countryCode: string; lang?: string }) {
    console.log('[WalletService] get_networks_by_country received:', data);
    console.log('[WalletService] countryCode from payload:', data.countryCode);

    try {
      const result = await this.pawapayService.getNetworksByCountry(data.countryCode);
      console.log('[WalletService] Result:', JSON.stringify(result, null, 2));
      return result;
    } catch (error) {
      console.error('[WalletService] get_networks_by_country error:', error);
      const lang = data?.lang || 'fr';
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : this.i18nService.translate('wallet.unknown_error', lang),
        statusCode: 400,
      });
    }
  }

  @MessagePattern('get_country_by_code')
  async getCountryByCode(@Payload() data: { code: string }) {
    const country = await this.pawapayService['prisma'].country_provider.findFirst({
      where: { code: data.code },
      include: { network_provider: true },
    });
    if (!country) return { message: 'Country not found', data: null };
    return { message: 'Country retrieved', data: country };
  }

  @MessagePattern('set_exchange_rate')
  async setExchangeRate(@Payload() dto: ExchangeRateDto) {
    return this.walletService.setExchangeRate(dto);
  }

  @MessagePattern('get_exchange_rates')
  async getExchangeRates() {
    return this.walletService.getExchangeRates();
  }

  @MessagePattern('list_user_wallets')
  async listUserWallets(@Payload() data: { userId: string }) {
    console.log('[WalletService] list_user_wallets received:', data.userId);
    try {
      return await this.walletService.getUserWallets(data.userId);
    } catch (error) {
      console.error('[WalletService] list_user_wallets error:', error);
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 400,
      });
    }
  }

  // ==================== HEALTH CHECK ====================

  @MessagePattern('health_check')
  async healthCheck() {
    return this.walletService.healthCheck();
  }
}