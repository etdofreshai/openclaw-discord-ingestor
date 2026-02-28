import fs from 'node:fs/promises';
import path from 'node:path';

export interface DiscordSession {
  token: string;
  userId?: string;
  username?: string;
  capturedAt: string;
}

const SESSION_FILE = path.resolve(process.cwd(), '.chrome-profile', 'discord-session.json');

export async function loadSession(): Promise<DiscordSession | null> {
  try {
    const raw = await fs.readFile(SESSION_FILE, 'utf8');
    const session = JSON.parse(raw) as DiscordSession;
    if (!session.token) return null;
    return session;
  } catch {
    return null;
  }
}

export async function saveSession(session: DiscordSession): Promise<void> {
  const dir = path.dirname(SESSION_FILE);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(SESSION_FILE, JSON.stringify(session, null, 2), 'utf8');
}

export async function clearSession(): Promise<void> {
  try {
    await fs.unlink(SESSION_FILE);
  } catch {}
}
