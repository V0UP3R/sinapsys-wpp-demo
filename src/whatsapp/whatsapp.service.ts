// src/whatsapp/whatsapp.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Client, LocalAuth } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import { NlpManager } from 'node-nlp';
import * as puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import path from 'path';

@Injectable()
export class WhatsappService implements OnModuleInit {
  private client: Client;
  private nlpManager: NlpManager;
  // Chats que aguardam confirmação
  private pendingConfirmations: Set<string> = new Set();
  private modelPath = process.env.NODE_ENV === 'production'
  ? '/tmp/model.nlp'
  : 'model.nlp';

  constructor() {
    // Inicializa o NLP Manager para o idioma português
    this.nlpManager = new NlpManager({ 
      languages: ['pt'] ,
      modelFileName: this.modelPath
    });
    if (process.env.NODE_ENV === 'production') {
      this.loadTrainedModel();
    } else {
      this.trainNlp();
    }
  }

  public static async trainModel() {
    // Crie uma nova instância explicitamente
    const serviceInstance = new WhatsappService();
    await serviceInstance.trainNlp();
  }

  private async loadTrainedModel() {
    const modelPath = process.env.NODE_ENV === 'production' 
      ? '/tmp/model.nlp' 
      : path.join(__dirname, 'model.nlp');
  
    try {
      await this.nlpManager.load(modelPath);
      console.log('Modelo NLP carregado com sucesso');
    } catch (error) {
      console.log('Modelo não encontrado, treinando novo...');
      await this.trainNlp();
    }
  }
  private async getBrowserConfig() {
    const isProduction = process.env.NODE_ENV === 'production';
    
    if (isProduction) {
      return {
        args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
        executablePath: await chromium.executablePath(),
        headless: true,
      };
    } else {
      return {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        executablePath: process.env.CHROME_PATH || require('puppeteer').executablePath(), // Caminho comum do Chrome no Windows
        headless: false // Melhor para debug local
      };
    }
  }

  async onModuleInit() {
    const browserConfig = await this.getBrowserConfig();

    this.client = new Client({
      puppeteer: browserConfig,
      authStrategy: new LocalAuth({
        dataPath: process.env.NODE_ENV === 'production' 
          ? '/tmp/.wwebjs_auth' 
          : path.join(__dirname, '../../.wwebjs_auth') // Caminho relativo para Windows
      })
    });

    this.client.on('qr', (qr) => {
      const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}&size=300x300`;
      console.log('Acesse o QR Code via o link:', qrCodeUrl);
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

    console.log('Treinando o modelo NLP...');
    await this.nlpManager.train();
    // Salvar apenas se não estiver em produção
    if (process.env.NODE_ENV !== 'production') {
      this.nlpManager.save('model.nlp');
    } else {
      // Na Vercel, salvar no diretório temporário
      const tmpPath = '/tmp/model.nlp';
      this.nlpManager.save(tmpPath);
      console.log(`Modelo salvo em ${tmpPath}`);
    }
    this.nlpManager.save();
    console.log('Treinamento concluído.');
  }

  // Formata o número para o padrão do WhatsApp
  formatNumber(number: string): string {
    return number.replace('+', '') + '@c.us';
  }
  
  // Envia uma mensagem via WhatsApp
  async sendMessage(to: string, message: string) {
    const formattedTo = this.formatNumber(to);
    return this.client.sendMessage(formattedTo, message);
  }

  // Envia uma solicitação de confirmação e registra o chat
  async requestConfirmation(to: string, message: string) {
    const formattedTo = this.formatNumber(to);
    await this.client.sendMessage(formattedTo, message);
    this.pendingConfirmations.add(formattedTo);
  }
}