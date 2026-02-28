import type { DiscordSession } from './session.js';

export interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
  global_name?: string;
  avatar?: string;
}

export async function validateToken(session: DiscordSession): Promise<DiscordUser | null> {
  try {
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      headers: {
        Authorization: session.token,
      },
    });

    if (!res.ok) {
      console.error(`[token-validator] Token validation failed: ${res.status} ${res.statusText}`);
      return null;
    }

    const user = (await res.json()) as DiscordUser;
    return user;
  } catch (err) {
    console.error('[token-validator] Validation error:', err);
    return null;
  }
}
