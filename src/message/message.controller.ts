import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Public } from 'src/auth/decorators/public.decorator';
import { InternalApiGuard } from 'src/auth/internal-api.guard';
import { WhatsappService } from '../whatsapp/whatsapp.service';

@Controller('message')
@UseGuards(JwtAuthGuard)
export class MessageController {
  constructor(private readonly whatsappService: WhatsappService) {}

  @Post('connect')
  @UseGuards(InternalApiGuard)
  async connect(@Body() body: { phone: string }): Promise<{ qrCodeUrl: string }> {
    if (!body?.phone) {
      throw new BadRequestException('Campo "phone" é obrigatório.');
    }

    const qrCodeUrl = await this.whatsappService.connect(body.phone, {
      requestQr: true,
    });

    return { qrCodeUrl };
  }

  /** Disparar mensagem usando sessão do usuário autenticado */
  @Post('send')
  @Public()
  @UseGuards(InternalApiGuard)
  async sendMessage(
    @Body()
    body: { phone: string; to: string; message: string; appointmentId: number },
  ) {
    if (!body?.phone) {
      throw new BadRequestException('Campo "phone" é obrigatório.');
    }
    if (!body?.to) {
      throw new BadRequestException('Campo "to" é obrigatório.');
    }
    if (!body?.message) {
      throw new BadRequestException('Campo "message" é obrigatório.');
    }

    const appointmentId = Number(body?.appointmentId);
    if (!Number.isInteger(appointmentId) || appointmentId <= 0) {
      throw new BadRequestException('Campo "appointmentId" inválido.');
    }

    const result = await this.whatsappService.sendMessage(
      body.phone,
      body.to,
      body.message,
      appointmentId,
    );

    if (!result.success) {
      return {
        success: false,
        status: 'Mensagem não enviada.',
        reason: result.reason,
      };
    }

    return { success: true, status: 'Mensagem enviada!' };
  }

  @Post('send-assistant')
  @Public()
  @UseGuards(InternalApiGuard)
  async sendAssistantMessage(
    @Body()
    body: {
      phone: string;
      to: string;
      message: string;
      conversationId: string;
      userId: number;
    },
  ) {
    if (!body?.phone) {
      throw new BadRequestException('Campo "phone" é obrigatório.');
    }
    if (!body?.to) {
      throw new BadRequestException('Campo "to" é obrigatório.');
    }
    if (!body?.message) {
      throw new BadRequestException('Campo "message" é obrigatório.');
    }
    if (!body?.conversationId) {
      throw new BadRequestException('Campo "conversationId" é obrigatório.');
    }

    const result = await this.whatsappService.sendAssistantMessage(
      body.phone,
      body.to,
      body.message,
      body.conversationId,
      Number(body.userId),
    );

    if (!result.success) {
      return {
        success: false,
        status: 'Mensagem não enviada.',
        reason: result.reason,
      };
    }

    return { success: true, status: 'Mensagem enviada!' };
  }

  @Post('disconnect')
  @UseGuards(InternalApiGuard)
  async disconnect(@Body() body: { phone: string }): Promise<{ success: boolean }> {
    if (!body?.phone) {
      throw new BadRequestException('Campo "phone" é obrigatório.');
    }

    await this.whatsappService.disconnect(body.phone);
    return { success: true };
  }
}
