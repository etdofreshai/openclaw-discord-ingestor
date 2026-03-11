import fs from 'node:fs/promises';
import path from 'node:path';
import { loadSession } from './session.js';

export interface ChannelInfo {
  channelName: string;
  guildId: string | null;
  guildName: string | null;
}

export interface ChannelCache {
  updatedAt: string;
  channels: Record<string, ChannelInfo>;
}

const CACHE_FILE = path.resolve(process.cwd(), '.data', 'channel-cache.json');
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

let memoryCache: ChannelCache | null = null;

async function readCacheFile(): Promise<ChannelCache | null> {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(raw) as ChannelCache;
  } catch {
    return null;
  }
}

async function writeCacheFile(cache: ChannelCache): Promise<void> {
  const dir = path.dirname(CACHE_FILE);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

async function refreshFromDiscord(): Promise<ChannelCache> {
  const session = await loadSession();
  if (!session) {
    console.warn('[channel-cache] No Discord session available, returning empty cache');
    return { updatedAt: new Date().toISOString(), channels: {} };
  }

  const channels: Record<string, ChannelInfo> = {};

  // Fetch all guilds
  const guildsRes = await fetch('https://discord.com/api/v10/users/@me/guilds', {
    headers: { Authorization: session.token },
  });

  if (!guildsRes.ok) {
    console.error(`[channel-cache] Failed to fetch guilds: ${guildsRes.status}`);
    return { updatedAt: new Date().toISOString(), channels: {} };
  }

  const guilds = (await guildsRes.json()) as Array<{ id: string; name: string }>;
  console.log(`[channel-cache] Refreshing ${guilds.length} guilds...`);

  for (const guild of guilds) {
    try {
      const chRes = await fetch(`https://discord.com/api/v10/guilds/${guild.id}/channels`, {
        headers: { Authorization: session.token },
      });

      if (chRes.status === 429) {
        const retryAfter = parseFloat(chRes.headers.get('retry-after') ?? '5');
        console.warn(`[channel-cache] Rate limited, waiting ${retryAfter}s...`);
        await new Promise((r) => setTimeout(r, retryAfter * 1000 + 500));
        // Retry this guild
        const retryRes = await fetch(`https://discord.com/api/v10/guilds/${guild.id}/channels`, {
          headers: { Authorization: session.token },
        });
        if (retryRes.ok) {
          const chs = (await retryRes.json()) as Array<{ id: string; name: string }>;
          for (const ch of chs) {
            channels[ch.id] = { channelName: ch.name, guildId: guild.id, guildName: guild.name };
          }
        }
        continue;
      }

      if (!chRes.ok) {
        console.warn(`[channel-cache] Failed for guild ${guild.name}: ${chRes.status}`);
        continue;
      }

      const chs = (await chRes.json()) as Array<{ id: string; name: string }>;
      for (const ch of chs) {
        channels[ch.id] = { channelName: ch.name, guildId: guild.id, guildName: guild.name };
      }
    } catch (err) {
      console.warn(`[channel-cache] Error for guild ${guild.name}:`, err);
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  const cache: ChannelCache = { updatedAt: new Date().toISOString(), channels };
  await writeCacheFile(cache);
  memoryCache = cache;
  console.log(`[channel-cache] Cached ${Object.keys(channels).length} channels`);
  return cache;
}

export async function getChannels(): Promise<Record<string, ChannelInfo>> {
  // Check memory cache first
  if (memoryCache && Date.now() - new Date(memoryCache.updatedAt).getTime() < MAX_AGE_MS) {
    return memoryCache.channels;
  }

  // Check file cache
  const fileCache = await readCacheFile();
  if (fileCache && Date.now() - new Date(fileCache.updatedAt).getTime() < MAX_AGE_MS) {
    memoryCache = fileCache;
    return fileCache.channels;
  }

  // Refresh from Discord API
  const fresh = await refreshFromDiscord();
  return fresh.channels;
}
