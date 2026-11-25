const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
let me = null, current = null, detail = null, poll = null;

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

const icon = (g) => g.icon
  ? h('img', { class: 'ico', src: `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64`, alt: '' })
  : h('span', { class: 'ico', 'aria-hidden': 'true' }, (g.name || '?')[0].toUpperCase());

function when(ts) {
  const d = ts - Date.now() / 1000;
  if (d < 0) return 'expiré';
  return d < 86400 ? 'dans moins d\'un jour' : `dans ${Math.round(d / 86400)} j`;
}

// ---------- vues ----------
function loginView() {
  app.replaceChildren(h('div', { class: 'login' },
    h('h1', {}, 'ak47bot'),
    h('p', {}, 'Sauvegarde les membres vérifiés de ton serveur et réinvite-les en un clic si tu dois repartir de zéro.'),
    h('div', {}, h('a', { class: 'btn', href: '/panel/login' }, 'Se connecter avec Discord'))));
}

function shell(content) {
  const list = h('ul', {}, me.guilds.map((g) => h('li', {},
    h('button', { class: 'srv' + (g.botIn ? '' : ' off'), 'aria-current': String(g.id === current),
      onclick: () => select(g.id) }, icon(g), h('span', { class: 'name' }, g.name)))));
  const botsBtn = h('button', { class: 'srv', 'aria-current': String(current === 'bots'), onclick: () => select('bots') },
    h('span', { class: 'ico', 'aria-hidden': 'true' }, '⚙'), h('span', { class: 'name' }, 'Mes bots'));
  app.replaceChildren(h('div', { class: 'shell' },
    h('nav', { class: 'rail', 'aria-label': 'Navigation' },
      h('div', { class: 'brand' }, 'ak47bot'), botsBtn, list,
      h('div', { class: 'who' }, h('span', {}, me.user.username),
        h('button', { onclick: logout }, 'Se déconnecter'))),
    h('main', {}, content)));
}

function botsView() {
  const f = {};
  const field = (key, label, type = 'text') => h('label', { class: 'field' }, h('span', {}, label),
    (f[key] = h('input', { type, autocomplete: 'off', spellcheck: 'false' })));
  const addBtn = h('button', { class: 'btn', onclick: async () => {
    addBtn.disabled = true;
    try {
      await api('/bots', { method: 'POST', body: { token: f.token.value, clientId: f.clientId.value, clientSecret: f.clientSecret.value } });
      toast('Bot ajouté'); me = await api('/me'); botsView();
    } catch (e) { addBtn.disabled = false; fail(e); }
  } }, 'Ajouter le bot');

  shell([
    h('div', { class: 'head' }, h('h1', {}, 'Mes bots'),
      h('p', { class: 'sub' }, 'Chaque bot est le tien : il apparaît sur ton serveur avec ton nom et ton image.')),
    h('section', {}, h('h2', {}, 'Bots enregistrés'),
      me.bots.length ? h('div', { class: 'tablewrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Bot'), h('th', {}, 'État'), h('th', {}, ''), h('th', {}, ''))),
        h('tbody', {}, me.bots.map((b) => h('tr', {},
          h('td', {}, b.name), h('td', {}, b.online ? 'En ligne' : 'Hors ligne'),
          h('td', {}, h('a', { class: 'btn ghost', href: b.inviteUrl, target: '_blank', rel: 'noopener' }, 'Inviter')),
          h('td', {}, h('button', { class: 'btn danger', onclick: async () => {
            if (!confirm(`Supprimer ${b.name} ? Les membres sauvegardés avec ce bot seront aussi supprimés.`)) return;
            try { await api('/bots/' + b.id, { method: 'DELETE' }); toast('Bot supprimé'); me = await api('/me'); botsView(); }
            catch (e) { fail(e); } } }, 'Supprimer')))))))
        : h('p', { class: 'empty' }, 'Aucun bot pour l\'instant. Ajoute le tien ci-dessous.')),
    h('section', {}, h('h2', {}, 'Ajouter un bot'),
      h('ol', { class: 'steps' },
        h('li', {}, 'Crée une application sur ', h('a', { href: 'https://discord.com/developers/applications', target: '_blank', rel: 'noopener' }, 'discord.com/developers'), '.'),
        h('li', {}, 'Onglet Bot : active « Server Members Intent » et copie le token.'),
        h('li', {}, 'Onglet OAuth2 : copie le Client ID et le Client Secret, puis ajoute ce lien dans Redirects :'),
        h('li', {}, h('input', { type: 'text', readonly: true, value: me.redirectUri, 'aria-label': 'Lien de redirection' }))),
      h('div', { class: 'form' }, field('clientId', 'Client ID'), field('clientSecret', 'Client Secret', 'password'),
        field('token', 'Token du bot', 'password'), h('div', {}, addBtn)),
      h('p', { class: 'hint' }, 'Le token et le secret sont chiffrés avant d\'être enregistrés. Tu peux les régénérer ou supprimer le bot à tout moment.')),
  ]);
}

function guildView(g, d) {
  const roleSel = h('select', { id: 'role', 'aria-label': 'Rôle des membres vérifiés' },
    h('option', { value: '' }, 'Choisir un rôle'),
    d.roles.map((r) => h('option', { value: r.id, selected: r.id === d.roleId }, r.name)));
  const chanSel = h('select', { id: 'chan', 'aria-label': 'Salon du message' },
    d.channels.map((c) => h('option', { value: c.id }, '#' + c.name)));
  const srcSel = h('select', { id: 'src', 'aria-label': 'Ancien serveur' },
    d.sources.map((s) => h('option', { value: s.id }, `${s.name} (${s.count} membres)`)));
  const bar = h('i'); const stat = h('p', { class: 'hint' });
  const restoreBtn = h('button', { class: 'btn', disabled: d.restoring || !d.sources.length,
    onclick: () => startRestore(d, srcSel.value, restoreBtn, bar, stat) }, 'Restaurer les membres');

  shell([
    h('div', { class: 'head' }, h('h1', {}, d.name),
      h('p', { class: 'sub' }, `${d.saved} membre${d.saved > 1 ? 's' : ''} sauvegardé${d.saved > 1 ? 's' : ''}`)),

    h('section', {}, h('h2', {}, 'Vérification'),
      h('p', {}, 'Les membres qui cliquent sur le bouton de vérification reçoivent ce rôle et sont sauvegardés.'),
      h('div', { class: 'row' }, roleSel,
        h('button', { class: 'btn', onclick: async () => {
          try { await api(`/guilds/${d.id}/settings`, { method: 'POST', body: { roleId: roleSel.value } });
            toast('Rôle enregistré'); select(d.id); } catch (e) { toast(e.message, true); } } }, 'Enregistrer le rôle')),
      d.verifyUrl && [
        h('p', { class: 'hint', style: 'margin-top:1rem' }, 'Lien de vérification'),
        h('div', { class: 'row' }, h('input', { type: 'text', readonly: true, value: d.verifyUrl, 'aria-label': 'Lien de vérification' }),
          h('button', { class: 'btn ghost', onclick: () => navigator.clipboard.writeText(d.verifyUrl).then(() => toast('Lien copié')) }, 'Copier le lien')),
        h('p', { class: 'hint', style: 'margin-top:1rem' }, 'Ou publie le message avec le bouton dans un salon'),
        h('div', { class: 'row' }, chanSel,
          h('button', { class: 'btn ghost', onclick: async () => {
            try { await api(`/guilds/${d.id}/announce`, { method: 'POST', body: { channelId: chanSel.value } });
              toast('Message publié'); } catch (e) { toast(e.message, true); } } }, 'Publier le message')),
      ]),

    h('section', {}, h('h2', {}, 'Restauration'),
      h('p', {}, 'Réinvite dans ce serveur les membres sauvegardés depuis un autre serveur où tu as configuré le bot, même s\'il a été supprimé.'),
      d.sources.length
        ? [h('div', { class: 'row' }, srcSel, restoreBtn), h('div', { class: 'bar', 'aria-hidden': 'true' }, bar), stat]
        : h('p', { class: 'empty' }, 'Aucun autre serveur avec des membres sauvegardés. Configure le bot sur l\'ancien serveur pour qu\'il apparaisse ici.')),

    h('section', {}, h('h2', {}, 'Membres'),
      d.members.length
        ? [
          h('div', { class: 'tablewrap' }, h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Pseudo'), h('th', {}, 'ID'), h('th', {}, 'Jeton'), h('th', {}, ''))),
            h('tbody', {}, d.members.map((m) => h('tr', {},
              h('td', {}, m.username || '—'), h('td', {}, m.id), h('td', {}, when(m.expires_at)),
              h('td', {}, h('button', { class: 'btn danger', onclick: () => removeMember(d, m) }, 'Retirer'))))))),
          d.saved > d.members.length && h('p', { class: 'hint' }, `Les ${d.members.length} premiers sur ${d.saved} sont affichés.`),
        ]
        : h('p', { class: 'empty' }, 'Personne ne s\'est encore vérifié. Partage le lien de vérification.')),
  ]);
}

function noBotView(g) {
  shell(h('div', { class: 'head' }, h('h1', {}, g.name),
    me.bots.length
      ? [h('p', { class: 'sub' }, 'Aucun de tes bots n\'est dans ce serveur. Invite-en un :'),
         h('div', { class: 'row' }, me.bots.map((b) => h('a', { class: 'btn', href: b.inviteUrl, target: '_blank', rel: 'noopener' }, `Inviter ${b.name}`)))]
      : [h('p', { class: 'sub' }, 'Tu n\'as pas encore de bot.'),
         h('button', { class: 'btn', onclick: () => select('bots') }, 'Ajouter mon bot')]));
}

// ---------- actions ----------
async function select(id) {
  clearInterval(poll);
  current = id;
  if (id === 'bots') return botsView();
  const g = me.guilds.find((x) => x.id === id);
  if (!g.botIn) return noBotView(g);
  try {
    detail = await api(`/guilds/${id}`);
    guildView(g, detail);
  } catch (e) { fail(e); }
}

async function removeMember(d, m) {
  if (!confirm(`Retirer ${m.username || m.id} de la sauvegarde ?`)) return;
  try { await api(`/guilds/${d.id}/members/${m.id}`, { method: 'DELETE' }); toast('Membre retiré'); select(d.id); }
  catch (e) { toast(e.message, true); }
}

async function startRestore(d, source, btn, bar, stat) {
  if (!source || !confirm('Lancer la restauration ? Elle peut prendre du temps (environ 1 membre par seconde).')) return;
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
          toast(j.status === 'done' ? 'Restauration terminée' : 'La restauration a échoué', j.status !== 'done');
          btn.disabled = false;
        }
      } catch (e) { clearInterval(poll); fail(e); }
    }, 1500);
  } catch (e) { btn.disabled = false; toast(e.message, true); }
}

async function logout() {
  try { await api('/logout', { method: 'POST' }); } catch {}
  me = null; loginView();
}

function fail(e) { if (e.auth) { me = null; loginView(); } else toast(e.message, true); }

(async () => {
  try { me = await api('/me'); current = 'bots'; botsView(); } catch (e) { loginView(); }
})();
