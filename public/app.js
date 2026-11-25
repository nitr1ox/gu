const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
let me = null, current = null, detail = null, poll = null;
let guildTab = 'general', guildTabFor = null;

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};

function toast(msg, err) {
  toastEl.textContent = msg;
  toastEl.className = 'show' + (err ? ' err' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (toastEl.className = ''), 3500);
}

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api' + path, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ak47' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) throw Object.assign(new Error('Non connecté'), { auth: true });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Erreur');
  return d;
}

function when(ts) {
  const d = ts - Date.now() / 1000;
  if (d < 0) return 'expiré';
  return d < 86400 ? 'dans moins d\'un jour' : `dans ${Math.round(d / 86400)} j`;
}

const ACTIONS = {
  'restore.start': (d) => `a lancé une restauration (${d.expected ?? '?'} membres) depuis ${d.source_name || d.source}`,
  'restore.end': (d) => d.status === 'done'
    ? `restauration terminée : ${d.added ?? 0} ajoutés, ${d.already ?? 0} déjà présents, ${d.failed ?? 0} échecs`
    : `restauration en erreur (${d.added ?? 0} ajoutés sur ${d.total ?? '?'})`,
  'restore.schedule': (d) => `a planifié une restauration (${d.expected ?? '?'} membres) depuis ${d.source_name || d.source} pour le ${stamp(d.run_at)}`,
  'restore.schedule_cancel': (d) => `a annulé la restauration planifiée du ${stamp(d.run_at)}`,
  'restore.schedule_failed': (d) => `restauration planifiée non lancée : ${d.reason || 'erreur'}`,
  'member.remove': (d) => `a retiré le membre ${d.user_id} de la sauvegarde`,
  'members.mass_removal': (d) => `suppression massive détectée : ${d.count} membres retirés`,
  'bot.delete': (d) => `a supprimé le bot ${d.bot} et ses ${d.members_deleted} membres sauvegardés`,
  'settings.role': (d) => `a défini le rôle de vérification « ${d.role} »`,
  'settings.alerts': (d) => d.channel ? `a activé les alertes dans #${d.channel}` : 'a désactivé les alertes',
  'settings.page': (d) => d.logo ? `a ${d.logo === 'défini' ? 'modifié' : 'retiré'} le logo de la page de vérification` : 'a modifié la page de vérification',
  'settings.protection': (d) => `a modifié les protections (journal : ${[d.log_ip && 'IP', d.log_email && 'email'].filter(Boolean).join(' + ') || 'aucun'}, âge min. ${d.min_age_days ? d.min_age_days + ' j' : 'désactivé'}, anti-alts ${d.anti_alt ? 'oui' : 'non'}, anti-VPN ${d.anti_vpn ? 'oui' : 'non'})`,
  'blacklist.add': (d) => `a ajouté ${d.user_id} à la liste noire`,
  'blacklist.remove': (d) => `a retiré ${d.user_id} de la liste noire`,
  'verify.blocked': (d) => `vérification refusée : ${{ blacklist: 'liste noire', age: `compte trop récent (${d.age_days} j sur ${d.min} requis)`, vpn: 'VPN/proxy détecté', alt: `alt suspecté (même connexion que ${d.other_user})` }[d.reason] || d.reason}`,
  'verify.announce': (d) => `a publié le message de vérification dans #${d.channel}`,
};
const DANGER = new Set(['verify.blocked', 'restore.start', 'restore.schedule', 'restore.schedule_failed', 'members.mass_removal', 'bot.delete']);
const stamp = (ts) => new Date(ts).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
const card = (title, ...kids) => h('section', { class: 'card' }, title && h('h2', {}, title), ...kids);
const copy = (text) => navigator.clipboard.writeText(text).then(() => toast('Lien copié'), () => toast('Copie impossible', true));

const ICONS = {
  dash: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  servers: '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>',
  migrations: '<path d="M4 8h14l-3-3M20 16H6l3 3"/>',
  bots: '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 4v4M9 13h.01M15 13h.01"/>',
  members: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 11l2 2 4-4"/>',
  account: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="3"/><path d="M6.5 18.5c1.2-2 3-3 5.5-3s4.3 1 5.5 3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
};
const svg = (name) => {
  const s = h('span', { class: 'svg', 'aria-hidden': 'true' });
  s.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return s;
};

function loginView() {
  app.replaceChildren(h('div', { class: 'login' },
    h('div', { class: 'logo' }, 'AK'),
    h('h1', {}, 'ak47bot'),
    h('p', {}, 'Sauvegarde les membres vérifiés de ton serveur et réinvite-les en un clic si tu dois repartir de zéro.'),
    h('a', { class: 'btn', href: '/panel/login' }, 'Se connecter avec Discord')));
}

function modal(title, sub) {
  const body = h('div', { class: 'modal-body' });
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); clearInterval(poll); };
  const ov = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === ov) close(); } },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('div', {}, h('h2', {}, title), sub && h('p', { class: 'hint', style: 'margin:.2rem 0 0' }, sub)),
        h('button', { class: 'btn ghost sm', onclick: close, 'aria-label': 'Fermer' }, '✕')),
      body));
  document.addEventListener('keydown', onKey);
  document.body.append(ov);
  return { body, close };
}

const toggle = (title, hint, checked, onchange) => {
  const box = h('input', { type: 'checkbox', class: 'switch', 'aria-label': title });
  box.checked = !!checked;
  box.addEventListener('change', () => onchange(box.checked, box));
  return h('label', { class: 'toggle' }, h('span', {}, h('b', {}, title), h('small', {}, hint)), box);
};

const NAV = [
  ['dash', 'dash', 'Tableau de bord'], ['servers', 'servers', 'Serveurs'], ['migrations', 'migrations', 'Migrations'],
  ['bots', 'bots', 'Bots'], ['members', 'members', 'Membres vérifiés'], ['account', 'account', 'Compte'],
];
const isGuildPage = (c) => !NAV.some(([k]) => k === c);
function shell(content) {
  const nav = NAV.map(([key, ico, label]) => h('button', {
    class: 'srv', 'aria-current': String(current === key || (key === 'servers' && isGuildPage(current))), onclick: () => select(key) },
    svg(ico), h('span', { class: 'name' }, label)));
  app.replaceChildren(h('div', { class: 'shell' },
    h('nav', { class: 'rail', 'aria-label': 'Navigation' },
      h('div', { class: 'brand' }, h('span', { class: 'logo' }, 'AK'), 'ak47bot'),
      h('div', { class: 'nav-top' }, nav),
      h('div', { class: 'who' }, h('span', {}, me.user.username), h('button', { onclick: logout }, 'Déconnexion'))),
    h('main', {}, content)));
  window.scrollTo(0, 0);
}

const pageHead = (title, sub, ...actions) => h('div', { class: 'head headbar' },
  h('div', {}, h('h1', {}, title), sub && h('p', { class: 'sub' }, sub)),
  actions.length ? h('div', { class: 'row' }, actions) : null);

let overview = null;
async function loadOverview() {
  const rows = await Promise.all(me.guilds.filter((g) => g.botIn).map((g) =>
    api('/guilds/' + g.id).then((d) => ({ g, d })).catch(() => null)));
  overview = rows.filter(Boolean);
  return overview;
}
const botFirst = () => me.bots[0];

async function dashView() {
  shell(h('p', { class: 'loading' }, 'Chargement…'));
  const rows = await loadOverview();
  const saved = rows.reduce((n, r) => n + r.d.saved, 0);
  const pending = rows.reduce((n, r) => n + (r.d.schedules || []).filter((x) => x.status === 'pending').length, 0);
  const events = rows.flatMap((r) => r.d.audit.map((a) => ({ ...a, server: r.g.name })))
    .sort((x, y) => y.ts - x.ts).slice(0, 8);
  shell([
    pageHead(`Bonjour ${me.user.username}`, 'Vue d\'ensemble de tes serveurs et de tes bots.'),
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', {}, String(rows.length)), h('span', {}, 'Serveurs')),
      h('div', { class: 'stat' }, h('b', {}, String(saved)), h('span', {}, 'Membres vérifiés')),
      h('div', { class: 'stat' }, h('b', {}, String(me.bots.filter((b) => b.online).length) + ' / ' + me.bots.length), h('span', {}, 'Bots en ligne')),
      h('div', { class: 'stat' }, h('b', {}, String(pending)), h('span', {}, 'Migrations planifiées'))),
    !me.bots.length && card('Pour commencer', h('p', { class: 'hint' }, 'Ajoute ton premier bot, invite-le sur ton serveur, puis configure la vérification.'),
      h('button', { class: 'btn', onclick: () => select('bots') }, 'Ajouter un bot')),
    card('Activité récente', events.length
      ? h('div', { class: 'tablewrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Serveur'), h('th', {}, 'Action'))),
        h('tbody', {}, events.map((a) => h('tr', {}, h('td', {}, stamp(a.ts)), h('td', {}, a.server),
          h('td', { class: 'wrap' + (DANGER.has(a.action) ? ' warn' : '') }, (ACTIONS[a.action] || (() => a.action))(a.detail)))))))
      : h('p', { class: 'empty' }, 'Aucune activité pour l\'instant.')),
  ]);
}

function addServerModal() {
  const m = modal('Ajouter un serveur', 'Invite un de tes bots sur le serveur, il apparaîtra ensuite ici.');
  m.body.append(me.bots.length
    ? [h('p', { class: 'hint' }, 'Choisis le bot à inviter. Place son rôle au-dessus du rôle de vérification une fois qu\'il est sur le serveur.'),
      h('div', { class: 'stack' }, me.bots.map((b) => h('a', { class: 'btn', href: b.inviteUrl, target: '_blank', rel: 'noopener' }, `Inviter ${b.name}`)))]
    : [h('p', { class: 'hint' }, 'Tu n\'as pas encore de bot.'),
      h('button', { class: 'btn', onclick: () => { m.close(); select('bots'); } }, 'Ajouter un bot')]);
}

async function serversView() {
  shell(h('p', { class: 'loading' }, 'Chargement…'));
  const rows = await loadOverview();
  shell([
    pageHead('Serveurs', 'Gère tes serveurs.',
      h('button', { class: 'btn ghost', onclick: addServerModal }, svg('plus'), 'Ajouter un serveur')),
    rows.length ? h('div', { class: 'srvgrid' }, rows.map(({ g, d }) => h('div', { class: 'card srvcard' },
      h('div', { class: 'srvtop' }, icon(g), h('div', { class: 'grow' }, h('b', {}, g.name),
        h('div', { class: 'hint' }, d.verifyUrl ? 'Vérification active' : 'Rôle de vérification à choisir')),
        h('span', { class: 'pill', title: 'Membres vérifiés' }, String(d.saved))),
      d.verifyUrl
        ? h('div', { class: 'linkrow' }, svg('link'), h('a', { href: d.verifyUrl, target: '_blank', rel: 'noopener' }, d.verifyUrl),
          h('button', { class: 'btn ghost sm', onclick: () => copy(d.verifyUrl) }, 'Copier'))
        : null,
      h('div', { class: 'row nowrap' },
        h('button', { class: 'btn green grow', onclick: () => migrationModal(d) }, 'Ajouter les membres'),
        h('button', { class: 'btn ghost iconbtn', 'aria-label': 'Réglages', title: 'Réglages', onclick: () => select(g.id) }, svg('gear')))
    ))) : h('p', { class: 'empty' }, me.bots.length
      ? 'Aucun serveur pour l\'instant. Invite un de tes bots avec « Ajouter un serveur ».'
      : 'Aucun serveur. Commence par ajouter un bot dans l\'onglet Bots.'),
  ]);
}

const icon = (g) => g.icon
  ? h('img', { class: 'ico', src: `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64`, alt: '' })
  : h('span', { class: 'ico', 'aria-hidden': 'true' }, (g.name || '?')[0].toUpperCase());

function migrationModal(d) {
  const m = modal('Migration', `Ajoute des membres sauvegardés dans ${d.name}.`);
  const canRestore = d.sources.length || d.botTotal;
  if (!canRestore) {
    m.body.append(h('p', { class: 'empty' }, 'Aucun membre sauvegardé disponible. Fais d\'abord vérifier des membres, ou configure le bot sur l\'ancien serveur.'));
    return;
  }
  const srcSel = h('select', { 'aria-label': 'Source' },
    d.botTotal > 0 && h('option', { value: 'all' }, `Tous les membres de ${d.botName} (${d.botTotal})`),
    d.sources.map((s) => h('option', { value: s.id }, `${s.name} (${s.count} membres)`)));
  const bar = h('i'); const stat = h('p', { class: 'hint' });
  const sumSource = h('b'), sumCount = h('b'), sumTime = h('b');
  const refresh = () => {
    const n = srcSel.value === 'all' ? d.botTotal : (d.sources.find((s) => s.id === srcSel.value)?.count || 0);
    sumSource.textContent = srcSel.selectedOptions[0]?.textContent || '—';
    sumCount.textContent = String(n);
    sumTime.textContent = n < 60 ? `~${n} s` : `~${Math.ceil(n / 60)} min`;
  };
  srcSel.addEventListener('change', refresh); refresh();
  const restoreBtn = h('button', { class: 'btn green block', disabled: d.restoring, onclick: () => startRestore(d, srcSel.value, restoreBtn, bar, stat) }, 'Ajouter les membres');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const whenIn = h('input', { type: 'datetime-local', 'aria-label': 'Date et heure' });
  const schedBtn = h('button', { class: 'btn ghost', onclick: () => scheduleRestore(d, srcSel.value, whenIn, m) }, 'Planifier');
  m.body.append(
    h('div', { class: 'label', style: 'margin-top:0' }, 'Source des membres'), srcSel,
    h('div', { class: 'summary' },
      h('div', { class: 'cap' }, 'Résumé'),
      h('div', { class: 'sumrow' }, h('span', {}, 'Serveur cible'), h('b', {}, d.name)),
      h('div', { class: 'sumrow' }, h('span', {}, 'Source'), sumSource),
      h('div', { class: 'sumrow' }, h('span', {}, 'Membres à ajouter'), sumCount),
      h('div', { class: 'sumrow' }, h('span', {}, 'Temps estimé'), sumTime)),
    restoreBtn, h('div', { class: 'bar', 'aria-hidden': 'true' }, bar), stat,
    h('div', { class: 'label' }, 'Ou planifie à une heure précise'),
    h('div', { class: 'row' }, whenIn, schedBtn),
    h('p', { class: 'hint', style: 'margin:.5rem 0 0' }, `Heure de ton navigateur${tz ? ' (' + tz + ')' : ''}. Entre 1 minute et 30 jours à l'avance.`));
}

let migTab = 'active';
const SCHED = { pending: 'En attente', running: 'Lancement…', started: 'Lancée', failed: 'Échec', missed: 'Manquée', cancelled: 'Annulée' };
async function migrationsView() {
  shell(h('p', { class: 'loading' }, 'Chargement…'));
  const rows = await loadOverview();
  const active = rows.flatMap(({ g, d }) => [
    ...(d.restoring ? [{ kind: 'run', g, d }] : []),
    ...(d.schedules || []).filter((x) => x.status === 'pending').map((x) => ({ kind: 'sched', g, d, x })),
  ]);
  const history = rows.flatMap(({ g, d }) => d.audit.filter((a) => a.action === 'restore.end').map((a) => ({ g, a })))
    .sort((x, y) => y.a.ts - x.a.ts);
  const failedSched = rows.flatMap(({ g, d }) => (d.schedules || []).filter((x) => ['failed', 'missed'].includes(x.status)).map((x) => ({ g, x })));

  const tabs = h('div', { class: 'seg', role: 'tablist' }, [['active', `Actives${active.length ? ' (' + active.length + ')' : ''}`], ['history', 'Historique']].map(([k, label]) =>
    h('button', { class: 'segbtn', role: 'tab', 'aria-selected': String(migTab === k), onclick: () => { migTab = k; migrationsView(); } }, label)));

  const activeList = active.length ? active.map((r) => r.kind === 'run'
    ? h('div', { class: 'card migcard' }, h('div', { class: 'migtop' }, icon(r.g), h('div', { class: 'grow' }, h('b', {}, r.g.name), h('div', { class: 'hint' }, 'Migration en cours')), h('span', { class: 'badge ok' }, 'En cours')))
    : h('div', { class: 'card migcard' }, h('div', { class: 'migtop' }, icon(r.g),
      h('div', { class: 'grow' }, h('b', {}, r.g.name), h('div', { class: 'hint' }, `${plural(r.x.expected, 'membre')} depuis ${r.x.source_name} · ${stamp(r.x.run_at)}`)),
      h('span', { class: 'badge' }, SCHED.pending), h('button', { class: 'btn danger', onclick: () => cancelSchedule(r.d, r.x) }, 'Annuler'))))
    : h('p', { class: 'empty' }, 'Aucune migration active ou planifiée. Lance-en une depuis la page Serveurs.');

  const histList = (history.length || failedSched.length) ? [
    ...history.map(({ g, a }) => {
      const t = a.detail.total || a.detail.added || 0;
      const ok = a.detail.status === 'done';
      const pct = (n) => (t ? Math.min(100, (n / t) * 100) : 0);
      return h('div', { class: 'card migcard' },
        h('div', { class: 'migtop' }, icon(g), h('div', { class: 'grow' }, h('b', {}, g.name),
          h('div', { class: 'hint' }, `${a.detail.added ?? 0} / ${t} membres ajoutés (${Math.round(pct(a.detail.added ?? 0))} %) · ${a.detail.already ?? 0} déjà présents · ${a.detail.failed ?? 0} échecs`)),
          h('span', { class: 'badge' + (ok ? ' ok' : ' bad') }, ok ? 'Terminée' : 'Erreur')),
        h('div', { class: 'bar2', 'aria-hidden': 'true' }, h('i', { class: 'g', style: `width:${pct(a.detail.added ?? 0)}%` }), h('i', { class: 'r', style: `width:${pct(a.detail.failed ?? 0)}%` })),
        h('div', { class: 'hint' }, stamp(a.ts)));
    }),
    ...failedSched.map(({ g, x }) => h('div', { class: 'card migcard' }, h('div', { class: 'migtop' }, icon(g),
      h('div', { class: 'grow' }, h('b', {}, g.name), h('div', { class: 'hint' }, `Planifiée pour ${stamp(x.run_at)}${x.error ? ' — ' + x.error : ''}`)),
      h('span', { class: 'badge bad' }, SCHED[x.status])))),
  ] : h('p', { class: 'empty' }, 'Aucune migration terminée pour l\'instant.');

  shell([pageHead('Migrations', 'Ajoute des membres sauvegardés dans tes serveurs.'), tabs, migTab === 'active' ? activeList : histList]);
}

function addBotModal() {
  const m = modal('Ajouter un bot', 'Chaque bot est le tien : il apparaît sur ton serveur avec ton nom et ton image.');
  const f = {};
  const field = (key, label, type = 'text') => h('label', { class: 'field' }, h('span', {}, label),
    (f[key] = h('input', { type, autocomplete: 'off', spellcheck: 'false' })));
  const addBtn = h('button', { class: 'btn', onclick: async () => {
    addBtn.disabled = true;
    try {
      await api('/bots', { method: 'POST', body: { token: f.token.value, clientId: f.clientId.value, clientSecret: f.clientSecret.value } });
      toast('Bot ajouté'); me = await api('/me'); m.close(); botsView();
    } catch (e) { addBtn.disabled = false; fail(e); }
  } }, 'Ajouter le bot');
  m.body.append(
    h('ol', { class: 'steps' },
      h('li', {}, 'Crée une application sur ', h('a', { href: 'https://discord.com/developers/applications', target: '_blank', rel: 'noopener' }, 'discord.com/developers'), '.'),
      h('li', {}, 'Onglet Bot : active « Server Members Intent » et copie le token.'),
      h('li', {}, 'Onglet OAuth2 : copie le Client ID et le Client Secret, puis ajoute ce lien dans Redirects :')),
    h('div', { class: 'row' },
      h('input', { type: 'text', readonly: true, value: me.redirectUri, 'aria-label': 'Lien de redirection' }),
      h('button', { class: 'btn ghost', onclick: () => copy(me.redirectUri) }, 'Copier')),
    h('div', { class: 'form' }, field('clientId', 'Client ID'), field('clientSecret', 'Client Secret', 'password'),
      field('token', 'Token du bot', 'password'), h('div', {}, addBtn)),
    h('p', { class: 'hint' }, 'Le token et le secret sont chiffrés avant d\'être enregistrés.'));
}

function manageBotModal(b) {
  const m = modal(b.name, 'Gestion du bot');
  m.body.append(
    h('div', { class: 'sumrow' }, h('span', {}, 'ID'), h('b', { class: 'mono' }, b.id)),
    h('div', { class: 'sumrow' }, h('span', {}, 'État'), h('span', { class: 'badge' + (b.online ? ' ok' : '') }, b.online ? 'En ligne' : 'Hors ligne')),
    h('div', { class: 'label' }, 'Lien de redirection à ajouter dans l\'application Discord'),
    h('div', { class: 'row' }, h('input', { type: 'text', readonly: true, value: me.redirectUri }), h('button', { class: 'btn ghost', onclick: () => copy(me.redirectUri) }, 'Copier')),
    h('div', { class: 'row', style: 'margin-top:1.25rem' },
      h('a', { class: 'btn ghost', href: b.inviteUrl, target: '_blank', rel: 'noopener' }, 'Inviter le bot'),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!confirm(`Supprimer ${b.name} ? Les membres sauvegardés avec ce bot seront aussi supprimés.`)) return;
        try { await api('/bots/' + b.id, { method: 'DELETE' }); toast('Bot supprimé'); me = await api('/me'); m.close(); botsView(); }
        catch (e) { fail(e); } } }, 'Supprimer le bot')));
}

function botsView() {
  shell([
    pageHead('Bots', 'Gère tes bots Discord.', h('button', { class: 'btn ghost', onclick: addBotModal }, svg('plus'), 'Ajouter un bot')),
    me.bots.length
      ? h('div', { class: 'srvgrid' }, me.bots.map((b) => h('div', { class: 'card srvcard' },
        h('div', { class: 'srvtop' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, (b.name || '?')[0].toUpperCase()),
          h('div', { class: 'grow' }, h('b', {}, b.name), h('div', { class: 'hint mono' }, b.id)),
          h('span', { class: 'dotlive' + (b.online ? ' on' : ''), title: b.online ? 'En ligne' : 'Hors ligne' })),
        h('div', { class: 'row nowrap' },
          h('button', { class: 'btn ghost grow', onclick: () => manageBotModal(b) }, 'Gérer'),
          h('a', { class: 'btn ghost grow', href: b.inviteUrl, target: '_blank', rel: 'noopener' }, 'Inviter')))))
      : h('p', { class: 'empty' }, 'Aucun bot pour l\'instant. Utilise « Ajouter un bot » pour créer le tien.'),
  ]);
}

let memFilter = 'all', memQuery = '';
async function membersView() {
  shell(h('p', { class: 'loading' }, 'Chargement…'));
  const rows = await loadOverview();
  const sel = h('select', { 'aria-label': 'Serveur', onchange: () => { memFilter = sel.value; draw(); } },
    h('option', { value: 'all' }, 'Tous les serveurs'), rows.map((r) => h('option', { value: r.g.id, selected: r.g.id === memFilter }, r.g.name)));
  const q = h('input', { type: 'text', placeholder: 'Rechercher un pseudo ou un ID…', value: memQuery, 'aria-label': 'Recherche', oninput: () => { memQuery = q.value; draw(); } });
  const list = h('div');
  const draw = () => {
    const all = rows.filter((r) => memFilter === 'all' || r.g.id === memFilter)
      .flatMap((r) => r.d.members.map((m) => ({ m, g: r.g, d: r.d })));
    const term = memQuery.trim().toLowerCase();
    const shown = all.filter(({ m }) => !term || (m.username || '').toLowerCase().includes(term) || m.id.includes(term));
    const hasIp = shown.some((x) => x.m.ip), hasMail = shown.some((x) => x.m.email);
    list.replaceChildren(shown.length ? card(null,
      h('div', { class: 'tablewrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Pseudo'), h('th', {}, 'ID'), h('th', {}, 'Serveur'), hasIp && h('th', {}, 'IP'), hasMail && h('th', {}, 'E-mail'), h('th', {}, 'Jeton'), h('th', {}, ''))),
        h('tbody', {}, shown.map(({ m, g, d }) => h('tr', {},
          h('td', {}, m.username || '—'), h('td', { class: 'mono' }, m.id), h('td', {}, g.name),
          hasIp && h('td', { class: 'mono wrap' }, m.ip || '—'), hasMail && h('td', { class: 'wrap' }, m.email || '—'),
          h('td', {}, when(m.expires_at)),
          h('td', { class: 'act' }, h('button', { class: 'btn danger', onclick: () => removeMember(d, m) }, 'Retirer'))))))),
      rows.some((r) => r.d.saved > r.d.members.length) && h('p', { class: 'hint', style: 'margin:.75rem 0 0' }, 'Les 100 premiers membres de chaque serveur sont affichés.'))
      : h('p', { class: 'empty' }, all.length ? 'Aucun résultat.' : 'Personne ne s\'est encore vérifié. Partage le lien de vérification de ton serveur.'));
  };
  draw();
  shell([pageHead('Membres vérifiés', 'Les membres sauvegardés sur tes serveurs.'), h('div', { class: 'row filters' }, sel, q), list]);
}

function accountView() {
  shell([
    pageHead('Compte', 'Ton profil et ta session.'),
    card('Profil',
      h('div', { class: 'sumrow' }, h('span', {}, 'Pseudo'), h('b', {}, me.user.username)),
      h('div', { class: 'sumrow' }, h('span', {}, 'ID Discord'), h('b', { class: 'mono' }, me.user.id)),
      h('div', { class: 'sumrow' }, h('span', {}, 'Bots'), h('b', {}, String(me.bots.length))),
      h('div', { class: 'row', style: 'margin-top:1.1rem' }, h('button', { class: 'btn ghost', onclick: logout }, 'Se déconnecter'))),
  ]);
}

const protBody = (p, patch) => ({ min_age_days: p.min_age_days, anti_alt: p.anti_alt, anti_vpn: p.anti_vpn, log_ip: p.log_ip, log_email: p.log_email, ...patch });
async function saveProt(d, patch, msg, box) {
  try {
    await api(`/guilds/${d.id}/protection`, { method: 'POST', body: protBody(d.protection, patch) });
    Object.assign(d.protection, patch);
    toast(msg || 'Enregistré');
  } catch (e) { if (box) box.checked = !box.checked; fail(e); }
}

function guildView(g, d) {
  const roleSel = h('select', { id: 'role', 'aria-label': 'Rôle des membres vérifiés' },
    h('option', { value: '' }, 'Choisir un rôle'),
    d.roles.map((r) => h('option', { value: r.id, selected: r.id === d.roleId }, r.name)));
  const chanSel = h('select', { id: 'chan', 'aria-label': 'Salon du message' },
    d.channels.map((c) => h('option', { value: c.id }, '#' + c.name)));
  const alertSel = h('select', { id: 'alert', 'aria-label': 'Salon des alertes' },
    h('option', { value: '' }, 'Alertes désactivées'),
    d.channels.map((c) => h('option', { value: c.id, selected: c.id === d.alertChannelId }, '#' + c.name)));

  const needRole = (what) => card(null, h('p', { class: 'empty' },
    `Choisis d'abord le rôle de vérification (onglet Général) pour configurer ${what}.`));
  const TABS = [['general', 'Général'], ['page', 'Visuel'], ['security', 'Sécurité'], ['firewall', 'Firewall'], ['extras', 'Extras']];
  if (guildTabFor !== d.id) { guildTab = 'general'; guildTabFor = d.id; }
  const tabBar = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Sections du serveur' },
    TABS.map(([key, label]) => h('button', { class: 'tab', role: 'tab', 'aria-selected': String(key === guildTab),
      onclick: () => { guildTab = key; guildView(g, d); } }, label)));

  const p = d.protection;
  const age = h('input', { type: 'number', min: '0', max: String(p.maxAge), step: '1', value: String(p.min_age_days), 'aria-label': 'Âge minimum du compte en jours' });
  const bl = h('input', { type: 'text', placeholder: 'ID Discord à blacklister', inputmode: 'numeric', 'aria-label': 'ID Discord à blacklister' });

  const panes = {
    general: [
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('b', {}, String(d.saved)), h('span', {}, 'Membres vérifiés')),
        h('div', { class: 'stat' }, h('b', {}, String(d.sources.length)), h('span', {}, 'Autres serveurs')),
        h('div', { class: 'stat' }, h('b', {}, String(d.botTotal || 0)), h('span', {}, `Membres de ${d.botName || 'ton bot'}`))),
      card('Profil du serveur',
        h('div', { class: 'sumrow' }, h('span', {}, 'Nom'), h('b', {}, d.name)),
        h('div', { class: 'sumrow' }, h('span', {}, 'Bot'), h('b', {}, d.botName)),
        h('div', { class: 'row', style: 'margin-top:1rem' }, h('button', { class: 'btn green', onclick: () => migrationModal(d) }, 'Ajouter les membres'))),
      card('Intégration Discord',
        h('p', { class: 'lead hint' }, 'Les membres qui cliquent sur le bouton de vérification reçoivent ce rôle et sont sauvegardés.'),
        h('div', { class: 'label', style: 'margin-top:0' }, 'Rôle des membres vérifiés'),
        h('div', { class: 'row' }, roleSel,
          h('button', { class: 'btn', onclick: async () => {
            try { await api(`/guilds/${d.id}/settings`, { method: 'POST', body: { roleId: roleSel.value } });
              toast('Rôle enregistré'); select(d.id); } catch (e) { fail(e); } } }, 'Enregistrer le rôle')),
        d.verifyUrl && [
          h('div', { class: 'label' }, 'Lien de vérification'),
          h('div', { class: 'row' }, h('input', { type: 'text', readonly: true, value: d.verifyUrl, 'aria-label': 'Lien de vérification' }),
            h('button', { class: 'btn ghost', onclick: () => copy(d.verifyUrl) }, 'Copier')),
          h('div', { class: 'label' }, 'Ou publie le message avec le bouton dans un salon'),
          h('div', { class: 'row' }, chanSel,
            h('button', { class: 'btn ghost', onclick: async () => {
              try { await api(`/guilds/${d.id}/announce`, { method: 'POST', body: { channelId: chanSel.value } });
                toast('Message publié'); } catch (e) { fail(e); } } }, 'Publier le message')),
        ]),
    ],
    page: [d.verifyUrl ? pageCard(d) : needRole('la page')],
    security: d.verifyUrl ? [
      card('Données collectées',
        h('p', { class: 'lead hint' }, 'Ce que tu enregistres quand un membre se vérifie. S\'applique aux nouvelles vérifications. Les membres en sont informés sur la page de vérification, et tout est chiffré en base.'),
        toggle('Journal des adresses IP', 'Enregistre l\'adresse IP du membre à la vérification.', p.log_ip, (v, box) => saveProt(d, { log_ip: v }, 'Enregistré', box)),
        toggle('Accès à l\'e-mail', 'Discord demande alors l\'accès à l\'e-mail du membre.', p.log_email, (v, box) => saveProt(d, { log_email: v }, 'Enregistré', box)),
        h('p', { class: 'hint', style: 'margin:.8rem 0 0' }, 'Tu es responsable de ces données (RGPD) : n\'active que ce dont tu as besoin.')),
    ] : [needRole('la sécurité')],
    firewall: d.verifyUrl ? [
      card('Protections',
        h('p', { class: 'lead hint' }, 'Contrôles appliqués avant qu\'un membre soit vérifié. Un membre refusé n\'est pas sauvegardé et ne reçoit pas le rôle ; chaque refus est inscrit au journal.'),
        toggle('Anti-alts', 'Refuse un second compte vérifié depuis la même connexion. Seule une empreinte chiffrée de l\'IP est conservée.', p.anti_alt, (v, box) => saveProt(d, { anti_alt: v }, 'Enregistré', box)),
        toggle('Anti-VPN', 'Refuse les VPN, proxys et Tor. Un service externe (proxycheck.io) reçoit l\'IP du membre ; s\'il est indisponible, la vérification est acceptée.', p.anti_vpn, (v, box) => saveProt(d, { anti_vpn: v }, 'Enregistré', box)),
        h('div', { class: 'label' }, 'Âge minimum du compte Discord (jours, 0 = désactivé)'),
        h('div', { class: 'row' }, age, h('button', { class: 'btn', onclick: () => saveProt(d, { min_age_days: Number(age.value || 0) }, 'Âge minimum enregistré') }, 'Enregistrer'))),
      card(`Liste noire (${p.blacklist.length}/${p.maxBlacklist})`,
        h('p', { class: 'lead hint' }, 'Ces membres ne peuvent pas se vérifier.'),
        h('div', { class: 'row' }, bl,
          h('button', { class: 'btn ghost', onclick: async () => {
            try { await api(`/guilds/${d.id}/blacklist`, { method: 'POST', body: { userId: bl.value } });
              toast('Ajouté à la liste noire'); select(d.id); } catch (e) { fail(e); } } }, 'Ajouter')),
        p.blacklist.length
          ? h('div', { class: 'tablewrap' }, h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, ''))),
            h('tbody', {}, p.blacklist.map((id) => h('tr', {},
              h('td', { class: 'mono' }, id),
              h('td', { class: 'act' }, h('button', { class: 'btn danger', onclick: async () => {
                try { await api(`/guilds/${d.id}/blacklist/${id}`, { method: 'DELETE' }); toast('Retiré de la liste noire'); select(d.id); } catch (e) { fail(e); } } }, 'Retirer')))))))
          : h('p', { class: 'empty' }, 'Liste noire vide.')),
    ] : [needRole('le firewall')],
    extras: [
      card('Alertes de sécurité',
        h('p', { class: 'lead hint' }, `Le bot poste un message dans ce salon quand une restauration de ${d.massRestore} membres ou plus est lancée, quand des membres sont retirés en rafale, ou quand un bot est supprimé avec ses données. Choisis un salon réservé aux admins.`),
        h('div', { class: 'row' }, alertSel,
          h('button', { class: 'btn', onclick: async () => {
            try { await api(`/guilds/${d.id}/alerts`, { method: 'POST', body: { channelId: alertSel.value } });
              toast(alertSel.value ? 'Alertes activées (message de test envoyé)' : 'Alertes désactivées'); select(d.id); } catch (e) { fail(e); } } }, 'Enregistrer'))),
      card('Journal d\'activité',
        d.audit.length
          ? h('div', { class: 'tablewrap' }, h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Qui'), h('th', {}, 'Action'))),
            h('tbody', {}, d.audit.map((a) => h('tr', {},
              h('td', {}, stamp(a.ts)),
              h('td', {}, a.actor, a.via === 'api' ? ' (API)' : a.via === 'schedule' ? ' (planifié)' : ''),
              h('td', { class: 'wrap' + (DANGER.has(a.action) ? ' warn' : '') }, (ACTIONS[a.action] || (() => a.action))(a.detail)))))))
          : h('p', { class: 'empty' }, 'Aucune activité enregistrée pour l\'instant.')),
    ],
  };

  shell([
    h('div', { class: 'head' }, h('button', { class: 'btn ghost sm back', onclick: () => select('servers') }, '← Serveurs'),
      h('h1', {}, d.name), h('p', { class: 'sub' }, 'Modifie les réglages et la configuration du serveur.')),
    tabBar,
    ...panes[guildTab],
  ]);
}

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const readable = (hex) => (lum(hex) > 0.4 ? '#111111' : '#ffffff');

function pageCard(d) {
  const p = d.page, v = p.values, def = p.defaults;
  const text = (key, label, max, area) => {
    const el = h(area ? 'textarea' : 'input', { type: area ? null : 'text', maxlength: max, rows: area ? 4 : null, placeholder: def[key] });
    el.value = p.custom.includes(key) ? v[key] : '';
    return { el, node: h('label', { class: 'field' }, h('span', {}, label), el) };
  };
  const f = {
    title: text('title', 'Titre', 60), text: text('text', 'Texte', 600, true), button: text('button', 'Texte du bouton', 30),
    successTitle: text('successTitle', 'Titre après vérification', 60), successText: text('successText', 'Texte après vérification', 300),
  };
  const accentOn = h('input', { type: 'checkbox', checked: p.custom.includes('accent') ? '' : null });
  const accent = h('input', { type: 'color', value: v.accent || '#4a5232' });
  const bgOn = h('input', { type: 'checkbox', checked: p.custom.includes('bg') ? '' : null });
  const bg = h('input', { type: 'color', value: v.bg || '#14160f' });
  const colorRow = (on, input, label) => h('label', { class: 'colorrow' }, on, h('span', {}, label), input);

  const prevLogo = h('img', { class: 'plogo', alt: '', width: 64, height: 64 });
  const prevTitle = h('b'), prevText = h('div', { class: 'ptext' }), prevBtn = h('span', { class: 'pbtn' });
  const prev = h('div', { class: 'preview', 'aria-label': 'Aperçu de la page' }, prevLogo, prevTitle, prevText, prevBtn,
    h('div', { class: 'pnote' }, 'Mention sur les données stockées (toujours affichée)'));
  const fillName = (t) => t.replace(/\{server\}/gi, p.serverName);

  let logoUrl = p.logoUrl;
  const draw = () => {
    const bgc = bgOn.checked ? bg.value : null, acc = accentOn.checked ? accent.value : '#4a5232';
    const ink = bgc ? readable(bgc) : null;
    prev.style.cssText = bgc
      ? `--bg:${bgc};--ink:${ink};--card:color-mix(in srgb,${bgc} 90%,${ink});--line:color-mix(in srgb,${bgc} 78%,${ink});--muted:color-mix(in srgb,${ink} 70%,${bgc})`
      : '';
    prev.classList.toggle('custom', !!bgc);
    prevBtn.style.cssText = `background:${acc};color:${readable(acc)}`;
    const src = logoUrl || p.serverIcon;
    prevLogo.hidden = !src; if (src) prevLogo.src = src;
    prevTitle.textContent = fillName(f.title.el.value || def.title);
    prevText.textContent = fillName(f.text.el.value || def.text);
    prevBtn.textContent = fillName(f.button.el.value || def.button);
    accent.disabled = !accentOn.checked; bg.disabled = !bgOn.checked;
  };
  [f.title, f.text, f.button].forEach((x) => x.el.addEventListener('input', draw));
  [accentOn, accent, bgOn, bg].forEach((x) => x.addEventListener('input', draw));
  draw();

  const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true });
  const logoRequest = async (init) => {
    const r = await fetch(`/api/guilds/${d.id}/page/logo`, { credentials: 'same-origin', ...init,
      headers: { 'X-Requested-With': 'ak47', ...(init.headers || {}) } });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) throw Object.assign(new Error('Non connecté'), { auth: true });
    if (!r.ok) throw new Error(j.error || 'Erreur');
  };
  fileIn.addEventListener('change', async () => {
    const file = fileIn.files[0]; if (!file) return;
    if (file.size > 200 * 1024) { fileIn.value = ''; return toast('Image trop lourde (200 Ko maximum).', true); }
    try { await logoRequest({ method: 'PUT', headers: { 'Content-Type': file.type }, body: file }); toast('Logo enregistré'); select(d.id); }
    catch (e) { fail(e); }
  });

  const save = async (reset) => {
    const body = reset ? {} : {
      title: f.title.el.value, text: f.text.el.value, button: f.button.el.value,
      successTitle: f.successTitle.el.value, successText: f.successText.el.value,
      accent: accentOn.checked ? accent.value : '', bg: bgOn.checked ? bg.value : '',
    };
    try { await api(`/guilds/${d.id}/page`, { method: 'POST', body }); toast(reset ? 'Page réinitialisée' : 'Page enregistrée'); select(d.id); }
    catch (e) { fail(e); }
  };

  return card('Page de vérification',
    h('p', { class: 'lead hint' }, 'Ce que voient les membres en cliquant sur ton lien ou ton bouton. Laisse un champ vide pour garder le texte par défaut. Écris {server} pour insérer le nom du serveur.'),
    h('div', { class: 'pagegrid' },
      h('div', { class: 'form wide' },
        h('div', { class: 'field' }, h('span', {}, 'Logo'),
          h('div', { class: 'row' },
            h('button', { class: 'btn ghost sm', onclick: () => fileIn.click() }, p.logoUrl ? 'Remplacer le logo' : 'Choisir un logo'),
            p.logoUrl && h('button', { class: 'btn danger', onclick: async () => {
              try { await logoRequest({ method: 'DELETE' }); toast('Logo retiré'); select(d.id); } catch (e) { fail(e); } } }, 'Retirer'),
            fileIn),
          h('span', { class: 'hint fine' }, p.logoUrl ? 'Logo personnalisé.' : 'Par défaut : l\'icône du serveur. PNG, JPEG, GIF ou WebP, 200 Ko maximum.')),
        f.title.node, f.text.node, f.button.node,
        h('div', { class: 'colors' }, colorRow(accentOn, accent, 'Couleur du bouton'), colorRow(bgOn, bg, 'Couleur de fond')),
        f.successTitle.node, f.successText.node,
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => save(false) }, 'Enregistrer'),
          h('button', { class: 'btn ghost', onclick: () => { if (confirm('Revenir aux textes et couleurs par défaut ?')) save(true); } }, 'Réinitialiser'),
          h('a', { class: 'btn ghost', href: d.verifyUrl, target: '_blank', rel: 'noopener' }, 'Voir la vraie page'))),
      h('div', {}, h('div', { class: 'label', style: 'margin-top:0' }, 'Aperçu'), prev,
        h('p', { class: 'hint fine' }, 'L\'aperçu se met à jour pendant la saisie ; il faut enregistrer pour l\'appliquer.'))));
}

const TOP = { dash: dashView, servers: serversView, migrations: migrationsView, bots: botsView, members: membersView, account: accountView };
async function select(id) {
  clearInterval(poll);
  current = id;
  if (TOP[id]) { guildTabFor = null; return TOP[id](); }
  const g = me.guilds.find((x) => x.id === id);
  if (!g || !g.botIn) return select('servers');
  try {
    const m = document.querySelector('main'); if (m) m.append(h('p', { class: 'loading' }, 'Chargement…'));
    detail = await api(`/guilds/${id}`);
    guildView(g, detail);
  } catch (e) { fail(e); }
}

async function removeMember(d, m) {
  if (!confirm(`Retirer ${m.username || m.id} de la sauvegarde ?`)) return;
  try { await api(`/guilds/${d.id}/members/${m.id}`, { method: 'DELETE' }); toast('Membre retiré'); select(current); }
  catch (e) { toast(e.message, true); }
}

async function startRestore(d, source, btn, bar, stat) {
  if (!source || !confirm('Lancer l\'ajout des membres ? Environ 1 membre par seconde.')) return;
  btn.disabled = true;
  try {
    const { jobId } = await api(`/guilds/${d.id}/restore`, { method: 'POST', body: { source } });
    poll = setInterval(async () => {
      try {
        const j = await api(`/jobs/${jobId}`);
        bar.style.width = (j.total ? (j.done / j.total) * 100 : 0) + '%';
        stat.textContent = `${j.done} / ${j.total} traités · ${j.added} ajoutés · ${j.already} déjà présents · ${j.failed} échecs`;
        if (j.status !== 'running') {
          clearInterval(poll);
          toast(j.status === 'done' ? 'Migration terminée' : 'La migration a échoué', j.status !== 'done');
          btn.disabled = false;
        }
      } catch (e) { clearInterval(poll); fail(e); }
    }, 1500);
  } catch (e) { btn.disabled = false; toast(e.message, true); }
}

async function scheduleRestore(d, source, input, m) {
  if (!source) return;
  const runAt = input.value ? new Date(input.value).getTime() : NaN;
  if (!Number.isFinite(runAt)) return toast('Choisis une date et une heure.', true);
  if (!confirm(`Planifier l'ajout des membres le ${stamp(runAt)} ?`)) return;
  try {
    await api(`/guilds/${d.id}/restore/schedule`, { method: 'POST', body: { source, runAt } });
    toast('Migration planifiée');
    m.close(); select(current);
  } catch (e) { fail(e); }
}

async function cancelSchedule(d, x) {
  if (!confirm(`Annuler la migration prévue le ${stamp(x.run_at)} ?`)) return;
  try { await api(`/guilds/${d.id}/restore/schedule/${x.id}`, { method: 'DELETE' }); toast('Planification annulée'); select(current); }
  catch (e) { fail(e); }
}

async function logout() {
  try { await api('/logout', { method: 'POST' }); } catch {}
  me = null; loginView();
}

function fail(e) { if (e.auth) { me = null; loginView(); } else toast(e.message, true); }

(async () => {
  try { me = await api('/me'); select('dash'); } catch (e) { loginView(); }
})();
