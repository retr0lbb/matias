import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service.js';

@Module({
  providers: [PaymentService],
  exports: [PaymentService]
})
export class PaymentModule {}
