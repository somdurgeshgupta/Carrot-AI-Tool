import { Injectable } from '@nestjs/common';
import { RedisCacheService } from '../cache/redis-cache.service';

@Injectable()
export class HealthService {
  constructor(private readonly cache: RedisCacheService) {}

  checkHealth() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'NestJS Backend API',
      version: '1.0.0',
      cache: this.cache.status(),
    };
  }
}
