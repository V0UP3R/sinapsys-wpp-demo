import { Controller, Post, Body, UseGuards, Req } from '@nestjs/common';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@Controller('message')
@UseGuards(JwtAuthGuard) 
export class MessageController {
  constructor(private readonly whatsappService: WhatsappService) {}

  @Post('connect')
  async connect(@Req() req): Promise<{ qrUrl: string }> {
    const userId = req.user.userId;
    const qrUrl = await this.whatsappService.getQrCodeUrl(userId);
    return { qrUrl };
  }
  
  /** Disparar mensagem usando sessão do usuário autenticado */
  @Post('send')
  async sendMessage(
    @Req() req,
    @Body() body: { to: string; message: string; appointmentId: number },
  ) {
    const userId = req.user.userId;
    await this.whatsappService.sendMessage(
      userId,
      body.to,
      body.message,
      body.appointmentId,
    );
    return { status: 'Mensagem enviada!' };
  }
  // // Endpoint protegido por JWT para disparar mensagem
  // // @UseGuards(JwtAuthGuard)
  // @Post('send')
  // async sendMessage(
  //   @Body() body: { to: string; message: string; appointmentId: string},
  // ) {
  //   await this.whatsappService.sendMessage(body.to, body.message,+body.appointmentId);
  //   return { status: 'Mensagem enviada!' };
  // }
}