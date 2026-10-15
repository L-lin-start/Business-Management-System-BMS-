import { Controller, Get } from '@nestjs/common';

@Controller('api/health')
export class HealthController {
  @Get()
  check() {
    return {
      status: 'ok' as const,
      service: 'bms-api',
      database: process.env.BMS_DATABASE_ENABLED === 'true' ? 'configured' : 'disabled',
      timestamp: new Date().toISOString(),
    };
  }
}
