import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@Controller('message')
export class MessageController {
  constructor(private readonly whatsappService: WhatsappService) {}

  // Endpoint protegido por JWT para disparar mensagem
  // @UseGuards(JwtAuthGuard)
  @Post('send')
  async sendMessage(
    @Body() body: { to: string; message: string; appointmentId: string},
  ) {
    await this.whatsappService.sendMessage(body.to, body.message,+body.appointmentId);
    return { status: 'Mensagem enviada!' };
  }
}