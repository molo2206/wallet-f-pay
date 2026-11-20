/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config'; // ✅
import { PawapayService } from './pawapay.service';
import { PawapayController } from './pawapay.controller';

@Module({
  imports: [HttpModule, ConfigModule], // ✅
  providers: [PawapayService],
  controllers: [PawapayController],
  exports: [PawapayService],
})
export class PawapayModule { }