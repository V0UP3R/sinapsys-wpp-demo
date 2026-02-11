import { proto, WAMessage, BaileysEventEmitter } from '@whiskeysockets/baileys';
import Redis from 'ioredis';
import { Logger } from '@nestjs/common';

export interface RedisStoreConfig {
  redis: Redis;
  logger?: Logger;
  ttl?: number; // seconds
  prefix?: string; // Optional prefix for keys
}

export const makeRedisStore = (config: RedisStoreConfig) => {
  const redis = config.redis;
  const logger = config.logger;
  const ttl = config.ttl || 43200; // 12h default
  const prefix = config.prefix || '';

  const getKey = (key: string) => `${prefix}${key}`;

  const buildJidCandidates = (jid?: string): string[] => {
    if (!jid) return [];

    const set = new Set<string>();
    const normalized = jid.replace('@s.whatsapp.net', '@c.us');
    set.add(jid);
    set.add(normalized);

    const user = normalized.split('@')[0];
    if (/^\d+$/.test(user)) {
      set.add(`${user}@c.us`);
      set.add(`${user}@s.whatsapp.net`);
      set.add(`${user}@lid`);
    }

    return Array.from(set);
  };

  const saveMessage = async (jid: string, message: WAMessage) => {
    const messageId = message?.key?.id;
    if (!messageId) return;

    try {
      const payload = JSON.stringify(message);

      // Indexa por JID (incluindo variações LID/PN) para facilitar retries.
      const jidCandidates = buildJidCandidates(jid);
      for (const candidate of jidCandidates) {
        const key = getKey(`msg:${candidate}:${messageId}`);
        await redis.set(key, payload, 'EX', ttl);
      }

      // Index global por ID como fallback quando o JID muda.
      await redis.set(getKey(`msgById:${messageId}`), payload, 'EX', ttl);
    } catch (error) {
      logger?.error(`Failed to save message to Redis: ${error.message}`);
    }
  };

  const loadMessage = async (
    jid: string | undefined,
    id: string | undefined,
    ...extraJids: Array<string | undefined>
  ): Promise<WAMessage | undefined> => {
    if (!id) return undefined;

    try {
      const candidateKeys = new Set<string>();

      for (const candidateJid of [jid, ...extraJids]) {
        for (const expanded of buildJidCandidates(candidateJid)) {
          candidateKeys.add(getKey(`msg:${expanded}:${id}`));
        }
      }

      // Fallback principal quando há mismatch de JID (ex.: @lid x @s.whatsapp.net).
      candidateKeys.add(getKey(`msgById:${id}`));

      for (const key of candidateKeys) {
        const data = await redis.get(key);
        if (!data) continue;
        return JSON.parse(data);
      }
    } catch (error) {
      logger?.error(`Failed to load message from Redis: ${error.message}`);
    }
    return undefined;
  };

  const saveGroupMetadata = async (jid: string, metadata: any) => {
    try {
      const key = getKey(`group:${jid}`);
      await redis.set(key, JSON.stringify(metadata), 'EX', ttl);
    } catch (error) {
      logger?.error(`Failed to save group metadata to Redis: ${error.message}`);
    }
  };

  const fetchGroupMetadata = async (jid: string): Promise<any | undefined> => {
    try {
      const key = getKey(`group:${jid}`);
      const data = await redis.get(key);
      if (data) {
        return JSON.parse(data);
      }
    } catch (error) {
      logger?.error(`Failed to load group metadata from Redis: ${error.message}`);
    }
    return undefined;
  };

  const bind = (ev: BaileysEventEmitter) => {
    ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        const jids = new Set<string>(
          [
            msg?.key?.remoteJid,
            (msg?.key as any)?.remoteJidAlt,
            msg?.key?.participant,
            (msg?.key as any)?.participantAlt,
          ].filter(Boolean) as string[],
        );

        for (const jid of jids) {
          await saveMessage(jid, msg);
        }
      }
    });

    // We can expand this to handle group updates if needed
  };

  return {
    bind,
    loadMessage,
    fetchGroupMetadata,
    saveGroupMetadata,
  };
};
