import { Test, TestingModule } from '@nestjs/testing';
import { AccespayServiceController } from './accespay-service.controller';
import { AccespayServiceService } from './accespay-service.service';

describe('AccespayServiceController', () => {
  let accespayServiceController: AccespayServiceController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AccespayServiceController],
      providers: [AccespayServiceService],
    }).compile();

    accespayServiceController = app.get<AccespayServiceController>(AccespayServiceController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(accespayServiceController.getHello()).toBe('Hello World!');
    });
  });
});
