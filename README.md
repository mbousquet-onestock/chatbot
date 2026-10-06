# Assistant commandes OneStock

Chatbot qui s'affiche dans le back-office OneStock (UI Extension) pour **consulter, comprendre et
modifier des commandes client** en langage naturel. Il s'appuie sur Claude (API Anthropic) et sur les
API OneStock du site de l'utilisateur.

- **Front** : Nuxt 4 / Vue 3, composants au format du design system OneStock (`OsButton`, `OsBadge`, `OsAlert`…).
- **Back** : routes Nitro (`server/api`), déployables sur Vercel.
- **Configuration OneStock** : lue dans la table `settings` de la base Vercel/Neon partagée avec l'application
  Extensions (`onestock_token` chiffré, `onestock_api_root`), pour le `site_id` reçu du contexte OneStock.

## Fonctionnement

```
Back-office OneStock        Front (iframe Vue)              Serveur (Nitro)              API OneStock
        │ ── URL ?extension_id,user_id,site_id… ──▶ │
        │ ◀────────── extension_ready ───────────── │
        │ ── onestock_data (signature, order_id) ─▶ │
                                                     │ ── POST /api/session ──▶ vérifie la signature
                                                     │ ◀──── JWT (1 h) ──────── │
                                                     │ ── POST /api/chat ─────▶ Claude + outils ──▶ (token lu en base)
                                                     │ ◀── NDJSON (texte, outils, confirmation) ──
```

1. **Contexte** : l'iframe reçoit `extension_id`, `user_id`, `site_id`, `lang`, `timezone`, `parent_url`… en
   paramètres d'URL, envoie `extension_ready` au back-office et reçoit `onestock_data` (signature, et selon
   l'anchor `order_id` ou `order_ids`). Les messages ne sont acceptés que depuis l'origine de `parent_url`.
2. **Session** : `/api/session` vérifie la signature `t=…,h0=…,h1=…,h2=…` (HMAC-SHA256 de
   `${t}.${extension_id}##${user_id}`, 6 h max) avec `EXTENSION_SECRET_KEYS`, puis émet un JWT d'une heure
   contenant l'utilisateur et le **site**. Toutes les requêtes suivantes utilisent ce site.
3. **Configuration** : pour ce site, le serveur lit `onestock_token` et `onestock_api_root` dans `settings`
   (valeur propre au site prioritaire sur `*`), déchiffre le token (`server/lib/settings-secrets.mjs`, copie du
   module de l'application Extensions) et le garde 5 min en cache mémoire. Le token ne quitte jamais le serveur.
4. **Chat** : `/api/chat` fait tourner Claude avec les outils ci-dessous et diffuse la réponse en streaming.

### Outils exposés au modèle

| Outil | Route OneStock | Type |
|---|---|---|
| `search_orders` | `GET /v2/search_orders` (motif + filtres + dates) | lecture |
| `get_order` | `GET /v3/orders/{id}` | lecture |
| `get_orders` | `GET /v3/orders` (par ids) | lecture |
| `get_order_comments` | `GET /v2/orders/{id}/comments` | lecture |
| `get_order_history` | `GET /v1/history` | lecture |
| `get_parcel` | `GET /v2/parcels/{id}` | lecture |
| `get_line_item_groups` | `GET /v2/line_item_groups` | lecture |
| `update_order_state` | `PATCH /v3/orders/{id}` (`order.from` → `order.to`) | **écriture** |
| `update_order` | `PATCH /v3/orders/{id}` (client, adresse, informations) | **écriture** |
| `update_line_item_groups_state` | `PATCH /v2/line_item_groups` | **écriture** |

Les GET OneStock prennent un corps JSON : ils sont envoyés en `POST` avec `X-HTTP-Method-Override: GET`, comme
le prévoit la documentation de l'API. `site_id` et `token` sont ajoutés par le serveur.

**Aucune écriture sans confirmation** : quand le modèle demande une action d'écriture, le serveur s'arrête et
l'interface affiche une carte « Action à confirmer » avec les paramètres exacts. L'appel à OneStock n'est fait
qu'après clic sur **Confirmer** ; un refus est renvoyé au modèle, qui n'insiste pas.

### Anchors OneStock

Une seule URL sert tous les anchors ; le comportement s'adapte au contexte reçu :

| Anchor | Contexte | Comportement |
|---|---|---|
| `bo.page` | — | Page de recherche/consultation libre |
| `bo.order.action` | `order_id` | « cette commande » = la commande ouverte, bouton de fermeture de la modale |
| `bo.orders.action` | `order_ids` | Travail sur la sélection de commandes |

À fournir à votre contact OneStock : l'URL publique du déploiement Vercel, un nom, une icône, et pour chaque
anchor le chemin `/` et les rôles autorisés (par exemple Customer service, Headquarters).

## Configuration

Variables d'environnement (voir `.env.example`) :

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | Base Neon/Vercel contenant la table `settings` |
| `SETTINGS_ENCRYPTION_KEY` | Clé de déchiffrement des settings (identique à l'application Extensions) |
| `ONESTOCK_ENVIRONMENT` | *Optionnel.* Filtre `settings.environment` (sinon toutes les valeurs) |
| `EXTENSION_SECRET_KEYS` | Secret(s) de l'extension fournis par OneStock, le plus récent d'abord |
| `EXTENSION_ID` | *Optionnel.* Restreint à cet `extension_id` |
| `ALLOWED_SITE_IDS` | *Recommandé.* Liste des `site_id` autorisés |
| `JWT_SECRET` | *Optionnel.* Clé des sessions (dérivée de `EXTENSION_SECRET_KEYS` sinon) |
| `ANTHROPIC_API_KEY` | Clé API Claude |
| `ANTHROPIC_MODEL` | *Optionnel.* Défaut `claude-opus-5-5` |
| `FRAME_ANCESTORS` | *Optionnel.* Origines autorisées à intégrer l'iframe (défaut : domaines OneStock) |

### Onglet « Paramètres »

L'interface a deux onglets : **Assistant** et **Paramètres**. L'onglet Paramètres (`GET /api/settings`,
lecture seule, accessible à tout utilisateur de l'extension) affiche :

- la session : site, utilisateur et extension issus de la signature ;
- les connexions testées : base de données, API OneStock (recherche d'une commande) et API Claude (lecture du
  modèle, sans consommer de tokens) ;
- les lignes `onestock_token` / `onestock_api_root` retenues dans `settings` pour le site (portée, chiffrement) ;
- chaque variable d'environnement : définie, manquante ou valeur par défaut.

Les secrets ne sont jamais renvoyés au navigateur : seule leur présence est indiquée (et le nombre de clés pour
`EXTENSION_SECRET_KEYS`). Pour `ALLOWED_SITE_IDS`, l'onglet indique seulement le nombre de sites et si le site
courant en fait partie. Les valeurs se modifient dans Vercel (puis redéploiement) ou dans l'application Extensions.

Requête utilisée pour la configuration (colonnes `key`, `value`, `environment`, `site_id`) :

```sql
SELECT key, value FROM settings
WHERE key IN ('onestock_token', 'onestock_api_root')
  AND (environment = $ONESTOCK_ENVIRONMENT OR $ONESTOCK_ENVIRONMENT IS NULL)
  AND (site_id = $site_id OR site_id IN ('*', ''))
ORDER BY (site_id = $site_id) DESC
```

`onestock_api_root` est la racine de l'API (ex. `https://c42.api.qualif.onestock-retail.com`) ; un suffixe de
version (`/v3`) éventuel est retiré, chaque route ajoutant la sienne.

## Développement

```bash
npm install
cp .env.example .env   # puis compléter
npm run dev
```

Hors back-office, ouvrir `http://localhost:3000/?site_id=c42&lang=fr` avec `ALLOW_DEV_SESSION=true` (session
sans signature, **à ne jamais activer en production**). Sans `DATABASE_URL`, `ONESTOCK_API_ROOT` et
`ONESTOCK_TOKEN` remplacent la table `settings`.

```bash
npm test          # signature, déchiffrement des settings, dates
npm run typecheck
npm run build
```

## Déploiement Vercel

Importer le dépôt dans Vercel (preset Nuxt détecté automatiquement), renseigner les variables d'environnement
et déployer. Les fonctions sont configurées avec `maxDuration: 300` s, une réponse pouvant enchaîner plusieurs
appels au modèle et à OneStock (la valeur effective dépend de votre plan Vercel).

## Design system

Le design system OneStock (`@onestock-public/design-system`) est un paquet Vue privé (registre GCP, jeton
valable 1 h), difficilement installable dans un build Vercel. Les composants de `app/components/os/` en
reprennent l'API (props `type`, `color`, `text`, `icon`…) et les styles, et `app/assets/css/onestock.css` les
fondations (couleurs, typographie Roboto, espacements, rayons, icônes `os-icon-*`), d'après
https://design-system.onestock-retail.com.

Pour utiliser le paquet officiel une fois l'accès obtenu : l'installer (voir son *Quick start*), importer
`@onestock-public/design-system/dist/onestock-design-system.css` dans `nuxt.config.ts` et remplacer les
composants de `app/components/os/` par `import { OsButton, OsBadge, OsAlert, OsIcon } from '@onestock-public/design-system'`.

## Dépannage

| Message affiché | Cause et correction |
|---|---|
| `EXTENSION_SECRET_KEYS n'est pas défini…` | Variable absente sur Vercel : ajouter le secret fourni par OneStock et redéployer. |
| `La signature OneStock ne correspond à aucune clé…` | Mauvais secret, ou secret d'une autre instance (qualif / training / production ont chacune le leur). |
| `La signature OneStock a plus de 6 heures…` | Recharger la page du back-office. |
| `Extension ouverte hors du back-office…` | Page ouverte directement : pour un test local, `ALLOW_DEV_SESSION=true`. |

Le détail de chaque refus (raison, site, extension_id, nombre de clés, âge de la signature, jamais les secrets)
est écrit dans les logs de la fonction Vercel (`[session] signature check failed`).

## Sécurité

- Le token OneStock reste côté serveur ; le front ne détient qu'un JWT d'une heure (renouvelé automatiquement
  à partir de la signature, valable 6 h).
- La signature OneStock couvre `extension_id` et `user_id`, pas le `site_id` : définissez `ALLOWED_SITE_IDS`
  pour qu'un utilisateur ne puisse pas viser un autre site présent dans `settings`.
- Les appels OneStock utilisent l'utilisateur technique de `onestock_token` : les droits effectifs sont ceux
  de ce compte. Restreignez l'accès à l'extension par rôle dans la configuration de l'anchor.
- L'historique de conversation est conservé par le navigateur et renvoyé à chaque requête : il n'y a pas de
  stockage côté serveur.
