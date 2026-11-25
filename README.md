# ak47bot

Bot Discord de sauvegarde / restauration de membres (OAuth2 `guilds.join`).

## Installation
1. Portail dev Discord > New Application. Onglet **Bot** : copie le token et active **Server Members Intent**.
2. Onglet **OAuth2** : copie le Client ID et le Client Secret, ajoute ta `REDIRECT_URI` (ex. `https://ton-domaine.com/callback`).
3. `cp .env.example .env`, remplis les valeurs (genere `ENCRYPTION_KEY` et `STATE_SECRET` avec la commande indiquee).
4. `npm install && npm start`
5. Invite le bot avec les permissions **Administrator** (ou Manage Roles + Create Instant Invite) et le scope `bot applications.commands`.

Il faut un domaine en HTTPS qui pointe vers le port du bot (reverse proxy Nginx/Caddy, ou un tunnel type Cloudflare Tunnel).

## Commandes
- `/setup role:@Verifie` : poste le bouton de verification dans le salon.
- `/stats` : nombre de membres sauvegardes.
- `/restore source:<ID ancien serveur>` : reajoute les membres verifies dans le serveur actuel
  (le bot doit etre dans les deux serveurs, et tu dois etre admin des deux).
- `/deletemydata` : un membre supprime ses donnees.

## Securite et vie privee
- Tokens chiffres en AES-256-GCM ; `state` OAuth signe (anti-CSRF).
- Informe clairement les membres de ce qui est stocke (c'est dans le message de verification).
- Tokens revoques ou invalides : supprimes automatiquement.
