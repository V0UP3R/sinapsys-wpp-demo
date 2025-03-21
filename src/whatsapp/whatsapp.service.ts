import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Client, LocalAuth } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import { NlpManager } from 'node-nlp';
import chromium from 'chrome-aws-lambda';
import * as path from 'path';
import * as fs from 'fs';
@Injectable()
export class WhatsappService implements OnModuleInit {
  private client: Client;
  private nlpManager: NlpManager;
  // Chats que aguardam confirmação
  private pendingConfirmations: Set<string> = new Set();
  private logger = new Logger(WhatsappService.name);
  private readonly modelPath = '/tmp/model.nlp'; // Caminho explícito

  constructor() {
    // Inicializa o NLP Manager para o idioma português
    this.nlpManager = new NlpManager({ 
      languages: ['pt'], 
      autoSave: false,       // Desativa autosave
      autoLoad: false,       // Desativa autoload
      modelFileName: this.modelPath
    });
    // this.trainNlp();
  }

  async onModuleInit() {

    if (!fs.existsSync('/tmp')) {
      fs.mkdirSync('/tmp');
    }

    try {
      // Carrega usando o caminho explícito
      if (fs.existsSync(this.modelPath)) {
        await this.nlpManager.load(this.modelPath);
      } else {
        throw new Error('Modelo não encontrado');
      }
    } catch (error) {
      await this.trainNlp();
      await this.nlpManager.save(this.modelPath);
    }

    // Obtém o caminho executável do Chromium provido pelo chrome-aws-lambda
    const executablePath = await chromium.executablePath;

    // Inicializa o cliente do WhatsApp com autenticação local e as configurações do chrome-aws-lambda
    this.client = new Client({
      authStrategy: new LocalAuth({ 
        clientId: 'default',
        // dataPath: '/tmp/whatsapp-session'
      }),
      puppeteer: {
        args: [
          ...chromium.args,
          '--disable-gpu',
          '--no-sandbox',
          '--single-process',
          '--no-zygote'
        ],
        executablePath: await chromium.executablePath,
        headless: chromium.headless,
        userDataDir: '/tmp/chromium' // Diretório gravável
      }
    });

    this.client.on('qr', (qr) => {
      const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(
        qr,
      )}&size=300x300`;
      this.logger.log('Acesse o QR Code via o link:', qrCodeUrl);
      // Também exibe o QR no terminal:
      qrcode.generate(qr, { small: true });
    });

    this.client.on('ready', () => {
      this.logger.log('Cliente do WhatsApp pronto!');
    });

    // Processa mensagens somente se o chat estiver aguardando confirmação
    this.client.on('message', async (message) => {
      this.logger.log('Mensagem recebida:', message.body);

      if (!this.pendingConfirmations.has(message.from)) {
        return;
      }

      // Pré-processa o texto (normaliza: minúsculas, remove acentos, etc.)
      const normalizedText = this.normalizeText(message.body);
      const response = await this.nlpManager.process('pt', normalizedText);

      // Ajuste o threshold de confiança conforme necessário (exemplo: 0.8)
      if (response.intent === 'confirmar' && response.score > 0.8) {
        await this.client.sendMessage(message.from, 'Ação confirmada!');
        this.pendingConfirmations.delete(message.from);
      } else if (response.intent === 'cancelar' && response.score > 0.8) {
        await this.client.sendMessage(message.from, 'Ação cancelada!');
        this.pendingConfirmations.delete(message.from);
      } else {
        this.logger.error('Resposta não foi suficientemente clara. Nenhuma ação tomada.');
      }
    });

    // Inicializa o cliente do WhatsApp
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
    // Exemplos para intenção de confirmação
    const confirmExamples = [
      "sim",
      "confirmo",
      "está ok",
      "ok",
      "certo",
      "claro",
      "afirmativo",
      "estou de acordo",
      "com certeza",
      "acordo",
      "isso mesmo",
      "vou confirmar",
      "confirmar atendimento",
      "tudo certo",
      "concordo",
      "confirmado",
      "sim, pode confirmar",
      "por favor, confirme",
      "eu confirmo",
      "afirma sim",
      "com certeza, confirma",
      "sem duvidas, confirmo",
      "estou de acordo, pode prosseguir",
      "confirmado, prossiga",
      "Quero",
      "Desejo",
      "Desejo confirmar",
    ];
    confirmExamples.forEach((example) => {
      this.nlpManager.addDocument('pt', this.normalizeText(example), 'confirmar');
    });

    // Exemplos para intenção de cancelamento
    const cancelExamples = [
      "não",
      "não quero",
      "cancela",
      "cancelado",
      "impossivel",
      "recuso",
      "negativo",
      "não concordo",
      "não aceita",
      "não posso confirmar",
      "não desejo",
      "cancela atendimento",
      "deixa pra la",
      "nem pensar",
      "não vou",
      "cancelar",
      "não, cancele",
      "por favor, cancele",
      "não quero confirmar",
      "cancelar o atendimento",
      "não, obrigado",
      "não, recuso",
      "não, não concordo",
      "cancelado, por favor interrompa",
      "pare, não quero",
    ];
    cancelExamples.forEach((example) => {
      this.nlpManager.addDocument('pt', this.normalizeText(example), 'cancelar');
    });

    // Exemplos para fallback (opcional)
    this.nlpManager.addDocument('pt', 'não entendi', 'fallback');
    this.nlpManager.addDocument('pt', 'pode repetir', 'fallback');

    this.logger.log('Treinando o modelo NLP...');
    await this.nlpManager.train();

    // Salva o modelo no diretório gravável (/tmp)
    await this.nlpManager.save(this.modelPath);
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
    return this.client.sendMessage(formattedTo, message);
  }

  // Envia uma solicitação de confirmação e registra o chat
  async requestConfirmation(to: string, message: string) {
    const formattedTo = this.formatNumber(to);
    await this.client.sendMessage(formattedTo, message);
    this.pendingConfirmations.add(formattedTo);
  }
}