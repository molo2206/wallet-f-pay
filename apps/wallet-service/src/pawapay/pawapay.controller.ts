/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Controller, Get, Post, Body, Query, Param, Patch, Req } from '@nestjs/common';

import { CreateNetworkDto } from './dto/create-network.dto';
import { UpdateNetworkDto } from './dto/update-network.dto';
import { CreateCountryDto } from './dto/create-country.dto';
import { UpdateCountryDto } from './dto/update-country.dto';
import type { OperationType } from './pawapay.service';
import { PawapayService } from './pawapay.service';

@Controller('pawapay')
export class PawapayController {
  constructor(private readonly pawapayService: PawapayService) {}

  @Get('availability')
  async availability(
    @Query('country') country?: string,
    @Query('operationType') operationType?: OperationType,
  ) {
    const data = await this.pawapayService.getAvailability(country, operationType);

    return {
      message: 'Disponibilité Pawapay',
      data,
    };
  }

  @Get('active-conf')
  async activeConf(
    @Query('country') country?: string,
    @Query('operationType') operationType?: 'DEPOSIT' | 'PAYOUT' | 'REFUND',
  ) {
    const data = await this.pawapayService.getActiveConf(country, operationType);

    return {
      message: 'Configuration active Pawapay filtrée',
      data,
    };
  }

  @Get('wallet-balances')
  async walletBalances(
    @Query('country') country?: string,
    @Query('provider') provider?: string,
  ) {
    const data = await this.pawapayService.getWalletBalances(country, provider);

    return {
      message: 'Soldes des wallets Pawapay filtrés',
      data,
    };
  }

  @Post('deposit')
  async createDeposit(
    @Body() data: { amount: string; currency: string; provider: string; phone: string },
  ) {
    return this.pawapayService.createDepositSimple(data);
  }

  @Get('deposit-status/:depositId')
  async depositStatus(@Param('depositId') depositId: string) {
    return this.pawapayService.checkDepositStatus(depositId);
  }

  @Post('countries')
  async createCountry(@Body() dto: CreateCountryDto) {
    return this.pawapayService.createCountry(dto);
  }

  @Patch('countries/:id')
  async updateCountry(@Param('id') id: string, @Body() dto: UpdateCountryDto) {
    return this.pawapayService.updateCountry(id, dto);
  }

  @Get('countries/:id')
  async getCountry(@Param('id') id: string) {
    return this.pawapayService.getCountry(id);
  }

  @Get('countries')
  async getAllCountries() {
    return this.pawapayService.getAllCountries();
  }

  // ------------------- NETWORK PROVIDER ENDPOINTS -------------------
  @Post('network-providers')
  async createNetwork(@Body() dto: CreateNetworkDto) {
    return this.pawapayService.createNetwork(dto);
  }

  @Patch('network-providers/:id')
  async updateNetwork(@Param('id') id: string, @Body() dto: UpdateNetworkDto) {
    return this.pawapayService.updateNetwork(id, dto);
  }

  @Get('network-providers/:id')
  async getNetwork(@Param('id') id: string) {
    return this.pawapayService.getNetwork(id);
  }

  @Get('network-providers')
  async getAllNetworks() {
    return this.pawapayService.getAllNetworks();
  }
}
