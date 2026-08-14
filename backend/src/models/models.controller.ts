import { Controller, Get, Query } from '@nestjs/common';
import { ModelsService } from './models.service';

@Controller('models')
export class ModelsController {
  constructor(private readonly modelsService: ModelsService) {}

  @Get()
  async getModels(@Query('localUrl') customLocalUrl?: string, @Query('refresh') refresh?: string) {
    return this.modelsService.getAvailableModels(customLocalUrl, refresh === 'true');
  }

  @Get('health')
  async checkHealth(@Query('localUrl') customLocalUrl?: string) {
    return this.modelsService.checkHealth(customLocalUrl);
  }
}
