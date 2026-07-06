/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { lastValueFrom } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { PrismaClient } from '@prisma/client';
import { UpdateNetworkDto } from './dto/update-network.dto';
import { CreateNetworkDto } from './dto/create-network.dto';
import { UpdateCountryDto } from './dto/update-country.dto';
import { CountryResponseDto, CreateCountryDto } from './dto/create-country.dto';
import { RpcException } from '@nestjs/microservices';

export type OperationType = 'DEPOSIT' | 'REFUND' | 'PAYOUT';
type BulkPayoutResult =
  | { payoutId: string; status: any }
  | { payoutId: string; error: string };

@Injectable()
export class PawapayService {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly prisma: PrismaClient;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.baseUrl = this.configService.getOrThrow<string>('PAWAPAY_BASE_URL');
    this.token = this.configService.getOrThrow<string>('PAWAPAY_TOKEN');
    this.prisma = new PrismaClient();
  }

  private get headers() {
    return { Authorization: `Bearer ${this.token}` };
  }

  // ---------- API Pawapay ----------
  private async fetchAvailability(): Promise<any[]> {
    const url = `${this.baseUrl}/v2/availability`;
    const res$ = this.httpService.get(url, { headers: this.headers });
    return lastValueFrom(res$).then((r) => r.data);
  }

  async getAvailability(country?: string, operationType?: OperationType): Promise<any[]> {
    let data = await this.fetchAvailability();
    if (country) {
      data = data.filter((c) => c.country.toUpperCase() === country.toUpperCase());
    }
    if (operationType) {
      data = data.map((c) => ({
        ...c,
        providers: c.providers.filter((p) => p.operationTypes?.[operationType] === 'OPERATIONAL'),
      }));
    }
    return data.filter((c) => c.providers.length > 0);
  }

  async getActiveConf(country?: string, operationType?: 'DEPOSIT' | 'PAYOUT' | 'REFUND') {
    const url = `${this.baseUrl}/v2/active-conf`;
    const res$ = this.httpService.get(url, { headers: this.headers });
    const data = await lastValueFrom(res$).then((r) => r.data);

    const filteredCountries = data.countries
      .filter((c) => !country || c.country === country)
      .map((country) => ({
        ...country,
        providers: country.providers
          .map((provider) => ({
            ...provider,
            currencies: provider.currencies
              .map((currency) => {
                if (!operationType) return currency;
                const op = currency.operationTypes?.[operationType];
                return op ? { ...currency, operationTypes: { [operationType]: op } } : null;
              })
              .filter(Boolean),
          }))
          .filter((provider) => provider.currencies.length > 0),
      }))
      .filter((country) => country.providers.length > 0);

    return {
      companyName: data.companyName,
      signatureConfiguration: data.signatureConfiguration,
      countries: filteredCountries,
    };
  }

  async getWalletBalances(country?: string, provider?: string) {
    const url = `${this.baseUrl}/v2/wallet-balances`;
    const res$ = this.httpService.get(url, { headers: this.headers });
    const data = await lastValueFrom(res$).then((r) => r.data);
    let balances = data.balances;
    if (country) balances = balances.filter((b) => b.country === country);
    if (provider)
      balances = balances.filter((b) => b.provider && b.provider.toLowerCase().includes(provider.toLowerCase()));
    return { balances };
  }

  async createDepositSimple(
    data: {
      amount: string;
      currency: string;
      provider: string;
      phone: string;
      walletId?: string;
    },
    signal?: AbortSignal,
  ): Promise<any> {
    const depositId = uuidv4();
    const clientReferenceId = `INV-${Date.now()}`;
    const metadata = [
      { orderId: `ORD-${Date.now()}` },
      { customerId: 'customer@email.com', isPII: true },
      { walletId: data.walletId },
    ];

    const body = {
      depositId,
      payer: {
        type: 'MMO',
        accountDetails: {
          phoneNumber: data.phone,
          provider: data.provider,
        },
      },
      amount: data.amount,
      currency: data.currency,
      preAuthorisationCode: '3c',
      clientReferenceId,
      customerMessage: 'Note of 4 to 22 chars',
      metadata,
    };

    const deposit = await lastValueFrom(
      this.httpService.post(`${this.baseUrl}/v2/deposits`, body, {
        headers: this.headers,
        signal,
      }),
    ).then((r) => r.data);

    console.log('[PawaPay] Dépôt créé :', deposit.depositId);
    const finalStatus = await this.pollDepositStatus(deposit.depositId, signal);
    console.log('[PawaPay] Statut final :', finalStatus);

    return { deposit, finalStatus };
  }

  async createPayoutSimple(data: { amount: string; currency: string; provider: string; phone: string }, signal?: AbortSignal) {
    const payoutId = uuidv4();
    const clientReferenceId = `PAYOUT-${Date.now()}`;
    const metadata = [{ orderId: `ORD-${Date.now()}` }, { customerId: 'customer@email.com', isPII: true }];
    const body = {
      payoutId,
      recipient: { type: 'MMO', accountDetails: { provider: data.provider, phoneNumber: data.phone } },
      amount: data.amount,
      currency: data.currency,
      customerMessage: 'Payment',
      metadata,
    };
    const payout = await lastValueFrom(
      this.httpService.post(`${this.baseUrl}/v2/payouts`, body, { headers: this.headers, signal }),
    ).then((r) => r.data);
    console.log('[PawaPay] Payout créé :', payout.payoutId);
    const finalStatus = await this.pollPayoutStatus(payout.payoutId, signal);
    console.log('[PawaPay] Statut final payout :', finalStatus);
    return { payout, finalStatus };
  }

  async checkDepositStatus(depositId: string, signal?: AbortSignal) {
    return lastValueFrom(
      this.httpService.get(`${this.baseUrl}/v2/deposits/${depositId}`, { headers: this.headers, signal }),
    ).then((r) => r.data);
  }

  private async pollDepositStatus(depositId: string, signal?: AbortSignal, maxRetries = 10, intervalMs = 2000) {
    const finalStatuses = ['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED', 'REJECTED'];
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw new Error('AbortError');
      console.log(`[Polling] Tentative ${attempt}/${maxRetries}`);
      let statusResponse;
      try {
        statusResponse = await this.checkDepositStatus(depositId, signal);
      } catch (err: any) {
        if (err.name === 'AbortError' || signal?.aborted) throw new Error('AbortError');
        throw err;
      }
      const status = statusResponse?.data?.status;
      console.log(`[Polling] Statut : ${status}`);
      if (finalStatuses.includes(status)) return statusResponse;
      if (attempt === maxRetries) break;
      if (signal?.aborted) throw new Error('AbortError');
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('AbortError'));
        const timeout = setTimeout(resolve, intervalMs);
        const abortHandler = () => {
          clearTimeout(timeout);
          reject(new Error('AbortError'));
        };
        signal?.addEventListener('abort', abortHandler, { once: true });
      });
    }
    return { message: 'Statut du dépôt non confirmé après polling', depositId, attempts: maxRetries };
  }

  async checkPayoutStatus(payoutId: string, signal?: AbortSignal) {
    const url = `${this.baseUrl}/v2/payouts/${payoutId}`;
    return lastValueFrom(this.httpService.get(url, { headers: this.headers, signal })).then((r) => r.data);
  }

  private async pollPayoutStatus(payoutId: string, signal?: AbortSignal, maxRetries = 10, intervalMs = 2000) {
    const finalStatuses = ['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED', 'REJECTED'];
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) {
        console.warn('[PawaPay][Payout Polling] Annulé');
        throw new Error('AbortError');
      }
      console.log(`[PawaPay][Payout Polling] Tentative ${attempt}/${maxRetries}`);
      const statusResponse = await this.checkPayoutStatus(payoutId, signal);
      const status = statusResponse?.data?.status;
      console.log(`[PawaPay][Payout Polling] Statut actuel : ${status}`);
      if (finalStatuses.includes(status)) {
        console.log(`[PawaPay][Payout Polling] Statut final : ${status}`);
        return statusResponse;
      }
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, intervalMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timeout);
            reject(new Error('AbortError'));
          },
          { once: true },
        );
      });
    }
    return { message: 'Statut du payout non confirmé après polling', payoutId, attempts: maxRetries };
  }

  async handlePayoutWebhook(payload: any) {
    const { payoutId, status } = payload;
    console.log(`Webhook payout reçu : ${payoutId} avec statut ${status}`);
    return { message: 'Webhook payout traité avec succès' };
  }

  async handleDepositWebhook(payload: any) {
    const { depositId, status, metadata, amount } = payload;
    const walletIdObj = metadata?.find((m: any) => m.walletId);
    const walletId = walletIdObj?.walletId;

    if (status === 'COMPLETED' && walletId) {
      const wallet = await this.prisma.wallet.findUnique({
        where: { id: walletId },
      });
      if (!wallet) {
        console.error(`Wallet ${walletId} not found for webhook`);
        return { message: 'Wallet not found' };
      }

      await this.prisma.wallet.update({
        where: { id: walletId },
        data: { balance: { increment: amount }, updatedAt: new Date() },
      });

      await this.prisma.transaction.create({
        data: {
          id: uuidv4(),
          userId: wallet.userId,
          walletId,
          amount,
          type: 'DEPOSIT',
          status: 'SUCCESS',
          reference: `PAWAPAY_${depositId}`,
          description: `Dépôt mobile money via PawaPay`,
          movement: 'CREDIT',
        },
      });
    }

    return { message: 'Webhook traité avec succès' };
  }

  async createBulkPayout(
    payouts: Array<{ amount: string; currency: string; provider: string; phone: string; orderId?: string }>,
    signal?: AbortSignal,
  ) {
    const body = payouts.map((p) => ({
      payoutId: uuidv4(),
      amount: p.amount,
      currency: p.currency,
      recipient: { type: 'MMO', accountDetails: { provider: p.provider, phoneNumber: p.phone } },
      customerMessage: 'Payment',
      metadata: [{ orderId: p.orderId ?? `ORD-${Date.now()}` }, { customerId: 'customer@email.com', isPII: true }],
    }));
    const response = await lastValueFrom(
      this.httpService.post(`${this.baseUrl}/v2/payouts/bulk`, body, { headers: this.headers, signal }),
    ).then((r) => r.data);
    console.log('[PawaPay][Bulk Payout] Créés :', body.length);
    return { count: body.length, payouts: response };
  }

  async pollBulkPayoutStatus(payoutIds: string[], signal?: AbortSignal) {
    const results: BulkPayoutResult[] = [];
    for (const payoutId of payoutIds) {
      try {
        const status = await this.pollPayoutStatus(payoutId, signal);
        results.push({ payoutId, status });
      } catch (e: any) {
        results.push({ payoutId, error: e.message });
      }
    }
    return results;
  }

  // ---------- CRUD avec Prisma ----------
  async createCountry(dto: CreateCountryDto) {
    const { currencies, ...countryData } = dto;

    // 1. Vérifier que le code du pays n'existe pas
    const existing = await this.prisma.country_provider.findFirst({
      where: { code: dto.code },
    });
    if (existing) {
      throw new RpcException({
        status: 'error',
        message: `Country with code ${dto.code} already exists`,
        statusCode: 409,
      });
    }

    // 2. Créer le pays
    const country = await this.prisma.country_provider.create({
      data: {
        id: crypto.randomUUID(),
        code: countryData.code,
        name: countryData.name,
        flag: countryData.flag || null,
        prefix: countryData.prefix || null,
        default_currency: countryData.default_currency || null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // 3. Si des devises sont fournies, les ajouter
    if (currencies && currencies.length > 0) {
      for (const currency of currencies) {
        // Vérifier si la devise existe, sinon la créer avec les infos fournies
        let currencyRecord = await this.prisma.currency.findUnique({
          where: { code: currency.currency_code },
        });

        if (!currencyRecord) {
          currencyRecord = await this.prisma.currency.create({
            data: {
              id: crypto.randomUUID(),
              code: currency.currency_code,
              name: currency.currency_name || currency.currency_code,
              symbol: currency.currency_symbol || currency.currency_code,
              created_at: new Date(),
              updated_at: new Date(),
            },
          });
          console.log(`✅ Currency ${currency.currency_code} created automatically`);
        }

        await this.prisma.country_currency.create({
          data: {
            id: crypto.randomUUID(),
            country_id: country.id,
            currency_code: currency.currency_code,
            is_default: currency.is_default || false,
            min_transaction_amount: currency.min_transaction_amount || 0,
            max_transaction_amount: currency.max_transaction_amount || null,
            daily_limit: currency.daily_limit || null,
            monthly_limit: currency.monthly_limit || null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        });
      }
    }

    // 4. Retourner le pays avec ses devises
    const result = await this.prisma.country_provider.findUnique({
      where: { id: country.id },
      include: {
        country_currency: {
          include: { currency: true },
        },
        network_provider: true,
      },
    });

    // ✅ Retour avec message et data
    return {
      message: 'Country created successfully',
      data: result,
    };
  }

  async updateCountry(id: string, dto: UpdateCountryDto) {
    const { currencies, ...countryData } = dto;

    // 1. Vérifier que le pays existe
    const existing = await this.prisma.country_provider.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new RpcException({
        status: 'error',
        message: 'Country not found',
        statusCode: 404,
      });
    }

    // 2. Mettre à jour le pays
    const country = await this.prisma.country_provider.update({
      where: { id },
      data: {
        code: countryData.code,
        name: countryData.name,
        flag: countryData.flag,
        prefix: countryData.prefix,
        default_currency: countryData.default_currency,
        updatedAt: new Date(),
      },
    });

    // 3. Si des devises sont fournies, les mettre à jour
    if (currencies && currencies.length > 0) {
      // Vérifier/créer les devises avant de les associer
      for (const currency of currencies) {
        let currencyRecord = await this.prisma.currency.findUnique({
          where: { code: currency.currency_code },
        });

        if (!currencyRecord) {
          currencyRecord = await this.prisma.currency.create({
            data: {
              id: crypto.randomUUID(),
              code: currency.currency_code,
              name: currency.currency_name || currency.currency_code,
              symbol: currency.currency_symbol || currency.currency_code,
              created_at: new Date(),
              updated_at: new Date(),
            },
          });
          console.log(`✅ Currency ${currency.currency_code} created automatically`);
        }
      }

      // Supprimer les anciennes devises
      await this.prisma.country_currency.deleteMany({
        where: { country_id: id },
      });

      // Ajouter les nouvelles devises
      for (const currency of currencies) {
        await this.prisma.country_currency.create({
          data: {
            id: crypto.randomUUID(),
            country_id: country.id,
            currency_code: currency.currency_code,
            is_default: currency.is_default || false,
            min_transaction_amount: currency.min_transaction_amount || 0,
            max_transaction_amount: currency.max_transaction_amount || null,
            daily_limit: currency.daily_limit || null,
            monthly_limit: currency.monthly_limit || null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        });
      }
    }

    // 4. Retourner le pays avec ses devises
    const result = await this.prisma.country_provider.findUnique({
      where: { id: country.id },
      include: {
        country_currency: {
          include: { currency: true },
        },
        network_provider: true,
      },
    });

    // ✅ Retour avec message et data
    return {
      message: 'Country updated successfully',
      data: result,
    };
  }

  async getCountry(id: string) {
    const country = await this.prisma.country_provider.findUnique({
      where: { id },
      include: {
        country_currency: {
          include: {
            currency: true,
          },
          orderBy: {
            is_default: 'desc',
          },
        },
        network_provider: true,
      },
    });

    if (!country) {
      throw new RpcException({
        status: 'error',
        message: 'Country not found',
        statusCode: 404,
      });
    }

    return {
      message: 'Country retrieved successfully',
      data: this.formatCountryResponse(country),
    };
  }

  async getAllCountries() {
    const countries = await this.prisma.country_provider.findMany({
      include: {
        country_currency: {
          include: {
            currency: true,
          },
          orderBy: {
            is_default: 'desc',
          },
        },
        network_provider: true,
      },
      orderBy: {
        name: 'asc',
      },
    });

    // ✅ Retour avec message et data
    return {
      message: 'Countries retrieved successfully',
      data: countries.map(country => this.formatCountryResponse(country)),
    };
  }

  private async getCountryWithRelations(id: string) {
    const country = await this.prisma.country_provider.findUnique({
      where: { id },
      include: {
        country_currency: {
          include: {
            currency: true,
          },
          orderBy: {
            is_default: 'desc',
          },
        },
        network_provider: true,
      },
    });

    return this.formatCountryResponse(country);
  }

  private formatCountryResponse(country: any): CountryResponseDto {
    return {
      id: country.id,
      code: country.code,
      countryCode: country.countryCode || undefined, // Ajouté pour inclure le code du pays
      name: country.name,
      flag: country.flag || undefined,
      prefix: country.prefix || undefined,
      default_currency: country.default_currency || undefined,
      currencies: country.country_currency.map(cc => ({
        currency_code: cc.currency_code,
        currency_name: cc.currency.name,
        currency_symbol: cc.currency.symbol || undefined,
        is_default: cc.is_default || false,
        min_transaction_amount: cc.min_transaction_amount || undefined,
        max_transaction_amount: cc.max_transaction_amount || undefined,
        daily_limit: cc.daily_limit || undefined,
        monthly_limit: cc.monthly_limit || undefined,
      })),
      network_providers: country.network_provider,
      created_at: country.createdAt,
      updated_at: country.updatedAt,
    };
  }

  async createNetwork(dto: CreateNetworkDto) {
    const country = await this.prisma.country_provider.findUnique({
      where: { id: dto.countryId },
    });
    if (!country) return { message: 'Country not found', data: null };

    const network = await this.prisma.network_provider.create({
      data: {
        name: dto.name,
        currency: dto.currency,
        pourcentage_deposit: dto.pourcentage_deposit,
        pourcentage_payout: dto.pourcentage_payout,
        image: dto.image,
        countryId: dto.countryId,
      },
      include: { country_provider: true },
    });
    return { message: 'Network provider created successfully', data: network };
  }

  async updateNetwork(id: string, dto: UpdateNetworkDto) {
    try {
      const updateData: any = {};
      if (dto.name) updateData.name = dto.name;
      if (dto.currency) updateData.currency = dto.currency;
      if (dto.pourcentage_deposit !== undefined) updateData.pourcentage_deposit = dto.pourcentage_deposit;
      if (dto.pourcentage_payout !== undefined) updateData.pourcentage_payout = dto.pourcentage_payout;
      if (dto.image) updateData.image = dto.image;
      if (dto.countryId) {
        const countryExists = await this.prisma.country_provider.findUnique({ where: { id: dto.countryId } });
        if (!countryExists) return { message: 'Country not found', data: null };
        updateData.countryId = dto.countryId;
      }

      const network = await this.prisma.network_provider.update({
        where: { id },
        data: updateData,
        include: { country_provider: true },
      });
      return { message: 'Network provider updated successfully', data: network };
    } catch (error) {
      return { message: 'Network provider not found', data: null };
    }
  }

  async getNetwork(id: string) {
    const network = await this.prisma.network_provider.findUnique({
      where: { id },
      include: { country_provider: true },
    });
    if (!network) return { message: 'Network provider not found', data: null };
    return { message: 'Network provider retrieved successfully', data: network };
  }

  async getAllNetworks() {
    const networks = await this.prisma.network_provider.findMany({
      include: { country_provider: true },
    });
    return { message: 'Network providers retrieved successfully', data: networks };
  }

  // Dans pawapay.service.ts
  async getNetworksByCountry(countryCode: string) {
    console.log('[PawaPay] getNetworksByCountry called with:', countryCode);
    console.log('[PawaPay] countryCode type:', typeof countryCode);
    console.log('[PawaPay] countryCode length:', countryCode?.length);

    // 🔍 Recherche du pays avec ses network providers
    const country = await this.prisma.country_provider.findFirst({
      where: {
        OR: [
          { code: { equals: countryCode.toUpperCase() } },
          { countryCode: { equals: countryCode.toUpperCase() } },
        ],
      },
      include: {
        network_provider: {
          orderBy: {
            name: 'asc',
          },
        },
        country_currency: {
          include: {
            currency: true,
          },
        },
      },
    });

    console.log('[PawaPay] Country found:', country ? country.name : 'NOT FOUND');
    console.log('[PawaPay] Country data:', country);

    if (!country) {
      console.error('[PawaPay] Country not found for code:', countryCode);
      throw new RpcException({
        status: 'error',
        message: `Country with code ${countryCode} not found`,
        statusCode: 404,
      });
    }

    // 🔍 Récupérer les networks (peut être vide)
    const networks = country.network_provider || [];

    console.log('[PawaPay] Networks found:', networks.length);

    // 🗺️ Formater les devises du pays
    const currencies = country.country_currency?.map(cc => ({
      code: cc.currency_code,
      name: cc.currency?.name || cc.currency_code,
      symbol: cc.currency?.symbol || cc.currency_code,
      is_default: cc.is_default || false,
      min_transaction_amount: cc.min_transaction_amount,
      max_transaction_amount: cc.max_transaction_amount,
      daily_limit: cc.daily_limit,
      monthly_limit: cc.monthly_limit,
    })) || [];

    // 🗺️ Formater les networks
    const formattedNetworks = networks.map(network => ({
      id: network.id,
      name: network.name,
      currency: network.currency,
      currencies: network.currency ? network.currency.split(',') : [],
      pourcentage_deposit: network.pourcentage_deposit || 0,
      pourcentage_payout: network.pourcentage_payout || 0,
      image: network.image,
      countryId: network.countryId,
      createdAt: network.createdAt,
      updatedAt: network.updatedAt,
    }));

    return {
      message: networks.length > 0
        ? 'Network providers retrieved successfully'
        : 'No network providers found for this country',
      data: {
        country: {
          id: country.id,
          code: country.code,
          countryCode: country.countryCode,
          name: country.name,
          flag: country.flag,
          prefix: country.prefix,
          default_currency: country.default_currency,
          currencies: currencies,
        },
        networks: formattedNetworks,
      },
    };
  }
  // ---------- Géolocalisation ----------
  async getCountryByCode(ip: string) {
    try {
      const countryCode = 'CD';
      const country = await this.prisma.country_provider.findFirst({
        where: {
          countryCode: countryCode  // ✅ Utiliser 'countryCode' au lieu de 'code'
        },
        include: { network_provider: true },
      });
      if (!country) return await this.getDefaultCountry();
      return { message: `Pays "${countryCode}" défini par défaut`, data: country };
    } catch (err: any) {
      console.error('Erreur récupération pays :', err.message);
      return await this.getDefaultCountry();
    }
  }

  private async getDefaultCountry() {
    const defaultCode = 'CD';
    const country = await this.prisma.country_provider.findFirst({
      where: {
        countryCode: defaultCode  // ✅ Utiliser 'countryCode' au lieu de 'code'
      },
      include: { network_provider: true },
    });
    if (!country) return { message: 'Pays par défaut introuvable dans la base', data: null };
    return { message: `Pays par défaut "${defaultCode}" retourné`, data: country };
  }
  // Dans pawapay.service.ts
  async getCountryByCodePublic(code: string) {
    return this.prisma.country_provider.findFirst({
      where: {
        countryCode: code  // ✅ Utiliser 'countryCode' au lieu de 'code'
      },
      include: { network_provider: true },
    });
  }
}