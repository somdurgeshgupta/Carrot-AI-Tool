import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AgentService } from './agent.service';

class AgentMessageDto {
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';

  @IsString()
  content: string;
}

export class AgentTurnDto {
  @IsString()
  modelId: string;

  @IsBoolean()
  localOnly: boolean;

  @IsString()
  systemPrompt: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AgentMessageDto)
  messages: AgentMessageDto[];
}

export class AgentWebSearchDto {
  @IsString()
  @MaxLength(500)
  query: string;
}

@Controller('agent')
@UseGuards(JwtAuthGuard)
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @Post('turn')
  turn(@Req() req: any, @Body() dto: AgentTurnDto) {
    return this.agentService.turn(req.user.id, dto);
  }

  @Post('web-search')
  webSearch(@Body() dto: AgentWebSearchDto) {
    return this.agentService.webSearch(dto.query);
  }
}
