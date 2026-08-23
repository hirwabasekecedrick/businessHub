import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
  NotFoundException,
} from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { UserContext } from '../../common/abilities/case-ability.service';

@Controller('v1')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get('documents')
  async getDocuments(@CurrentUser() ctx: UserContext, @Query('caseId') caseId?: string) {
    return this.documentsService.getDocuments(ctx, { caseId });
  }

  @Post('documents/upload-sessions')
  async createUploadSession(@CurrentUser() ctx: UserContext, @Body() body: any) {
    return this.documentsService.createUploadSession(ctx, body);
  }

  @Post('documents/upload-sessions/:id/complete')
  @HttpCode(201)
  async completeUploadSession(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.documentsService.completeUploadSession(ctx, id);
  }

  @Get('documents/:id/download-url')
  async getDownloadUrl(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.documentsService.getDownloadUrl(ctx, id);
  }

  /** Consumes the single-use token; a second fetch fails. */
  @Get('documents/:id/download')
  async download(@Param('id') id: string, @Query('token') token: string) {
    const doc = await this.documentsService.downloadByGrant(id, token);
    if (!doc) throw new NotFoundException({ code: 'NOT_FOUND' });
    return doc;
  }

  @Get('documents/:id/versions')
  async getVersions(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.documentsService.getVersions(ctx, id);
  }

  @Post('documents/:id/versions')
  async uploadNewVersion(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() body: any) {
    return this.documentsService.uploadNewVersion(ctx, id, body);
  }

  @Patch('documents/:id')
  async updateDocument(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() body: any) {
    return this.documentsService.updateDocument(ctx, id, body);
  }

  @Delete('documents/:id')
  async deleteDocument(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.documentsService.deleteDocument(ctx, id);
  }

  @Post('documents/:id/signature-requests')
  async createSignatureRequest(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() body: any) {
    return this.documentsService.createSignatureRequest(ctx, id, body);
  }

  @Get('signature-requests/:id')
  async getSignatureRequest(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.documentsService.getSignatureRequest(ctx, id);
  }

  /**
   * Public webhook; HMAC-SHA256 of the raw body in x-signature.
   * Raw-body access requires the bodyParser bypass in main.ts for this route.
   */
  @Public()
  @Post('webhooks/esign')
  @HttpCode(200)
  async esignWebhook(@Req() req: any) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    if (!this.documentsService.verifyEsignSignature(raw, req.headers['x-signature'])) {
      throw new NotFoundException({ code: 'INVALID_SIGNATURE' });
    }
    return this.documentsService.esignWebhook(req.body);
  }
}
