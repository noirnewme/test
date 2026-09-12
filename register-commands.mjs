const base=`https://discord.com/api/v10/applications/${process.env.DISCORD_APPLICATION_ID}/guilds/${process.env.DISCORD_GUILD_ID}/commands`;
const headers={'Authorization':`Bot ${process.env.DISCORD_BOT_TOKEN}`,'Content-Type':'application/json'};
const commands=[
 {name:'verify',description:'Verify a Roblox account and generate a redeem code.',options:[{name:'roblox-username',description:'Roblox username to verify.',type:3,required:true}]},
 {name:'account-create',description:'Create or update a website account for a Discord member.',default_member_permissions:String(0x8),options:[{name:'user',description:'Discord member.',type:6,required:true},{name:'email',description:'Email used for OTP login.',type:3,required:true}]}
];
const r=await fetch(base,{method:'PUT',headers,body:JSON.stringify(commands)});console.log(await r.text());if(!r.ok)process.exit(1);
