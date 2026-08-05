import { Controller, Post, Body, Res } from '@nestjs/common';
import { ChatService, ChatRequestDto } from './chat.service';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('completions')
  async createCompletion(@Body() dto: ChatRequestDto, @Res() res: any) {
    if (dto.stream !== false) {
      return this.chatService.handleChatCompletion(dto, res);
    } else {
      const result = await this.chatService.handleChatCompletion(dto);
      return res.json(result);
    }
  }
}
