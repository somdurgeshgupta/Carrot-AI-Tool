import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Req,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import * as path from 'path';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RagService } from './rag.service';

@Controller('rag')
@UseGuards(JwtAuthGuard)
export class RagController {
  constructor(private readonly ragService: RagService) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024, files: 1 } }))
  async uploadDocument(@UploadedFile() file: Express.Multer.File, @Req() req: any) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    const userId = req.user.id;
    const fileName = path.basename(file.originalname);
    if (!fileName || fileName.length > 255) {
      throw new BadRequestException('Invalid file name');
    }
    const fileBuffer = file.buffer;
    const mimeType = file.mimetype;

    return this.ragService.indexDocument(userId, fileName, fileBuffer, mimeType);
  }

  @Get('documents')
  async getUserDocuments(@Req() req: any) {
    const userId = req.user.id;
    return this.ragService.getUserDocuments(userId);
  }

  @Delete('documents/:fileName')
  async deleteDocument(@Param('fileName') fileName: string, @Req() req: any) {
    const userId = req.user.id;
    return this.ragService.deleteDocument(userId, fileName);
  }
}
