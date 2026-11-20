import { Controller, Get } from '@nestjs/common';
import { AccespayServiceService } from './accespay-service.service';

@Controller()
export class AccespayServiceController {
  constructor(private readonly accespayServiceService: AccespayServiceService) {}

  @Get()
  getHello(): string {
    return this.accespayServiceService.getHello();
  }
}
