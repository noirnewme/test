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

async function discord(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bot ${process.env.DISCORD_BOT_TOKEN}`);
  headers.set('Content-Type', 'application/json');
  return fetch(apiBase + path, { ...init, headers });
}

async function resolveRobloxUsername(username) {
  const r = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false })
  });
  if (!r.ok) throw new Error(`Roblox API returned ${r.status}`);
  const data = await r.json();
  return data.data?.[0] || null;
}

async function getGuildMember(userId) {
  const r = await discord(`/guilds/${process.env.DISCORD_GUILD_ID}/members/${userId}`);
  if (!r.ok) return null;
  return r.json();
}

async function isAdmin(userId) {
  const m = await getGuildMember(userId);
  return !!m?.roles?.includes(process.env.DISCORD_ADMIN_ROLE_ID);
}

async function handleVerify(interaction) {
  const username = interaction.options.getString('roblox-username', true);
  const rb = await resolveRobloxUsername(username);
  if (!rb) return `Roblox user **${username}** was not found.`;

  const a = await pool.query('SELECT id FROM accounts WHERE discord_user_id=$1 AND disabled_at IS NULL', [interaction.user.id]);
  if (!a.rowCount) return 'You do not have a website account yet. Ask an authorized admin to create one for you with `/account-create`.';

  await pool.query(`INSERT INTO roblox_verifications(account_id,discord_user_id,roblox_user_id,roblox_username)
    VALUES($1,$2,$3,$4)
    ON CONFLICT(account_id) DO UPDATE SET discord_user_id=excluded.discord_user_id,roblox_user_id=excluded.roblox_user_id,roblox_username=excluded.roblox_username,verified_at=now()`,
    [a.rows[0].id, interaction.user.id, rb.id, rb.name]);

  await pool.query('UPDATE redeem_codes SET expires_at=now() WHERE discord_user_id=$1 AND redeemed_at IS NULL', [interaction.user.id]);
  const code = randomCode(10);
  const rewards = process.env.DEFAULT_CODE_REWARDS ? JSON.parse(process.env.DEFAULT_CODE_REWARDS) : [{ Type: 'Currency', Name: 'Cash', Currency: 'Cash', Amount: 1000 }];
  const ttl = Number(process.env.CODE_TTL_SECONDS || 86400);
  await pool.query(`INSERT INTO redeem_codes(code,discord_user_id,roblox_user_id,rewards,expires_at)
    VALUES($1,$2,$3,$4,now()+make_interval(secs=>$5))`,
    [code, interaction.user.id, rb.id, JSON.stringify(rewards), ttl]);

  const member = await getGuildMember(interaction.user.id);
  const globalName = member?.user?.global_name || member?.user?.username || interaction.user.username;
  let nicknameWarning = '';
  try {
    await interaction.guild.members.edit(interaction.user.id, { nick: `${rb.name} ${globalName}`.slice(0, 32) });
  } catch (e) {
    console.error('Nickname update failed:', e);
    nicknameWarning = '\n\n⚠️ The code was created, but I could not change your nickname. Check the bot role hierarchy and Manage Nicknames permission.';
  }

  await pool.query('INSERT INTO audit_logs(actor_type,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5)',
    ['discord', interaction.user.id, 'verify', String(rb.id), JSON.stringify({ robloxUsername: rb.name, gateway: true })]);

  const hours = Math.round(ttl / 3600);
  return `✅ Verified **${rb.name}**.\nYour new redeem code is:\n**${code}**\nIt expires in ${hours === 24 ? '24 hours' : `${hours} hours`}. Redeem it in-game.${nicknameWarning}`;
}

async function handleAccountCreate(interaction) {
  if (!(await isAdmin(interaction.user.id))) return '❌ You need the configured admin role to use this command.';
  const target = interaction.options.getUser('user', true);
  const email = interaction.options.getString('email', true).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'Invalid email.';
  const member = await getGuildMember(target.id);
  if (!member) return 'That Discord member is not in the configured guild.';
  await pool.query(`INSERT INTO accounts(discord_user_id,discord_username,email,created_by_discord_user_id)
    VALUES($1,$2,$3,$4)
    ON CONFLICT(discord_user_id) DO UPDATE SET discord_username=excluded.discord_username,email=excluded.email,disabled_at=NULL`,
    [target.id, member.user.username, email, interaction.user.id]);
  await pool.query('INSERT INTO audit_logs(actor_type,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5)',
    ['discord', interaction.user.id, 'account-create', target.id, JSON.stringify({ email, gateway: true })]);
  return `✅ Website account created for <@${target.id}> with **${email}**.`;
}

const commands = [
  { name: 'verify', description: 'Verify a Roblox account and generate a redeem code.', options: [{ name: 'roblox-username', description: 'Roblox username to verify.', type: 3, required: true }] },
  { name: 'account-create', description: 'Create or update a website account for a Discord member.', default_member_permissions: String(0x8), options: [{ name: 'user', description: 'Discord member.', type: 6, required: true }, { name: 'email', description: 'Email used for OTP login.', type: 3, required: true }] }
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
