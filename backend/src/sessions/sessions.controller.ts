import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, Req } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { CreateSessionDto, UpdateSessionDto } from './sessions.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('sessions')
@UseGuards(JwtAuthGuard)
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  @Get()
  async getSessions(@Req() req: any) {
    return this.sessionsService.getUserSessions(req.user.id);
  }

  @Get(':id')
  async getSessionDetails(@Req() req: any, @Param('id') id: string) {
    return this.sessionsService.getSessionWithMessages(req.user.id, id);
  }

  @Post()
  async createSession(@Req() req: any, @Body() dto: CreateSessionDto) {
    return this.sessionsService.createSession(req.user.id, dto.title, dto.modelId);
  }

  @Patch(':id')
  async updateSessionTitle(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateSessionDto) {
    return this.sessionsService.updateSessionTitle(req.user.id, id, dto.title);
  }

  @Delete(':id')
  async deleteSession(@Req() req: any, @Param('id') id: string) {
    return this.sessionsService.deleteSession(req.user.id, id);
  }
}
