// Protections de la vérification : âge minimum du compte, anti-alts (même IP), anti-VPN, liste noire.
// Les contrôles tournent AVANT l'enregistrement du jeton : un membre refusé n'est jamais sauvegardé.
const crypto = require('crypto');
const db = require('./db');

const DISCORD_EPOCH = 1420070400000n;
const MAX_BLACKLIST = 500;
const MAX_AGE_DAYS = 365;
const VPN_TIMEOUT_MS = 4000;

exports.MAX_BLACKLIST = MAX_BLACKLIST;
exports.MAX_AGE_DAYS = MAX_AGE_DAYS;

exports.DEFAULTS = { min_age_days: 0, anti_alt: false, anti_vpn: false, log_ip: false, log_email: false };

// Valeurs effectives (la liste noire est gérée à part)
exports.resolve = (stored = {}) => ({
  min_age_days: Number(stored?.min_age_days) || 0,
  anti_alt: !!stored?.anti_alt,
  anti_vpn: !!stored?.anti_vpn,
  log_ip: !!stored?.log_ip,
  log_email: !!stored?.log_email,
});

// body venant du panel -> réglages à stocker. Lève une Error affichable si invalide.
exports.sanitize = (body = {}) => {
  const days = Number(body.min_age_days ?? 0);
  if (!Number.isInteger(days) || days < 0 || days > MAX_AGE_DAYS) {
    throw new Error(`Âge minimum invalide (0 à ${MAX_AGE_DAYS} jours).`);
  }
  return { min_age_days: days, anti_alt: body.anti_alt === true, anti_vpn: body.anti_vpn === true,
    log_ip: body.log_ip === true, log_email: body.log_email === true };
};

exports.isSnowflake = (v) => /^\d{17,20}$/.test(String(v));

// Date de création du compte, déduite de l'ID Discord (snowflake)
exports.createdAt = (userId) => Number((BigInt(userId) >> 22n) + DISCORD_EPOCH);

// Empreinte de l'IP : on ne stocke jamais l'IP en clair. Liée au serveur pour ne pas pouvoir recouper entre serveurs.
const ipHash = (guildId, ip) =>
  crypto.createHmac('sha256', process.env.STATE_SECRET).update(`${guildId}|${ip}`).digest('hex').slice(0, 40);
exports.ipHash = ipHash;

// Anti-VPN via proxycheck.io (clé optionnelle : PROXYCHECK_KEY). En cas d'erreur du service : on laisse passer (fail-open).
async function isVpn(ip) {
  try {
    const qs = new URLSearchParams({ vpn: '1', risk: '1' });
    if (process.env.PROXYCHECK_KEY) qs.set('key', process.env.PROXYCHECK_KEY);
    const r = await fetch(`https://proxycheck.io/v2/${encodeURIComponent(ip)}?${qs}`, { signal: AbortSignal.timeout(VPN_TIMEOUT_MS) });
    if (!r.ok) return false;
    const data = (await r.json())?.[ip];
    if (!data) return false;
    return data.proxy === 'yes' || data.type === 'VPN' || data.type === 'TOR' || data.type === 'SOCKS' || data.type === 'HTTP' || data.type === 'HTTPS';
  } catch (e) {
    console.error('antivpn', e.message);
    return false;
  }
}

const isLocalIp = (ip) => !ip || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i.test(ip);

const MESSAGES = {
  blacklist: 'Tu ne peux pas te vérifier sur ce serveur.',
  age: 'Ton compte Discord est trop récent pour se vérifier sur ce serveur. Réessaie plus tard.',
  vpn: 'VPN ou proxy détecté. Désactive-le puis recommence la vérification.',
  alt: 'Un autre compte a déjà été vérifié depuis cette connexion. Un seul compte par personne est autorisé.',
};
exports.MESSAGES = MESSAGES;

// Renvoie null si tout est bon, sinon { reason: 'blacklist'|'age'|'vpn'|'alt', detail? }.
// cfg = document du serveur (Firestore). Ne lève pas d'erreur.
exports.check = async ({ cfg, guildId, userId, ip }) => {
  if ((cfg.blacklist || []).includes(userId)) return { reason: 'blacklist' };

  const p = exports.resolve(cfg.protection);
  if (p.min_age_days > 0) {
    const ageDays = (Date.now() - exports.createdAt(userId)) / 86400000;
    if (ageDays < p.min_age_days) return { reason: 'age', detail: { age_days: Math.floor(ageDays), min: p.min_age_days } };
  }
  if ((p.anti_vpn || p.anti_alt) && isLocalIp(ip)) return null; // IP inexploitable (dev local) : on ne bloque pas
  if (p.anti_vpn && (await isVpn(ip))) return { reason: 'vpn' };
  if (p.anti_alt) {
    const other = await db.getIpOwner(guildId, ipHash(guildId, ip));
    if (other && other !== userId) return { reason: 'alt', detail: { other_user: other } };
  }
  return null;
};

// À appeler une fois la vérification réussie : mémorise l'empreinte IP du membre (seulement si l'anti-alts est actif)
exports.remember = async ({ cfg, guildId, userId, ip }) => {
  if (!exports.resolve(cfg.protection).anti_alt || isLocalIp(ip)) return;
  await db.saveIp(guildId, ipHash(guildId, ip), userId);
};
