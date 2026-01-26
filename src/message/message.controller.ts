import { Controller, Post, Body, UseGuards, Req } from '@nestjs/common';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Public } from 'src/auth/decorators/public.decorator';
import { InternalApiGuard } from 'src/auth/internal-api.guard';

@Controller('message')
@UseGuards(JwtAuthGuard) 
export class MessageController {
  constructor(private readonly whatsappService: WhatsappService) {}

  @Post('connect')
  @UseGuards(InternalApiGuard)
  async connect(@Body() body: {phone:string}): Promise<{ qrCodeUrl: string }> {
    const qrCodeUrl = await this.whatsappService.connect(body.phone, { requestQr: true });
    return { qrCodeUrl };
  }
  
  /** Disparar mensagem usando sessão do usuário autenticado */
  @Post('send')
  @Public()
  @UseGuards(InternalApiGuard)
  async sendMessage(
    @Body() body: { phone:string; to: string; message: string; appointmentId: number },
  ) {
    await this.whatsappService.sendMessage(
      body.phone,
      body.to,
      body.message,
      body.appointmentId,
    );
    return { status: 'Mensagem enviada!' };
  }

  @Post('disconnect')
  @UseGuards(InternalApiGuard)
  async disconnect(@Body() body: {phone:string}): Promise<{ success: boolean }> {
    await this.whatsappService.disconnect(body.phone);
    return { success: true };
  }
}
