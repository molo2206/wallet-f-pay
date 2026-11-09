import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateUserTransactionLimitDto } from './dto/update-user-transaction-limit.dto';

@Injectable()
export class UserTransactionLimitService {
  constructor(private readonly prisma: PrismaService) {}

  private async getOrCreate(userId: string) {
    let limit = await this.prisma.user_transaction_limit.findUnique({
      where: { user_id: userId },
    });
    if (!limit) {
      limit = await this.prisma.user_transaction_limit.create({
        data: { user_id: userId },
      });
    }
    return limit;
  }

  async getLimitByUserId(userId: string) {
    return this.getOrCreate(userId);
  }

  async updateLimit(userId: string, dto: UpdateUserTransactionLimitDto) {
    await this.getOrCreate(userId);
    return this.prisma.user_transaction_limit.update({
      where: { user_id: userId },
      data: dto,
    });
  }

  async checkTransactionLimit(userId: string, amount: number) {
    const limits = await this.getOrCreate(userId);
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfYear = new Date(now.getFullYear(), 0, 1);

    const [dailySpent, monthlySpent, yearlySpent] = await Promise.all([
      this.prisma.transaction.aggregate({
        where: { userId, movement: 'DEBIT', createdAt: { gte: startOfDay } },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { userId, movement: 'DEBIT', createdAt: { gte: startOfMonth } },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { userId, movement: 'DEBIT', createdAt: { gte: startOfYear } },
        _sum: { amount: true },
      }),
    ]);

    const daily = dailySpent._sum.amount || 0;
    const monthly = monthlySpent._sum.amount || 0;
    const yearly = yearlySpent._sum.amount || 0;

    if (amount > limits.per_transaction_limit)
      throw new Error(Per transaction limit is );
    if (daily + amount > limits.daily_limit)
      throw new Error(Daily limit of  exceeded);
    if (monthly + amount > limits.monthly_limit)
      throw new Error(Monthly limit of  exceeded);
    if (yearly + amount > limits.yearly_limit)
      throw new Error(Yearly limit of  exceeded);
    return true;
  }
}
