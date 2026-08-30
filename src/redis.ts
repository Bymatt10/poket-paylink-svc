/**
 * Cliente Redis (ioredis) singleton.
 * Keys usadas:
 *   poket:session:state   → storageState de Playwright (JSON), con TTL
 *   poket:idem:<key>      → idempotencia (F4)
 */
import { Redis } from 'ioredis';
import { loadConfig } from './config';

export const REDIS_KEYS = {
  sessionState: 'poket:session:state',
  idem: (key: string) => `poket:idem:${key}`,
} as const;

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(loadConfig().REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
