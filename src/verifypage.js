// Page de vérification personnalisable : textes, couleurs et logo choisis par le propriétaire du serveur.
// Tout ce qui vient de l'utilisateur est validé à l'enregistrement et échappé au rendu.
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LIMITS = { title: 60, text: 600, button: 30, successTitle: 60, successText: 300 };

exports.DEFAULTS = {
  title: 'Vérification',
  text: 'Clique sur le bouton pour confirmer que tu es bien membre de {server}.',
  button: 'Se vérifier',
  successTitle: 'Vérifié',
  successText: 'Tu peux retourner sur Discord.',
  accent: null, // null = couleur par défaut
  bg: null,     // null = clair/sombre automatique
};

const HEX = /^#[0-9a-f]{6}$/i;
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);

// body (venant du panel) -> objet à stocker. Lève une Error avec message affichable si invalide.
exports.sanitize = (body = {}) => {
  const out = {};
  for (const [k, max] of Object.entries(LIMITS)) {
    const v = clean(body[k], max);
    out[k] = v || null; // vide = valeur par défaut
  }
  for (const k of ['accent', 'bg']) {
    const v = String(body[k] ?? '').trim();
    if (!v) out[k] = null;
    else if (!HEX.test(v)) throw new Error('Couleur invalide (format attendu : #rrggbb).');
    else out[k] = v.toLowerCase();
  }
  return out;
};

// Valeurs effectives (défauts appliqués)
exports.resolve = (stored = {}) => {
  const d = exports.DEFAULTS;
  const r = {};
  for (const k of Object.keys(d)) r[k] = stored?.[k] || d[k];
  return r;
};

// Luminance relative WCAG et couleur de texte lisible
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const readable = (bg) => (lum(bg) > 0.4 ? '#111111' : '#ffffff');
exports.readable = readable;

// Variables CSS de la page selon les couleurs choisies
const cssVars = (p) => {
  const accent = p.accent || '#4a5232';
  let base = ':root{--bg:#f4f5f1;--card:#fff;--ink:#1b1f16;--muted:#5a6150;--line:#e1e4d8}'
    + '@media(prefers-color-scheme:dark){:root{--bg:#14160f;--card:#1c1f15;--ink:#eceee4;--muted:#a0a692;--line:#2d3123}}';
  if (p.bg) {
    const ink = readable(p.bg);
    base = `:root{--bg:${p.bg};--ink:${ink};--card:color-mix(in srgb,${p.bg} 90%,${ink});`
      + `--line:color-mix(in srgb,${p.bg} 78%,${ink});--muted:color-mix(in srgb,${ink} 70%,${p.bg})}`;
  }
  return `${base}:root{--accent:${accent};--on-accent:${readable(accent)}}`;
};

const fill = (t, serverName) => String(t).replace(/\{server\}/gi, serverName || 'ce serveur');
const paragraphs = (t) => esc(t).split(/\n{2,}/).map((s) => `<p>${s.replace(/\n/g, '<br>')}</p>`).join('');

const STYLE = `
body{font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink);display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
.c{max-width:440px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:36px 28px 28px;text-align:center}
.logo{width:84px;height:84px;object-fit:contain;border-radius:18px;margin:0 auto 18px;display:block}
h1{font-size:1.4rem;line-height:1.25;margin:0 0 10px;overflow-wrap:anywhere}
.c p{margin:0 0 10px;color:var(--muted);overflow-wrap:anywhere}
.btn{display:inline-block;margin-top:14px;background:var(--accent);color:var(--on-accent);text-decoration:none;font-weight:600;padding:12px 28px;border-radius:9px;transition:filter .15s}
.btn:hover{filter:brightness(1.08)}
.btn:focus-visible{outline:3px solid var(--ink);outline-offset:3px}
.notice{margin-top:24px;padding-top:16px;border-top:1px solid var(--line);font-size:.78rem;line-height:1.5;color:var(--muted)}
.notice p{font-size:inherit;margin:0 0 6px}
@media(prefers-reduced-motion:reduce){.btn{transition:none}}`;

// Mention affichée en permanence, non modifiable : le membre doit savoir ce qu'il autorise.
const NOTICE = '<div class="notice"><p>En autorisant l\'application, tu permets à ce serveur de te réinviter automatiquement s\'il est un jour perdu, '
  + 'et à son propriétaire de t\'ajouter à ses autres serveurs où ce bot est présent.</p>'
  + '<p>Le bot enregistre ton ID Discord, ton pseudo et cette autorisation. Elle ne donne accès ni à ton mot de passe, ni à tes messages, ni à ton compte. '
  + 'Tu peux la retirer à tout moment dans Discord (Paramètres, Applications autorisées) : tes données sont alors supprimées automatiquement sous quelques jours.</p></div>';

// Si l'anti-alts ou l'anti-VPN est actif, le membre doit en être informé (adresse IP utilisée pour le contrôle)
const IP_NOTE = '<p>Ce serveur contrôle ta connexion (VPN, comptes multiples) : une empreinte chiffrée de ton adresse IP peut être conservée, jamais l\'adresse elle-même.</p>';
const logNote = (ip, email) => {
  const what = [ip && 'ton adresse IP', email && 'ton adresse e-mail'].filter(Boolean).join(' et ');
  return what ? `<p>Ce serveur a choisi d\'enregistrer ${what} (chiffré), visible par ses administrateurs. ${email ? 'Discord te demandera l\'accès à ton e-mail. ' : ''}Supprimé automatiquement si tu retires l\'application dans Discord.</p>` : '';
};
const NOTICE_FN = (ipCheck, logIp, logEmail) => NOTICE.replace('</div>', `${ipCheck ? IP_NOTE : ''}${logNote(logIp, logEmail)}</div>`);

// kind : 'start' (page d'accueil) | 'done' (après vérification)
exports.render = ({ stored, guildId, guildName, logoUrl, kind = 'start', ipCheck = false, logIp = false, logEmail = false }) => {
  const p = exports.resolve(stored);
  const title = fill(kind === 'done' ? p.successTitle : p.title, guildName);
  const body = fill(kind === 'done' ? p.successText : p.text, guildName);
  const logo = logoUrl ? `<img class="logo" src="${esc(logoUrl)}" alt="" width="84" height="84">` : '';
  const action = kind === 'start'
    ? `<a class="btn" href="/verify/start?guild=${encodeURIComponent(guildId)}">${esc(fill(p.button, guildName))}</a>${NOTICE_FN(ipCheck, logIp, logEmail)}`
    : '';
  const dark = p.bg && lum(p.bg) <= 0.4;
  const scheme = p.bg ? (dark ? 'dark' : 'light') : 'light dark';
  return `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="color-scheme" content="${scheme}"><meta name="robots" content="noindex"><title>${esc(title)}</title>`
    + `<style>${cssVars(p)}${STYLE}</style><body><main class="c">${logo}<h1>${esc(title)}</h1>${paragraphs(body)}${action}</main></body></html>`;
};

// Logo : formats raster uniquement (jamais de SVG, qui peut contenir du script)
exports.LOGO_MAX = 200 * 1024;
exports.sniffImage = (buf) => {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
};
