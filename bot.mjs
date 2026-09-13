import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import crypto from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const apiBase = 'https://discord.com/api/v10';

function randomCode(length = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${derivedHash}`;
}

async function discord(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bot ${process.env.DISCORD_BOT_TOKEN}`);
  headers.set('Content-Type', 'application/json');
  return fetch(apiBase + path, { ...init, headers });
}

async function getGuildMember(userId) {
  const r = await discord(`/guilds/${process.env.DISCORD_GUILD_ID}/members/${userId}`);
  if (!r.ok) return null;
  return r.json();
}

async function handleVerify(interaction) {
  const username = interaction.options.getString('roblox-username', true).trim();
  const appUrl = String(process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '');
  const internalSecret = process.env.DISCORD_BOT_INTERNAL_SECRET;
  const memberRoleId = process.env.DISCORD_MEMBER_ROLE_ID;

  if (!appUrl) throw new Error('NEXT_PUBLIC_APP_URL is required for /verify.');
  if (!internalSecret) throw new Error('DISCORD_BOT_INTERNAL_SECRET is required for /verify.');
  if (!memberRoleId) throw new Error('DISCORD_MEMBER_ROLE_ID is required for /verify.');

  const globalName = interaction.user.globalName || interaction.user.username;
  const response = await fetch(`${appUrl}/api/discord/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${internalSecret}`,
    },
    body: JSON.stringify({
      discordUserId: interaction.user.id,
      discordUsername: interaction.user.username,
      globalName,
      robloxUsername: username,
    }),
  });

  let data;
  try {
    data = await response.json();
  } catch {
    data = { error: `Vercel returned HTTP ${response.status}.` };
  }

  if (!response.ok) return data?.error || `Verification failed (HTTP ${response.status}).`;

  let roleWarning = '';
  try {
    await interaction.guild.members.addRole(interaction.user.id, memberRoleId, 'Roblox /verify completed');
  } catch (e) {
    console.error('Member role update failed:', e);
    roleWarning = '\n\n⚠️ Verification succeeded, but I could not add the Member role. Check Manage Roles and make sure the bot role is above the Member role.';
  }

  let nicknameWarning = '';
  try {
    await interaction.guild.members.edit(interaction.user.id, {
      nick: `${data.roblox.name} ${globalName}`.slice(0, 32),
      reason: 'Roblox /verify completed',
    });
  } catch (e) {
    console.error('Nickname update failed:', e);
    nicknameWarning = '\n⚠️ I could not change your nickname. Check Manage Nicknames and the bot role hierarchy.';
  }

  try {
    await interaction.user.send(
      `✅ Roblox verification completed.\n\n` +
      `Roblox: **${data.roblox.name}**\n` +
      `Roblox User ID: **${data.roblox.id}**\n` +
      `Verification code: **${data.code}**\n` +
      `Expires in: **24 hours**\n\n` +
      `Use this code in-game to complete the Roblox verification.`
    );
  } catch (e) {
    console.error('Verification DM failed:', e);
    return `✅ Verified **${data.roblox.name}** and the Member role was processed, but I could not DM you the verification code. Please enable DMs from server members and run /verify again.${roleWarning}${nicknameWarning}`;
  }

  return `✅ Verified **${data.roblox.name}**. I sent your verification code to your Discord DM.${roleWarning}${nicknameWarning}`;
}

async function handleAccountCreate(interaction) {
  const targetUser = interaction.options.getUser('user', true);
  const email = interaction.options.getString('email', true).trim().toLowerCase();
  const password = interaction.options.getString('password', true);

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return '❌ Invalid email format.';

  const passwordHash = hashPassword(password);
  const staffDiscordId = interaction.user.id;
  const targetDiscordId = targetUser.id;
  const targetDiscordUsername = targetUser.globalName || targetUser.username;

  try {
    await pool.query(
      `INSERT INTO accounts(discord_user_id, discord_username, email, password_hash, created_by_discord_user_id)
       VALUES($1, $2, $3, $4, $5)
       ON CONFLICT(discord_user_id) DO UPDATE SET
         discord_username = excluded.discord_username,
         email = excluded.email,
         password_hash = excluded.password_hash,
         disabled_at = NULL`,
      [targetDiscordId, targetDiscordUsername, email, passwordHash, staffDiscordId]
    );
  } catch (e) {
    if (e && e.code === '23505' && String(e.constraint).includes('email')) {
      return `❌ The email **${email}** is already used by a different account.`;
    }
    throw e;
  }

  await pool.query(
    'INSERT INTO audit_logs(actor_type, actor_id, action, target_id, metadata) VALUES($1, $2, $3, $4, $5)',
    ['discord', staffDiscordId, 'account-create', targetDiscordId, JSON.stringify({ email, targetDiscordId })]
  );

  try {
    await targetUser.send(
      `✅ **Website Account Created**\n\n` +
      `**Email:** ${email}\n` +
      `**Password:** ${password}\n\n` +
      `Keep these credentials secure. You can now use them to log into the /admin panel.`
    );
  } catch (e) {
    console.error('Account creation DM failed:', e);
    return `✅ Account created for **${targetDiscordUsername}** (${email}), but I could not DM them the credentials. Please check that they allow DMs from server members.`;
  }

  return `✅ Account created successfully for **${targetDiscordUsername}**. I have sent the login credentials to their Discord Direct Messages.`;
}

const commands = [
  { 
    name: 'verify', 
    description: 'Verify a Roblox account and generate a redeem code.', 
    options: [{ name: 'roblox-username', description: 'Roblox username to verify.', type: 3, required: true }] 
  },
  { 
    name: 'account-create', 
    description: 'Create a website account for a member (Admin Only). Credentials are sent to their DM.', 
    default_member_permissions: String(0x8), 
    options: [
      { name: 'user', description: 'The Discord member this account is for.', type: 6, required: true },
      { name: 'email', description: 'Account email address.', type: 3, required: true },
      { name: 'password', description: 'Account password.', type: 3, required: true }
    ] 
  }
];

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`Discord Gateway bot online as ${client.user.tag}`);
  client.user.setPresence({ status: 'online', activities: [{ name: 'Roblox Control Suite', type: 0 }] });
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_APPLICATION_ID, process.env.DISCORD_GUILD_ID), { body: commands });
  console.log('Guild slash commands registered.');
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName !== 'verify' && interaction.commandName !== 'account-create') return;
    await interaction.deferReply({ ephemeral: true });
    const content = interaction.commandName === 'verify' ? await handleVerify(interaction) : await handleAccountCreate(interaction);
    await interaction.editReply(content);
  } catch (e) {
    console.error('Interaction failed:', e);
    const msg = `❌ Operation failed: ${e instanceof Error ? e.message : 'Unknown error'}`;
    if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
    else await interaction.reply({ content: msg, ephemeral: true });
  }
});

process.on('SIGINT', async () => { await pool.end(); client.destroy(); process.exit(0); });
process.on('SIGTERM', async () => { await pool.end(); client.destroy(); process.exit(0); });

if (!process.env.DISCORD_BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN is required');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
client.login(process.env.DISCORD_BOT_TOKEN);