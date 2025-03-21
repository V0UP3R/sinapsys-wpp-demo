import { Injectable, OnModuleInit } from '@nestjs/common';
import { Client, LocalAuth } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import { NlpManager } from 'node-nlp';
import chromium from 'chrome-aws-lambda';

@Injectable()
export class WhatsappService implements OnModuleInit {
  private client: Client;
  private nlpManager: NlpManager;
  // Chats que aguardam confirmação
  private pendingConfirmations: Set<string> = new Set();

  constructor() {
    // Inicializa o NLP Manager para o idioma português
    this.nlpManager = new NlpManager({ languages: ['pt'] });
  }

  async onModuleInit() {
    // Tenta carregar o modelo a partir do caminho gravável (/tmp/model.nlp)
    try {
      await this.nlpManager.load('/tmp/model.nlp');
      console.log('Modelo carregado a partir de /tmp/model.nlp');
    } catch (error) {
      console.log('Modelo não encontrado. Treinando o modelo...');
      await this.trainNlp();
    }

    // Obtém o caminho executável do Chromium provido pelo chrome-aws-lambda
    const executablePath = await chromium.executablePath;

    // Inicializa o cliente do WhatsApp com autenticação local e as configurações do chrome-aws-lambda
    this.client = new Client({
      authStrategy: new LocalAuth({
        clientId: 'default', // ou outro identificador que desejar
        dataPath: '/tmp/whatsapp-session', // caminho para armazenar os dados da sessão
      }),
      puppeteer: {
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath, // Caminho para o Chromium
        headless: chromium.headless,
      },
    });

    this.client.on('qr', (qr) => {
      const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(
        qr,
      )}&size=300x300`;
      console.log('Acesse o QR Code via o link:', qrCodeUrl);
      // Também exibe o QR no terminal:
      qrcode.generate(qr, { small: true });
    });

    this.client.on('ready', () => {
      console.log('Cliente do WhatsApp pronto!');
    });

    // Processa mensagens somente se o chat estiver aguardando confirmação
    this.client.on('message', async (message) => {
      console.log('Mensagem recebida:', message.body);

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
        console.log('Resposta não foi suficientemente clara. Nenhuma ação tomada.');
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

    console.log('Treinando o modelo NLP...');
    await this.nlpManager.train();

    // Salva o modelo no diretório gravável (/tmp)
    await this.nlpManager.save('/tmp/model.nlp');
    console.log('Treinamento concluído.');
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