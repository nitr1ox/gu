# ak47bot

Service de sauvegarde / restauration de membres Discord (OAuth2 `guilds.join`), façon RestoreCord :
**chaque utilisateur ajoute son propre bot depuis le panel web**. Base de données Firebase (Firestore).

## Comment ça marche
- Toi (l'hébergeur) tu fais tourner ce projet. Tu n'as **pas** de token de bot à mettre.
- Une application Discord « panel » sert uniquement à se connecter au panel (`PANEL_CLIENT_ID` / `PANEL_CLIENT_SECRET`).
- Chaque client crée **sa** propre application/bot Discord et colle son Client ID, son Client Secret et son token dans le panel
  (onglet « Mes bots »). Le serveur connecte son bot automatiquement.
- Les jetons des membres appartiennent à l'application du bot qui les a collectés : pour restaurer, le client invite
  **le même bot** dans le nouveau serveur, puis lance la restauration depuis le panel.

## 1. Application Discord du panel (toi)
1. https://discord.com/developers/applications > New Application.
2. **OAuth2** : copie Client ID et Client Secret (`PANEL_CLIENT_ID`, `PANEL_CLIENT_SECRET`).
3. Ajoute le Redirect `https://ton-domaine.com/panel/callback`. Aucun bot n'est nécessaire sur cette application.

## 2. Firebase (gratuit, plan Spark)
1. https://console.firebase.google.com > Ajouter un projet.
2. **Firestore Database > Créer une base** (mode production).
3. Onglet **Règles** : colle `firestore.rules` et publie (aucun accès client, seul le serveur lit/écrit).
4. **Paramètres du projet > Comptes de service > Générer une nouvelle clé privée** : enregistre-la sous `serviceAccountKey.json`
   (ou colle son contenu dans la variable `FIREBASE_SERVICE_ACCOUNT` sur Render).

Vérifie les quotas actuels du plan gratuit sur la page de tarification Firebase.

## 3. Lancer
```
cp .env.example .env     # remplis les valeurs
npm install
npm start
```
Panel : `https://ton-domaine.com/panel/`

Sur Render : ajoute les variables dans **Environment** (pas de fichier `.env`), Build `npm install`, Start `npm start`,
et mets `REDIRECT_URI=https://ton-service.onrender.com/callback`.

Il faut un domaine HTTPS. Le serveur doit rester allumé en continu : chaque bot client est connecté en permanence,
donc beaucoup de clients consomment de la mémoire (les offres gratuites d'hébergeurs se mettent souvent en veille ou limitent la RAM).

## Guide pour tes clients (à partager)
1. Crée une application sur https://discord.com/developers/applications.
2. Onglet **Bot** : active **Server Members Intent**, copie le token.
3. Onglet **OAuth2** : copie Client ID et Client Secret, ajoute en Redirect `https://ton-domaine.com/callback`.
4. Dans le panel > **Mes bots** : colle les trois valeurs.
5. Invite le bot sur ton serveur (bouton « Inviter »), place son rôle **au-dessus** du rôle « Vérifié ».
6. Ouvre ton serveur dans le panel : choisis le rôle, publie le message de vérification.
7. Serveur perdu ? Invite le même bot dans le nouveau serveur, ouvre-le dans le panel > **Restauration**.

## Sécurité et vie privée
- Tokens de bots, secrets et jetons de membres chiffrés en AES-256-GCM avant Firestore. Garde `ENCRYPTION_KEY` précieusement :
  si elle fuit, tous les bots de tes clients sont compromis ; si tu la perds, tout devient illisible.
- Cookies de session HttpOnly, `state` OAuth signé, en-tête anti-CSRF sur les actions du panel.
- Les membres sont informés de ce qui est stocké dans le message de vérification et peuvent tout supprimer avec `/deletemydata`.
- Prévois une politique de confidentialité pour tes clients et leurs membres.
