const API = 'https://discord.com/api/v10';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.authUrl = (state) =>
  `https://discord.com/oauth2/authorize?${new URLSearchParams({
    client_id: process.env.CLIENT_ID,
    redirect_uri: process.env.REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds.join',
    state,
    prompt: 'consent',
  })}`;

async function token(params) {
  const r = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
      ...params,
    }),
  });
  if (!r.ok) throw new Error(`OAuth token error ${r.status}`);
  return r.json();
}

exports.exchangeCode = (code) =>
  token({ grant_type: 'authorization_code', code, redirect_uri: process.env.REDIRECT_URI });

exports.refresh = (refreshToken) =>
  token({ grant_type: 'refresh_token', refresh_token: refreshToken });

exports.getUser = async (accessToken) => {
  const r = await fetch(`${API}/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`users/@me error ${r.status}`);
  return r.json();
};

// Retourne 'added' | 'already' | 'failed'
exports.addMember = async (guildId, userId, accessToken, retries = 3) => {
  const r = await fetch(`${API}/guilds/${guildId}/members/${userId}`, {
    method: 'PUT',
    headers: { Authorization: `Bot ${process.env.BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: accessToken }),
  });
  if (r.status === 201) return 'added';
  if (r.status === 204) return 'already';
  if (r.status === 429 && retries > 0) {
    const { retry_after = 1 } = await r.json().catch(() => ({}));
    await sleep(retry_after * 1000 + 250);
    return exports.addMember(guildId, userId, accessToken, retries - 1);
  }
  return 'failed';
};
