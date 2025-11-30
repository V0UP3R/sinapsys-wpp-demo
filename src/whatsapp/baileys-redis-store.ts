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

  const saveMessage = async (jid: string, message: WAMessage) => {
    try {
      const key = getKey(`msg:${jid}:${message.key.id}`);
      // Use set with EX (expiration) to handle TTL
      await redis.set(key, JSON.stringify(message), 'EX', ttl);
    } catch (error) {
      logger?.error(`Failed to save message to Redis: ${error.message}`);
    }
  };

  const loadMessage = async (jid: string, id: string): Promise<WAMessage | undefined> => {
    try {
      const key = getKey(`msg:${jid}:${id}`);
      const data = await redis.get(key);
      if (data) {
        // Parse the JSON string back to WAMessage
        // Note: Protobuf messages might lose some prototype methods but data should be there
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
        const jid = msg.key.remoteJid;
        if (jid) {
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
