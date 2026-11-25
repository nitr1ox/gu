// Restaurations planifiées : « ajoute les membres à telle heure précise ».
// Stockage : Firestore `schedules`. Les échéances en attente sont aussi gardées en mémoire et déclenchées
// par un seul timer réarmé sur la prochaine échéance (précision ~1 s, pas de lecture Firestore en boucle).
// Hypothèse (comme le reste du projet) : un seul processus serveur.
const db = require('./db');
const services = require('./services');
const audit = require('./audit');

const { ApiError } = services;

const MIN_LEAD_MS = 60 * 1000;                                   // au moins 1 min dans le futur
const MAX_LEAD_MS = 30 * 24 * 3600 * 1000;                       // au plus 30 jours
const MAX_PENDING_PER_GUILD = Number(process.env.MAX_SCHEDULES_PER_GUILD || 5);
// Si le serveur était éteint à l'heure prévue, on n'exécute pas « en retard » au-delà de ce délai
const GRACE_MS = Number(process.env.SCHEDULE_GRACE_MINUTES || 10) * 60 * 1000;
const RELOAD_MS = 10 * 60 * 1000;
const MAX_TIMER_MS = 60 * 1000;                                  // le timer ne dort jamais plus d'1 min (limite de setTimeout, dérive)

const pending = new Map(); // id -> { id, run_at, target }
let timer = null;

// Accepte un timestamp en ms ou une date ISO 8601 AVEC fuseau (Z ou +02:00) : sans fuseau, l'heure serait ambiguë.
exports.parseRunAt = (v) => {
  let ms;
  if (typeof v === 'number') ms = v;
  else if (typeof v === 'string' && /^\d{10,13}$/.test(v.trim())) ms = Number(v.trim());
  else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v.trim())) ms = Date.parse(v.trim());
  else throw new ApiError(400, 'Heure invalide : donne un timestamp en millisecondes ou une date ISO 8601 avec fuseau (ex. 2026-12-01T20:00:00+01:00).');
  if (ms < 1e12) ms *= 1000; // secondes -> ms
  if (!Number.isFinite(ms)) throw new ApiError(400, 'Heure invalide.');
  return Math.floor(ms);
};

const publicView = (s) => ({
  id: s.id, source: s.source, source_name: s.source_name, expected: s.expected, run_at: s.run_at,
  status: s.status, by: s.user_name || s.user_id, job_id: s.job_id || null, error: s.error || null,
});
exports.publicView = publicView;

exports.list = async (guildId) => (await db.schedulesOfGuild(guildId, 10)).map(publicView);

exports.create = async ({ userId, guildId, source, runAt, actor }) => {
  const now = Date.now();
  if (runAt < now + MIN_LEAD_MS) throw new ApiError(400, 'Choisis une heure au moins 1 minute dans le futur.');
  if (runAt > now + MAX_LEAD_MS) throw new ApiError(400, `Planification limitée à ${Math.round(MAX_LEAD_MS / 86400000)} jours.`);

  // Mêmes contrôles que pour un lancement immédiat (admin du serveur, même bot, source autorisée)
  const { found, bot, expected, srcName } = await services.validateRestore({ userId, guildId, source });
  if (!expected) throw new ApiError(400, 'Aucun membre sauvegardé à restaurer depuis cette source.');

  const existing = (await db.schedulesOfGuild(guildId, 50)).filter((s) => s.status === 'pending');
  if (existing.length >= MAX_PENDING_PER_GUILD) throw new ApiError(429, `Maximum ${MAX_PENDING_PER_GUILD} restaurations planifiées en attente par serveur.`);

  const rec = {
    user_id: userId, user_name: String(actor?.name || userId).slice(0, 64), via: actor?.via || 'panel',
    target: guildId, bot_id: bot.id, source: String(source), source_name: srcName, expected,
    run_at: runAt, status: 'pending', created: now,
  };
  const id = await db.createSchedule(rec);
  pending.set(id, { id, run_at: runAt, target: guildId });
  arm();

  await audit.log(guildId, actor, 'restore.schedule', { schedule_id: id, source: String(source), source_name: srcName, expected, run_at: runAt });
  // Une restauration massive planifiée est signalée dès la planification (laisse le temps d'annuler)
  if (expected >= audit.MASS_RESTORE) {
    audit.alert({ guildId, botId: bot.id, level: 'danger', title: 'Restauration massive planifiée',
      lines: [`**${expected}** membres seront ajoutés dans **${found.guild.name}** le <t:${Math.floor(runAt / 1000)}:F> (<t:${Math.floor(runAt / 1000)}:R>).`,
        `Source : ${srcName}`, `Planifié par : ${actor?.name || actor?.id} (${actor?.id}) via ${actor?.via}`,
        'Tu peux l\'annuler depuis le panel avant l\'heure prévue.'] });
  }
  return { id, run_at: runAt, expected, source_name: srcName };
};

// Annule une restauration planifiée de ce serveur (seulement tant qu'elle est en attente)
exports.cancel = async ({ guildId, scheduleId, actor }) => {
  const s = await db.getSchedule(String(scheduleId));
  if (!s || s.target !== guildId) throw new ApiError(404, 'Planification introuvable.');
  if (s.status !== 'pending') throw new ApiError(409, 'Cette planification n\'est plus en attente.');
  // Passe par claim : si le déclenchement est en cours à la même seconde, un seul des deux gagne
  if (!(await db.claimSchedule(s.id))) throw new ApiError(409, 'Cette planification n\'est plus en attente.');
  await db.updateSchedule(s.id, { status: 'cancelled', cancelled: Date.now(), cancelled_by: actor?.id || null });
  pending.delete(s.id);
  arm();
  await audit.log(guildId, actor, 'restore.schedule_cancel', { schedule_id: s.id, run_at: s.run_at, source_name: s.source_name });
};

async function execute(s) {
  if (!(await db.claimSchedule(s.id))) return; // annulée, supprimée ou déjà prise
  const actor = { id: s.user_id, name: s.user_name, via: 'schedule' };
  try {
    // Re-validation complète à l'heure H : l'utilisateur doit toujours être admin avec son bot présent, la source valide, etc.
    const jobId = await services.startRestore({ userId: s.user_id, guildId: s.target, source: s.source, actor });
    await db.updateSchedule(s.id, { status: 'started', job_id: jobId, started: Date.now() });
  } catch (e) {
    const reason = e instanceof ApiError ? e.message : 'Erreur interne.';
    if (!(e instanceof ApiError)) console.error('schedule', s.id, e);
    await db.updateSchedule(s.id, { status: 'failed', error: reason });
    await audit.log(s.target, actor, 'restore.schedule_failed', { schedule_id: s.id, reason });
    audit.alert({ guildId: s.target, botId: s.bot_id, level: 'warn', title: 'Restauration planifiée non lancée',
      lines: [`Prévue le <t:${Math.floor(s.run_at / 1000)}:F>.`, `Raison : ${reason}`] });
  }
}

async function markMissed(s) {
  if (!(await db.claimSchedule(s.id))) return;
  await db.updateSchedule(s.id, { status: 'missed', error: 'Le serveur était indisponible à l\'heure prévue.' });
  await audit.log(s.target, { id: s.user_id, name: s.user_name, via: 'schedule' }, 'restore.schedule_failed',
    { schedule_id: s.id, reason: 'Le serveur était indisponible à l\'heure prévue (non exécutée).' });
  audit.alert({ guildId: s.target, botId: s.bot_id, level: 'warn', title: 'Restauration planifiée manquée',
    lines: [`Prévue le <t:${Math.floor(s.run_at / 1000)}:F>, non exécutée car le serveur était indisponible.`, 'Relance-la depuis le panel si nécessaire.'] });
}

async function tick() {
  timer = null;
  const now = Date.now();
  const due = [...pending.values()].filter((s) => s.run_at <= now);
  for (const s of due) {
    pending.delete(s.id);
    const full = await db.getSchedule(s.id).catch(() => null);
    if (!full || full.status !== 'pending') continue;
    if (now - full.run_at > GRACE_MS) await markMissed(full).catch((e) => console.error('schedule', e));
    else await execute(full).catch((e) => console.error('schedule', e));
  }
  arm();
}

function arm() {
  clearTimeout(timer);
  timer = null;
  if (!pending.size) return;
  const next = Math.min(...[...pending.values()].map((s) => s.run_at));
  timer = setTimeout(tick, Math.min(Math.max(next - Date.now(), 0), MAX_TIMER_MS));
  timer.unref?.();
}

async function load() {
  try {
    pending.clear();
    for (const s of await db.pendingSchedules()) pending.set(s.id, { id: s.id, run_at: s.run_at, target: s.target });
    arm();
  } catch (e) { console.error('schedule load', e.message); }
}

// À appeler une fois les bots démarrés (la restauration a besoin du bot en ligne)
exports.start = async () => {
  await load();
  setInterval(load, RELOAD_MS).unref(); // resynchronise (ex. planification annulée/supprimée en base)
};
