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
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import * as path from 'path';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RagService } from './rag.service';
import { IngestionQueueService } from './ingestion-queue.service';

@Controller('rag')
@UseGuards(JwtAuthGuard)
export class RagController {
  constructor(
    private readonly ragService: RagService,
    private readonly ingestionQueue: IngestionQueueService,
  ) {}

  @Post('upload')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 15 * 1024 * 1024, files: 1 },
    }),
  )
  async uploadDocument(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
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

    return this.ingestionQueue.enqueueFile(
      userId,
      fileName,
      fileBuffer,
      mimeType,
    );
  }

  @Post('website')
  @HttpCode(HttpStatus.ACCEPTED)
  async indexWebsite(@Body() body: { url?: string }, @Req() req: any) {
    if (!body?.url || body.url.length > 2_048) {
      throw new BadRequestException('A valid website URL is required');
    }
    return this.ingestionQueue.enqueueWebsite(req.user.id, body.url);
  }

  @Post('sitemap')
  @HttpCode(HttpStatus.ACCEPTED)
  async indexSitemap(@Body() body: { url?: string }, @Req() req: any) {
    if (!body?.url || body.url.length > 2_048) {
      throw new BadRequestException('A valid sitemap URL is required');
    }
    return this.ingestionQueue.enqueueSitemap(req.user.id, body.url);
  }

  @Get('ingestion/:jobId')
  async getIngestionJob(@Param('jobId') jobId: string, @Req() req: any) {
    return this.ingestionQueue.getJob(req.user.id, jobId);
  }

  @Delete('ingestion/:jobId')
  async cancelIngestionJob(@Param('jobId') jobId: string, @Req() req: any) {
    return this.ingestionQueue.cancelJob(req.user.id, jobId);
  }

  @Get('documents')
  async getUserDocuments(@Req() req: any) {
    const userId = req.user.id;
    return this.ragService.getUserDocuments(userId);
  }

  @Get('sources')
  async getUserSources(@Req() req: any) {
    return this.ragService.getUserSources(req.user.id);
  }

  @Delete('documents/:fileName')
  async deleteDocument(@Param('fileName') fileName: string, @Req() req: any) {
    const userId = req.user.id;
    return this.ragService.deleteDocument(userId, fileName);
  }
}
