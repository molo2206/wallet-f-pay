/* eslint-disable @typescript-eslint/require-await */
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import { AuditService } from './audit-service.service';
import { CreateAuditLogDto, GetAuditLogsDto } from '../dto/audit.dto';
import { NotFoundException } from '@nestjs/common';

@Controller()
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @MessagePattern('audit_log')
  async log(@Payload() data: CreateAuditLogDto) {
    try {
      return await this.auditService.log(data);
    } catch (error) {
      throw new RpcException({
        status: 'error',
        message: error.message,
        statusCode: 500,
      });
    }
  }

  @MessagePattern('get_audit_logs')
  async handleGetAuditLogs(@Payload() payload: GetAuditLogsDto) {
    try {
      return await this.auditService.getLogs(payload);
    } catch (error) {
      throw new RpcException({
        status: 'error',
        message: error.message,
        statusCode: 500,
      });
    }
  }

  @MessagePattern('get_audit_log_by_id')
  async handleGetAuditLogById(@Payload() data: { id: string }) {
    try {
      if (!data.id) {
        throw new RpcException({
          status: 'error',
          message: 'Audit log ID is required',
          statusCode: 400,
        });
      }
      return await this.auditService.getLogById(data.id);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new RpcException({
          status: 'error',
          message: error.message,
          statusCode: 404,
        });
      }
      throw new RpcException({
        status: 'error',
        message: error.message,
        statusCode: 500,
      });
    }
  }

  @MessagePattern('delete_audit_log_by_id')
  async handleDeleteAuditLogById(@Payload() data: { id: string }) {
    try {
      if (!data.id) {
        throw new RpcException({
          status: 'error',
          message: 'Audit log ID is required',
          statusCode: 400,
        });
      }
      return await this.auditService.deleteLogById(data.id);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new RpcException({
          status: 'error',
          message: error.message,
          statusCode: 404,
        });
      }
      throw new RpcException({
        status: 'error',
        message: error.message,
        statusCode: 500,
      });
    }
  }

  @MessagePattern('health_check')
  async healthCheck() {
    return { status: 'ok', service: 'audit-service' };
  }
}
