import {
  BadRequestException,
  Body,
  Controller,
  InternalServerErrorException,
  Post,
  UseGuards,
} from '@nestjs/common';
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

    try {
      const qrCodeUrl = await this.whatsappService.connect(body.phone, {
        requestQr: true,
      });

      return { qrCodeUrl };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Falha ao conectar o WhatsApp.';

      if (/qr code|sess[aã]o expirada|logged out|401/i.test(message)) {
        throw new BadRequestException(message);
      }

      throw new InternalServerErrorException(message);
    }
  }

  /** Disparar mensagem usando sessão do usuário autenticado */
  @Post('send')
  @Public()
  @UseGuards(InternalApiGuard)
  async sendMessage(
    @Body()
    body: {
      phone: string;
      to: string;
      message: string;
      appointmentId: number;
      triggerType?: string | null;
      triggerSource?: string | null;
      confirmationContext?: {
        clinicId?: number | null;
        patientName?: string | null;
        recipientName?: string | null;
        professionalName?: string | null;
        clinicName?: string | null;
        blockStartTime?: string | null;
        blockEndTime?: string | null;
        timezone?: string | null;
      } | null;
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

    const appointmentId = Number(body?.appointmentId);
    if (!Number.isInteger(appointmentId) || appointmentId <= 0) {
      throw new BadRequestException('Campo "appointmentId" inválido.');
    }

    const result = await this.whatsappService.sendMessage(
      body.phone,
      body.to,
      body.message,
      appointmentId,
      {
        triggerType: body.triggerType ?? null,
        triggerSource: body.triggerSource ?? null,
        confirmationContext: body.confirmationContext ?? null,
      },
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
      userId?: number;
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
      body.userId !== undefined ? Number(body.userId) : undefined,
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
