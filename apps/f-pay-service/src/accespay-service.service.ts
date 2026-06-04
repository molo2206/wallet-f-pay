import { Injectable } from '@nestjs/common';

@Injectable()
export class AccespayServiceService {
  getHello(): string {
    return 'Hello World!';
  }
}
