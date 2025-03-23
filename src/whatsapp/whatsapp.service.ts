import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Client, LocalAuth } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import { NlpManager } from 'node-nlp';
import puppeteer from 'puppeteer';
@Injectable()
export class WhatsappService implements OnModuleInit {
  private client: Client;
  private nlpManager: NlpManager;
  // Chats que aguardam confirmação
  private pendingConfirmations: Set<string> = new Set();
  private readonly logger = new Logger(WhatsappService.name);

  constructor() {
    // Inicializa o NLP Manager para o idioma português
    this.nlpManager = new NlpManager({ languages: ['pt'] });
    this.trainNlp();
    // Inicializa o cliente do WhatsApp com autenticação local
    this.initializeClient();
  }

  private async initializeClient() {
    const chrome = puppeteer.executablePath()
    const dataPath = '../whatsapp-session'

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
        executablePath: chrome, // Caminho do Chromium embutido
      },
      authStrategy: new LocalAuth({dataPath}),
    });
  }

  async onModuleInit() {  
    this.client.on('qr', (qr) => {
      // qrcode.generate(qr, { small: true });
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
  
    // Processa mensagens somente se o chat estiver aguardando confirmação
    this.client.on('message', async (message) => {
      this.logger.log('Mensagem recebida:', message.body);
      
      if (!this.pendingConfirmations.has(message.from)) {
        return;
      }
      
      const normalizedText = this.normalizeText(message.body);
      const response = await this.nlpManager.process('pt', normalizedText);
  
      if (response.intent === 'confirmar' && response.score > 0.8) {
        await this.client.sendMessage(message.from, 'Ação confirmada!');
        this.pendingConfirmations.delete(message.from);
      } else if (response.intent === 'cancelar' && response.score > 0.8) {
        await this.client.sendMessage(message.from, 'Ação cancelada!');
        this.pendingConfirmations.delete(message.from);
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

  // Treinamento robusto do NLP com muitos exemplos para confirmar ou cancelar
  private async trainNlp() {
    // Exemplos para intenção de confirmação
    const confirmExamples = [
      "sim", "confirmo", "está ok", "ok", "certo", "claro", "afirmativo",
      "estou de acordo", "com certeza", "acordo", "isso mesmo", "vou confirmar",
      "confirmar atendimento", "tudo certo", "concordo", "confirmado",
      "sim, pode confirmar", "por favor, confirme", "eu confirmo",
      "afirma sim", "com certeza, confirma", "sem duvidas, confirmo",
      "estou de acordo, pode prosseguir", "confirmado, prossiga", "Quero", "Desejo", "Desejo confirmar"
    ];
    confirmExamples.forEach(example => {
      this.nlpManager.addDocument('pt', this.normalizeText(example), 'confirmar');
    });

    // Exemplos para intenção de cancelamento
    const cancelExamples = [
      "não", "não quero", "cancela", "cancelado", "impossivel", "recuso",
      "negativo", "não concordo", "não aceita", "não posso confirmar",
      "não desejo", "cancela atendimento", "deixa pra la", "nem pensar",
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
  
  // Envia uma mensagem via WhatsApp
  async sendMessage(to: string, message: string) {
    const formattedTo = this.formatNumber(to);
    this.pendingConfirmations.add(formattedTo);
    try {
      return await this.client.sendMessage(formattedTo, message);
    } catch (error) {
      this.logger.error('Erro ao enviar mensagem:', error);
      // Se o erro indicar que a sessão foi fechada, reinicialize o cliente
      if (error.message.includes('Session closed')) {
        this.logger.warn('Tentando reinicializar o cliente...');
        this.initializeClient();
        this.client.initialize();
      }
    }
  }

  // Envia uma solicitação de confirmação e registra o chat
  async requestConfirmation(to: string, message: string) {
    const formattedTo = this.formatNumber(to);
    await this.client.sendMessage(formattedTo, message);
    this.pendingConfirmations.add(formattedTo);
  }
}