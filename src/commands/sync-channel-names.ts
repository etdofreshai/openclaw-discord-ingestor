import 'dotenv/config';
import { loadSession } from '../lib/session.js';
import { validateToken } from '../lib/token-validator.js';

/**
 * Sync all guild/channel names to the Memory Database API.
 * Fetches all guilds the user is in, then all channels per guild,
 * and POSTs them in bulk to POST /api/discord/channels.
 */

async function main() {
  const baseUrl = (process.env.MEMORY_DATABASE_API_URL ?? '').replace(/\/+$/, '');
  const readToken = process.env.MEMORY_DATABASE_API_TOKEN ?? '';
  const writeToken = process.env.MEMORY_DATABASE_API_WRITE_TOKEN ?? readToken;

  if (!baseUrl || !writeToken) {
    console.error('MEMORY_DATABASE_API_URL and MEMORY_DATABASE_API_TOKEN (or WRITE_TOKEN) required.');
    process.exit(1);
  }

  const session = await loadSession();
  if (!session) {
    console.error('No saved Discord session. Log in first via login server.');
    process.exit(1);
  }

  const user = await validateToken(session);
  if (!user) {
    console.error('Token validation failed.');
    process.exit(1);
  }
  console.log(`Authenticated as ${user.username}#${user.discriminator}`);

  // Fetch all guilds
  const guildsRes = await fetch('https://discord.com/api/v10/users/@me/guilds', {
    headers: { Authorization: session.token },
  });
  if (!guildsRes.ok) {
    console.error(`Failed to fetch guilds: ${guildsRes.status}`);
    process.exit(1);
  }
  const guilds = await guildsRes.json() as Array<{ id: string; name: string }>;
  console.log(`Found ${guilds.length} guilds`);

  const allChannels: Array<{ channelId: string; channelName: string; guildId: string; guildName: string }> = [];

  for (const guild of guilds) {
    console.log(`Fetching channels for ${guild.name} (${guild.id})...`);
    try {
      const chRes = await fetch(`https://discord.com/api/v10/guilds/${guild.id}/channels`, {
        headers: { Authorization: session.token },
      });

      if (chRes.status === 429) {
        const retryAfter = parseFloat(chRes.headers.get('retry-after') ?? '5');
        console.warn(`Rate limited, waiting ${retryAfter}s...`);
        await new Promise(r => setTimeout(r, retryAfter * 1000 + 500));
        continue;
      }

      if (!chRes.ok) {
        console.warn(`Failed to fetch channels for ${guild.name}: ${chRes.status}`);
        continue;
      }

      const channels = await chRes.json() as Array<{ id: string; name: string; type: number }>;
      // Type 0 = text, 2 = voice, 5 = announcement, 15 = forum
      for (const ch of channels) {
        allChannels.push({
          channelId: ch.id,
          channelName: ch.name,
          guildId: guild.id,
          guildName: guild.name,
        });
      }
      console.log(`  → ${channels.length} channels`);
    } catch (err) {
      console.warn(`Error fetching channels for ${guild.name}:`, err);
    }

    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nPosting ${allChannels.length} channel mappings to API...`);

  // Batch in chunks of 50
  const BATCH_SIZE = 50;
  let totalUpserted = 0;
  for (let i = 0; i < allChannels.length; i += BATCH_SIZE) {
    const batch = allChannels.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(`${baseUrl}/api/discord/channels`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${writeToken}`,
        },
        body: JSON.stringify(batch),
      });
      if (res.ok) {
        const data = await res.json() as { upserted: number };
        totalUpserted += data.upserted;
      } else {
        console.warn(`Batch POST failed: ${res.status}`);
      }
    } catch (err) {
      console.warn('Batch POST error:', err);
    }
  }

  console.log(`✅ Done! Upserted ${totalUpserted} channel mappings.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
