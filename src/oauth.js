const API = 'https://discord.com/api/v10';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.authUrl = (app, state, { scope = 'identify guilds.join', redirect = process.env.REDIRECT_URI } = {}) =>
  `https://discord.com/oauth2/authorize?${new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope,
    state,
    prompt: 'consent',
  })}`;

async function token(app, params) {
  const r = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...params }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw Object.assign(new Error(`OAuth token error ${r.status}`), { status: r.status, code: body.error });
  }
  return r.json();
}

exports.exchangeCode = (app, code, redirect = process.env.REDIRECT_URI) =>
  token(app, { grant_type: 'authorization_code', code, redirect_uri: redirect });

exports.refresh = (app, refreshToken) =>
  token(app, { grant_type: 'refresh_token', refresh_token: refreshToken });

exports.revoke = async (app, accessToken) => {
  try {
    await fetch(`${API}/oauth2/token/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, token: accessToken, token_type_hint: 'access_token' }),
    });
  } catch {  }
};

const bearer = (accessToken) => ({ Authorization: `Bearer ${accessToken}` });

exports.getUser = async (accessToken) => {
  const r = await fetch(`${API}/users/@me`, { headers: bearer(accessToken) });
  if (!r.ok) throw new Error(`users/@me error ${r.status}`);
  return r.json();
};

exports.getUserGuilds = async (accessToken) => {
  const r = await fetch(`${API}/users/@me/guilds`, { headers: bearer(accessToken) });
  if (!r.ok) throw new Error(`users/@me/guilds error ${r.status}`);
  return r.json();
};

exports.addMember = async (botToken, guildId, userId, accessToken, retries = 3) => {
  const r = await fetch(`${API}/guilds/${guildId}/members/${userId}`, {
    method: 'PUT',
    headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: accessToken }),
  });
  if (r.status === 201) return 'added';
  if (r.status === 204) return 'already';
  if (r.status === 429 && retries > 0) {
    const { retry_after = 1 } = await r.json().catch(() => ({}));
    await sleep(retry_after * 1000 + 250);
    return exports.addMember(botToken, guildId, userId, accessToken, retries - 1);
  }
  return 'failed';
};
