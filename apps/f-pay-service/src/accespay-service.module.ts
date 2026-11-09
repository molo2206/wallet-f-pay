import { Module } from '@nestjs/common';
import { AccespayServiceController } from './accespay-service.controller';
import { AccespayServiceService } from './accespay-service.service';

@Module({
  imports: [],
  controllers: [AccespayServiceController],
  providers: [AccespayServiceService],
})
export class AccespayServiceModule {}
