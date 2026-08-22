import { Global, Module } from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';
import { REDIS_CLIENT_FACTORY, RedisCacheService } from './redis-cache.service';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT_FACTORY,
      useValue: (url: string, options: RedisOptions) => new Redis(url, options),
    },
    RedisCacheService,
  ],
  exports: [RedisCacheService],
})
export class CacheModule {}
