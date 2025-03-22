// src/whatsapp/whatsapp.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Client, LocalAuth } from 'whatsapp-web.js';
import { NlpManager } from 'node-nlp';
import * as puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import * as path from 'path';
import { existsSync, mkdirSync } from 'fs';

@Injectable()
export class WhatsappService implements OnModuleInit {
  private client: Client;
  private nlpManager: NlpManager;
  private pendingConfirmations: Set<string> = new Set();
  private modelPath: string;
  private authPath: string;

  constructor() {
    // Configura caminhos dinâmicos
    this.modelPath = process.env.NODE_ENV === 'production'
      ? '/tmp/model.nlp'
      : path.join(process.cwd(), 'model.nlp');

    this.authPath = process.env.NODE_ENV === 'production'
      ? '/tmp/.wwebjs_auth'
      : path.join(process.cwd(), '.wwebjs_auth');

    // Garante a criação dos diretórios
    this.createDirectories();

    // Inicializa NLP
    this.nlpManager = new NlpManager({ 
      languages: ['pt'],
      modelFileName: this.modelPath
    });

    // Carrega ou treina o modelo
    process.env.NODE_ENV === 'production' 
      ? this.loadTrainedModel() 
      : this.trainNlp();
  }

  private createDirectories() {
    // Cria diretório para autenticação
    if (!existsSync(this.authPath)) {
      mkdirSync(this.authPath, { recursive: true });
    }

    // Cria diretório para modelos NLP
    const modelDir = path.dirname(this.modelPath);
    if (!existsSync(modelDir)) {
      mkdirSync(modelDir, { recursive: true });
    }
  }

  public static async trainModel() {
    const service = new WhatsappService();
    await service.trainNlp();
  }

  private async loadTrainedModel() {
    try {
      await this.nlpManager.load(this.modelPath);
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
    }

    return {
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: process.env.CHROME_PATH || puppeteer.executablePath('chrome'),
      headless: false
    };
  }

  async onModuleInit() {
    const browserConfig = await this.getBrowserConfig();

    this.client = new Client({
      puppeteer: browserConfig,
      authStrategy: new LocalAuth({
        dataPath: this.authPath
      })
    });

    this.setupEventHandlers();
    await this.client.initialize();
  }

  private setupEventHandlers() {
    this.client.on('qr', (qr) => {
      const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}&size=300x300`;
      console.log('QR Code URL:', qrCodeUrl);
    });

    this.client.on('ready', () => {
      console.log('Cliente do WhatsApp pronto!');
    });

    this.client.on('message', async (message) => {
      console.log('Mensagem recebida:', message.body);
      
      if (!this.pendingConfirmations.has(message.from)) return;

      const response = await this.processMessage(message.body);
      await this.handleConfirmation(response, message.from);
    });
  }

  private async processMessage(text: string) {
    const normalizedText = this.normalizeText(text);
    return this.nlpManager.process('pt', normalizedText);
  }

  private async handleConfirmation(response: any, from: string) {
    if (response.intent === 'confirmar' && response.score > 0.8) {
      await this.client.sendMessage(from, 'Ação confirmada!');
      this.pendingConfirmations.delete(from);
    } else if (response.intent === 'cancelar' && response.score > 0.8) {
      await this.client.sendMessage(from, 'Ação cancelada!');
      this.pendingConfirmations.delete(from);
    } else {
      console.log('Resposta não reconhecida');
    }
  }

  private normalizeText(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
  }

  private async trainNlp() {
    // Exemplos de treinamento
    const confirmExamples = [
      "sim", "confirmo", "está ok", "ok", "certo", "claro", "afirmativo",
      "estou de acordo", "com certeza", "acordo", "isso mesmo", "vou confirmar",
      "confirmar atendimento", "tudo certo", "concordo", "confirmado",
      "sim, pode confirmar", "por favor, confirme", "eu confirmo",
      "afirma sim", "com certeza, confirma", "sem duvidas, confirmo",
      "estou de acordo, pode prosseguir", "confirmado, prossiga", "Quero", "Desejo", "Desejo confirmar"
    ];

    const cancelExamples = [
      "não", "não quero", "cancela", "cancelado", "impossivel", "recuso",
      "negativo", "não concordo", "não aceita", "não posso confirmar",
      "não desejo", "cancela atendimento", "deixa pra la", "nem pensar",
      "não vou", "cancelar", "não, cancele", "por favor, cancele",
      "não quero confirmar", "cancelar o atendimento", "não, obrigado",
      "não, recuso", "não, não concordo", "cancelado, por favor interrompa", "pare, não quero"
    ];

    // Adiciona exemplos
    confirmExamples.forEach(ex => 
      this.nlpManager.addDocument('pt', this.normalizeText(ex), 'confirmar'));
    
    cancelExamples.forEach(ex => 
      this.nlpManager.addDocument('pt', this.normalizeText(ex), 'cancelar'));

    // Treina e salva o modelo
    console.log('Iniciando treinamento NLP...');
    await this.nlpManager.train();
    await this.nlpManager.save(this.modelPath);
    console.log('Modelo treinado e salvo em:', this.modelPath);
  }

  formatNumber(number: string): string {
    return number.replace('+', '') + '@c.us';
  }

  async sendMessage(to: string, message: string) {
    const formattedTo = this.formatNumber(to);
    return this.client.sendMessage(formattedTo, message);
  }

  async requestConfirmation(to: string, message: string) {
    const formattedTo = this.formatNumber(to);
    await this.client.sendMessage(formattedTo, message);
    this.pendingConfirmations.add(formattedTo);
  }
}