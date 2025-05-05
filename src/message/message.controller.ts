import { Controller, Post, Body, UseGuards, Req } from '@nestjs/common';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@Controller('message')
@UseGuards(JwtAuthGuard) 
export class MessageController {
  constructor(private readonly whatsappService: WhatsappService) {}

  @Post('connect')
  async connect(@Body() body: {phone:string}): Promise<{ qrCodeUrl: string }> {
    const qrCodeUrl = await this.whatsappService.connect(body.phone);
    return { qrCodeUrl };
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
}