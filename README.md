# Assistant commandes OneStock

Chatbot qui s'affiche dans le back-office OneStock (UI Extension) pour **consulter, comprendre et
modifier des commandes client** en langage naturel. Il s'appuie sur OpenAI (`gpt-4o`, function calling) et sur les
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
        │ ── onestock_data (order_id…) ───────────▶ │
                                                     │ ── POST /api/chat ─────▶ GPT-4o + outils ──▶ (token lu en base)
                                                     │ ◀── NDJSON (texte, outils, confirmation) ──
```

1. **Contexte** : l'iframe reçoit `extension_id`, `user_id`, `site_id`, `lang`, `timezone`, `parent_url`… en
   paramètres d'URL, envoie `extension_ready` au back-office et reçoit `onestock_data` (selon l'anchor
   `order_id` ou `order_ids`). Les messages ne sont acceptés que depuis l'origine de `parent_url`. Sans réponse
   du back-office (ou hors back-office), seuls les paramètres d'URL sont utilisés ; `site_id` est obligatoire.
2. **Contexte transmis au serveur** : le front envoie `site_id`, `user_id` et `extension_id` dans les en-têtes
   `X-Onestock-Site-Id`, `X-Onestock-User-Id` et `X-Onestock-Extension-Id`. La signature de l'extension n'est
   **pas vérifiée** : seuls `ALLOWED_SITE_IDS` et `EXTENSION_ID` filtrent ces valeurs.
3. **Configuration** : pour ce site, le serveur lit `onestock_token` et `onestock_api_root` dans `settings`
   (valeur propre au site prioritaire sur `*`), déchiffre le token (`server/lib/settings-secrets.mjs`, copie du
   module de l'application Extensions) et le garde 5 min en cache mémoire. Le token ne quitte jamais le serveur.
4. **Chat** : `/api/chat` fait tourner le modèle OpenAI avec les outils ci-dessous et diffuse la réponse en streaming.

### Outils exposés au modèle

| Outil | Route OneStock | Type |
|---|---|---|
| `search_orders` | `GET /v2/search_orders` (motif + filtres + dates) | lecture |
| `get_order` | `GET /v3/orders/{id}` | lecture |
| `get_orders` | `GET /v3/orders` (par ids) | lecture |
| `get_order_comments` | `GET /v2/orders/{id}/comments` | lecture |
| `get_order_history` | `GET /v1/history` | lecture |
| `get_parcel` | `GET /v2/parcels/{id}` | lecture |
| `get_order_parcels` | `GET /v3/orders/{id}` (`parcels.*` : avancement, suivi, documents) | lecture |
| `get_endpoint` | `GET /v3/endpoints/{id}` (nom, adresse, ouverture, horaires) | lecture |
| `search_endpoints` | `GET /v3/endpoints` (ville, type, modules, proximité…) | lecture |
| `get_line_item_groups` | `GET /v2/line_item_groups` | lecture |
| `get_order_items_details` | `GET /v3/orders/{id}` (`order_items.item.features.*` : nom, description, image…) | lecture |
| `search_items` | `GET /v3/items` (catalogue : motif, product_ids, caractéristiques) | lecture |
| `cancel_order` | `PATCH /v2/line_item_groups` : toutes les lignes → `removed` (une transition par état actuel) | **écriture** |
| `update_order_state` | `PATCH /v3/orders/{id}` (`order.from` → `order.to`) | **écriture** |
| `update_order` | `PATCH /v3/orders/{id}` (client, adresse, informations) | **écriture** |
| `update_line_item_groups_state` | `PATCH /v2/line_item_groups` | **écriture** |

Les GET OneStock prennent un corps JSON : ils sont envoyés en `POST` avec `X-HTTP-Method-Override: GET`, comme
le prévoit la documentation de l'API. `site_id` et `token` sont ajoutés par le serveur.

**Documents des colis** : `get_order_parcels` ajoute à chaque colis des liens `document_links` vers
`/api/documents/{id}?site_id=…`. Cette route lit `GET /v3/documents/{id}` et renvoie le fichier, ou à défaut
l'aperçu en image contenu dans la réponse, pour l'ouvrir dans un onglet.

**Annulation d'une commande** : `cancel_order` lit les lignes de la commande, ignore celles déjà à `removed`
et demande la transition `état actuel → removed` pour chaque état. Si OneStock refuse une transition (erreur 4xx),
ces lignes ne sont pas modifiées et une alerte l'indique : annulation impossible (« le statut de la commande ne
permet plus l'annulation ») ou partielle (lignes annulées / lignes refusées, avec leur état).

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
| `DATABASE_URL` | Base Neon/Vercel contenant la table `settings` (`POSTGRES_URL` accepté aussi) |
| `SETTINGS_ENCRYPTION_KEY` | Clé de déchiffrement des settings (identique à l'application Extensions) |
| `ONESTOCK_ENVIRONMENT` | *Optionnel.* Filtre `settings.environment` (sinon toutes les valeurs) |
| `EXTENSION_ID` | *Optionnel.* Restreint à cet `extension_id` |
| `ALLOWED_SITE_IDS` | *Fortement recommandé.* Liste des `site_id` autorisés |
| `OPENAI_API_KEY` | Clé API OpenAI |
| `OPENAI_MODEL` | *Optionnel.* Défaut `gpt-4o` |
| `FRAME_ANCESTORS` | *Optionnel.* Origines autorisées à intégrer l'iframe (défaut : domaines OneStock) |

### Onglet « Paramètres »

L'interface a deux onglets : **Assistant** et **Paramètres**. L'onglet Paramètres (`GET /api/settings`,
lecture seule, accessible à tout utilisateur de l'extension) affiche :

- le contexte : site, utilisateur et extension reçus de OneStock ;
- les connexions testées : base de données, API OneStock (recherche d'une commande) et API OpenAI (lecture du
  modèle, sans consommer de tokens) ;
- les lignes `onestock_token` / `onestock_api_root` retenues dans `settings` pour le site (portée, chiffrement) ;
- chaque variable d'environnement : définie, manquante ou valeur par défaut.

Les secrets ne sont jamais renvoyés au navigateur : seule leur présence est indiquée. Pour `ALLOWED_SITE_IDS`, l'onglet indique seulement le nombre de sites et si le site
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

Hors back-office, ouvrir `http://localhost:3000/?site_id=c42&lang=fr`. Sans `DATABASE_URL`, `ONESTOCK_API_ROOT` et
`ONESTOCK_TOKEN` remplacent la table `settings`.

```bash
npm test          # déchiffrement des settings, documents, dates
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
| `Aucun site OneStock…` | Pas de `site_id` dans l'URL ni dans le contexte OneStock : ajouter `?site_id=…`. |
| `Ce site n'est pas dans ALLOWED_SITE_IDS.` | Ajouter le site à `ALLOWED_SITE_IDS` sur Vercel puis redéployer. |
| `Cet extension_id ne correspond pas à EXTENSION_ID.` | Corriger ou vider `EXTENSION_ID`. |

## Sécurité

- **La signature de l'extension OneStock n'est pas vérifiée** : le serveur ne sait pas qui l'appelle. Toute
  personne qui connaît l'URL peut lire et modifier des commandes des sites autorisés avec le token stocké en
  base, et ouvrir les documents des colis. Limitez `ALLOWED_SITE_IDS` au strict nécessaire et protégez l'URL
  (par exemple Deployment Protection de Vercel).
- Le token OneStock reste côté serveur et n'est jamais envoyé au navigateur.
- Les appels OneStock utilisent l'utilisateur technique de `onestock_token` : les droits effectifs sont ceux
  de ce compte. Restreignez l'accès à l'extension par rôle dans la configuration de l'anchor.
- L'historique de conversation est conservé par le navigateur et renvoyé à chaque requête : il n'y a pas de
  stockage côté serveur.
