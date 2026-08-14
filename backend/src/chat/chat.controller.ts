import { Controller, Post, Body, Res, Req, UseGuards } from '@nestjs/common';
import { ChatService, ChatRequestDto } from './chat.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('completions')
  async createCompletion(@Body() dto: ChatRequestDto, @Req() req: any, @Res() res: any) {
    if (dto.stream !== false) {
      return this.chatService.handleChatCompletion(dto, req.user.id, res);
    } else {
      const result = await this.chatService.handleChatCompletion(dto, req.user.id);
      return res.json(result);
    }
  }

  @Post('extract-text')
  async extractText(@Body() body: { fileName: string; base64: string }) {
    return this.chatService.extractTextFromDocument(body.fileName, body.base64);
  }
}
