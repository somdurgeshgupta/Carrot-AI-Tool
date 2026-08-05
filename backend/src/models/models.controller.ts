import { Controller, Get, Query } from '@nestjs/common';
import { ModelsService } from './models.service';

@Controller('models')
export class ModelsController {
  constructor(private readonly modelsService: ModelsService) {}

  @Get()
  async getModels(@Query('localUrl') customLocalUrl?: string) {
    return this.modelsService.getAvailableModels(customLocalUrl);
  }

  @Get('health')
  async checkHealth(@Query('localUrl') customLocalUrl?: string) {
    return this.modelsService.checkHealth(customLocalUrl);
  }
}
