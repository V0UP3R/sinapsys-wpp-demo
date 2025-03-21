import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@Controller('message')
export class MessageController {
  constructor(private readonly whatsappService: WhatsappService) {}

  // Endpoint protegido por JWT para disparar mensagem
  @UseGuards(JwtAuthGuard)
  @Post('send')
  async sendMessage(
    @Body() body: { to: string; message: string },
  ) {
    await this.whatsappService.requestConfirmation(body.to, body.message);
    return { status: 'Mensagem enviada!' };
  }
}