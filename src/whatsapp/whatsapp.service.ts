import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client, LocalAuth } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import { NlpManager } from 'node-nlp';
import puppeteer from 'puppeteer';
import { HttpService } from '@nestjs/axios';
import { PendingConfirmation } from 'src/message/entities/message.entity';
import { v4 as uuidv4 } from 'uuid';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class WhatsappService implements OnModuleInit {
  private client: Client;
  private nlpManager: NlpManager;
  private readonly logger = new Logger(WhatsappService.name);

  // Removendo o Set em memória
  // private pendingConfirmations: Set<string> = new Set();

  constructor(
    private readonly httpService: HttpService,
    @InjectRepository(PendingConfirmation)
    private readonly pendingConfirmationRepo: Repository<PendingConfirmation>,
  ) {
    // Inicializa o NLP Manager para o idioma português
    this.nlpManager = new NlpManager({ languages: ['pt'] });
    this.trainNlp();
    // Inicializa o cliente do WhatsApp com autenticação local
    this.initializeClient();
  }

  private async initializeClient() {
    const chrome = puppeteer.executablePath();
    const dataPath = '../whatsapp-session';

    this.client = new Client({
      puppeteer: {
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--single-process',
          '--no-sandbox',
          '--disable-gpu',
          '--remote-debugging-port=9222',
        ],
        headless: true,
      },
      authStrategy: new LocalAuth({ dataPath }),
    });
  }

  async onModuleInit() {  
    this.client.on('qr', (qr) => {
      const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}&size=300x300`;
      this.logger.log('Acesse o QR Code via o link:', qrCodeUrl);
    });
  
    this.client.on('ready', () => {
      this.logger.log('Cliente do WhatsApp pronto!');
    });

    this.client.on('auth_failure', (msg) => {
      this.logger.error('Falha na autenticação:', msg);
    });
    
    this.client.on('disconnected', (reason) => {
      this.logger.warn('Cliente desconectado:', reason);
    });
  
    // Processa mensagens somente se houver confirmação pendente no banco
    this.client.on('message', async (message) => {
      this.logger.log('Mensagem recebida:', message.body);

      // Verifica se o número existe no banco de confirmações pendentes
      const confirmation = await this.pendingConfirmationRepo.findOne({
        where: { phone: message.from },
      });
      
      if (!confirmation) {
        return;
      }
      
      const normalizedText = this.normalizeText(message.body);
      const response = await this.nlpManager.process('pt', normalizedText);
  
      if (response.intent === 'confirmar' && response.score > 0.8) {
        const responseApi = await firstValueFrom(this.httpService.patch(`http://localhost:3001/appointment/${confirmation.appointmentId}`, { appointmentStatus:"Confirmado" }, {
          headers: {
            'x-internal-api-secret': process.env.API_SECRET,
          },
        }));
        await this.client.sendMessage(message.from, 'Confirmei seu atendimento te aguardamos ansiosos! 😁');
        // Remove a confirmação após o processamento
        await this.pendingConfirmationRepo.delete({ phone: message.from });
      } else if (response.intent === 'cancelar' && response.score > 0.8) {
        const responseApi = await firstValueFrom(this.httpService.patch(`http://localhost:3001/appointment/${confirmation.appointmentId}`, { appointmentStatus:"Cancelado", reasonLack: `Cancelado pelo Whatssapp` }, {
          headers: {
            'x-internal-api-secret': process.env.API_SECRET,
          },
        }));
        await this.client.sendMessage(message.from, 'Cancelei seu atendimento, caso tenha alguma dúvida basta entrar em contato conosco! 😁');
        await this.pendingConfirmationRepo.delete({ phone: message.from });
      } else {
        this.logger.log('Resposta não foi suficientemente clara. Nenhuma ação tomada.');
      }
    });
  
    this.client.initialize();
  }

  // Função para normalizar o texto (exemplo simples)
  private normalizeText(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
  }

  // Treinamento robusto do NLP com exemplos para confirmar ou cancelar
  private async trainNlp() {
    const confirmExamples = [
      "sim", "confirmo", "está ok", "ok", "certo", "claro", "afirmativo",
      "estou de acordo", "com certeza", "acordo", "isso mesmo", "vou confirmar",
      "confirmar atendimento", "tudo certo", "concordo", "confirmado",
      "sim, pode confirmar", "por favor, confirme", "eu confirmo",
      "afirma sim", "com certeza, confirma", "sem duvidas, confirmo",
      "estou de acordo, pode prosseguir", "confirmado, prossiga", "quero", "desejo", "desejo confirmar"
    ];
    confirmExamples.forEach(example => {
      this.nlpManager.addDocument('pt', this.normalizeText(example), 'confirmar');
    });

    const cancelExamples = [
      "não", "não quero", "cancela", "cancelado", "impossivel", "recuso",
      "negativo", "não concordo", "não aceita", "não posso confirmar",
      "não desejo", "cancela atendimento", "deixa pra lá", "nem pensar",
      "não vou", "cancelar", "não, cancele", "por favor, cancele",
      "não quero confirmar", "cancelar o atendimento", "não, obrigado",
      "não, recuso", "não, não concordo", "cancelado, por favor interrompa", "pare, não quero"
    ];
    cancelExamples.forEach(example => {
      this.nlpManager.addDocument('pt', this.normalizeText(example), 'cancelar');
    });

    // Exemplos para fallback (opcional)
    this.nlpManager.addDocument('pt', 'não entendi', 'fallback');
    this.nlpManager.addDocument('pt', 'pode repetir', 'fallback');

    this.logger.log('Treinando o modelo NLP...');
    await this.nlpManager.train();
    this.nlpManager.save();
    this.logger.log('Treinamento concluído.');
  }

  // Formata o número para o padrão do WhatsApp
  formatNumber(number: string): string {
    return number.replace('+', '') + '@c.us';
  }
  
  // Envia uma mensagem via WhatsApp e registra a confirmação no banco
  async sendMessage(to: string, message: string, appointmentId: number) {
    const formattedTo = this.formatNumber(to);
    // Armazena no banco
    const pending = this.pendingConfirmationRepo.create({
      id: uuidv4(),
      appointmentId,
      phone: formattedTo,
    });
    await this.pendingConfirmationRepo.save(pending);
    try {
      return await this.client.sendMessage(formattedTo, message);
    } catch (error) {
      this.logger.error('Erro ao enviar mensagem:', error);
      if (error.message.includes('Session closed')) {
        this.logger.warn('Tentando reinicializar o cliente...');
        this.initializeClient();
        this.client.initialize();
      }
    }
  }

  // Se você quiser um método separado para solicitar confirmação
  async requestConfirmation(to: string, message: string, appointmentId: string) {
    await this.sendMessage(to, message, +appointmentId);
  }
}
