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
| `get_item` | `GET /v3/items` (filtre `ids`) : détail d'articles par identifiant | lecture |
| `get_item_stock` | `GET /v1/stock_export` : stock par article et point de stock (vue `onestock_stock_request_name` de `settings`, `detailed` par défaut) | lecture |
| `search_items` | `GET /v3/items` (catalogue : motif, product_ids, caractéristiques) | lecture |
| `cancel_order` | `PATCH /v2/line_item_groups` : toutes les lignes → `removed` (une transition par état actuel) | **écriture** |
| `update_order_state` | `PATCH /v3/orders/{id}` (`order.from` → `order.to`) | **écriture** |
| `check_shipping_address_change` | `GET /v3/orders/{id}` (statut) : adresse de livraison modifiable ou non | lecture |
| `update_order` | `PATCH /v3/orders/{id}` (client, adresse de livraison `delivery.destination.address`, adresse de facturation `pricing_details.address`, informations) | **écriture** |
| `update_line_item_groups_state` | `PATCH /v2/line_item_groups` | **écriture** |

Les GET OneStock prennent un corps JSON : ils sont envoyés en `POST` avec `X-HTTP-Method-Override: GET`, comme
le prévoit la documentation de l'API. `site_id` et `token` sont ajoutés par le serveur.

**Documents des colis** : `get_order_parcels` ajoute à chaque colis des liens `document_links` vers
`/api/documents/{id}?site_id=…`. Cette route lit `GET /v3/documents/{id}` et renvoie le fichier, ou à défaut
l'aperçu en image contenu dans la réponse, pour l'ouvrir dans un onglet.
La facture d'une commande est l'URL stockée dans `information.invoice` de la commande. L'assistant l'affiche via
`/api/invoices/{commande}?site_id=…`, qui ajoute un commentaire à la commande puis redirige vers le PDF.

**Commentaires de commande** : l'extension ajoute un commentaire (`POST /v2/orders/{id}/comments`,
`{ "order_comment": { "comment": … } }`, préfixé « Assistant commandes : ») quand le chat est ouvert sur une commande (anchor `bo.order.action`) et quand
une facture est consultée. Cette route est marquée « internal » dans la spec OneStock : en cas de refus,
l'action de l'utilisateur continue et l'échec est journalisé (`[comments]`).

**Annulation d'une commande** : `cancel_order` lit les lignes de la commande, ignore celles déjà à `removed`
et demande la transition `état actuel → removed` pour chaque état. Si OneStock refuse une transition (erreur 4xx),
ces lignes ne sont pas modifiées et une alerte l'indique : annulation impossible (« le statut de la commande ne
permet plus l'annulation ») ou partielle (lignes annulées / lignes refusées, avec leur état).

**Nouvelle adresse** : elle doit être fournie par l'utilisateur. Avant d'afficher la carte de confirmation, le
serveur vérifie que l'adresse proposée est complète (rue, code postal, ville, pays) et différente de l'adresse
actuelle ; sinon aucune carte n'est affichée et l'assistant demande l'adresse à l'utilisateur.

**Adresse de livraison** : elle n'est modifiable que si la commande n'est pas au statut `fulfilled`. Dès la
demande de l'utilisateur, l'assistant appelle `check_shipping_address_change` (alerte immédiate et pas de
demande d'adresse si c'est impossible) ; le statut est revérifié avant la carte de confirmation, et `update_order`
le relit juste avant l'écriture ; s'il vaut `fulfilled`, rien n'est envoyé à OneStock et une alerte
l'indique (statuts bloquants : `SHIPPING_ADDRESS_LOCKED_STATES` dans `server/utils/tools.ts`).

**Fiches articles** : `get_order` renvoie le nom, la description et l'image de chaque article
(`order_items.item.features.*`, dans la langue de l'utilisateur) ; si OneStock refuse ces caractéristiques, la
commande est relue sans elles.

**Aucune écriture sans confirmation** : quand le modèle demande une action d'écriture, le serveur s'arrête et
l'interface affiche une carte « Action à confirmer » : un récapitulatif rédigé pour un utilisateur métier
(phrase explicative, client, adresses de livraison et de facturation présentées comme sur une fiche). L'appel à OneStock n'est fait
qu'après clic sur **Confirmer** ; un refus est renvoyé au modèle, qui n'insiste pas.

### Cartes articles et réservation

Les articles renvoyés par `get_order`, `get_order_items_details`, `get_item` et `search_items` s'affichent en
cartes sous la réponse : vignette, nom, « prix | couleur », référence (et quantité pour une commande). Le serveur
les extrait des réponses OneStock (`server/utils/products.ts`, dans la langue de l'utilisateur puis
`default_lang`) et les envoie au navigateur (événement `products`). Quand l'image, le prix ou le nom manquent, il
relit la fiche article complète (`GET /v3/items`, toutes les caractéristiques) : l'image est cherchée sous les noms
usuels (`image_url`, `image`…), puis sous tout nom évoquant une image, puis parmi les URL d'image ; le prix sous
`price`, une caractéristique contenant « price »/« prix », puis le prix par canal de vente (un prix à 0 est ignoré).

Sur un résultat de recherche, le bouton **Commander** lance une commande en livraison à domicile ou en retrait
en magasin payé en ligne (l'assistant demande le mode), et le bouton **Réserver** lance la création d'une commande, en proposant d'abord
l'e-réservation en magasin (`create_order`, mode `reservation` : type `ropis`, payé au retrait). L'assistant :
1. cherche les magasins qui ont l'article en stock (`find_stores_with_stock` : stock `on_hand` d'au moins la
   quantité demandée, magasin ouvert, module `ropis` pour la réservation ou `ckc` pour le retrait) et les affiche
   sur une **carte du pays** (Leaflet), avec la liste des magasins et leur stock ; un clic sur **Choisir**
   sélectionne le magasin ;
2. demande la quantité, le magasin et le client (nom, prénom, email ou téléphone) ;
3. reprend le prix de la fiche article ;
4. présente un récapitulatif (articles, total, client, magasin) à confirmer, puis crée la commande
   (`POST /v3/orders`).

Les modes `click_and_collect` (types `ffs`, `ckc`) et `home_delivery` (type `ffs`, adresse obligatoire) sont aussi
disponibles. La commande n'est pas proposée tant qu'il manque un prix, le client, le magasin ou l'adresse.

Le fond de carte est OpenStreetMap par défaut ; pour un autre fournisseur de tuiles, définir
`NUXT_PUBLIC_MAP_TILES_URL` (modèle `…/{z}/{x}/{y}.png`) et `NUXT_PUBLIC_MAP_ATTRIBUTION`. Les serveurs de tuiles
d'OpenStreetMap sont limités à un usage modéré : pour un usage intensif, utiliser un fournisseur dédié.

### Langue des réponses

L'assistant répond dans la langue de la question (dernier message de l'utilisateur), quelle que soit la langue
de l'interface OneStock. Les textes fixes de l'interface (boutons, alertes, cartes de confirmation) suivent la
langue de l'interface.

### Toutes les API OneStock (catalogue)

En plus des outils dédiés aux commandes, l'assistant peut utiliser toutes les routes de l'API OneStock (fiches
articles et produits, création de commande, zones et routes de livraison, transporteurs, points de stock,
canaux de vente, clients, retours, paiements, capacités, règles…) grâce à trois outils génériques :

| Outil | Rôle |
|---|---|
| `find_api_operations` | Recherche d'une route par mots-clés (français ou anglais), méthode ou catégorie |
| `describe_api_operation` | Documentation d'une route : champs obligatoires, schéma du corps, exemple |
| `call_onestock_api` | Appel de la route : GET exécuté directement, POST/PUT/PATCH/DELETE après confirmation |

Pour une création ou une modification, l'assistant lit la documentation de la route, demande à l'utilisateur
les informations obligatoires manquantes (en langage métier), retrouve lui-même les identifiants existants
(points de stock, transporteurs…), puis propose l'action avec un récapitulatif à confirmer. Le serveur refuse
d'envoyer une demande dont un champ obligatoire manque ou qui contient un champ inconnu, et tronque les réponses
trop volumineuses.

Les routes d'authentification et de droits d'accès (catégories Authentication, Access Control List, gateway ;
chemins contenant login, password, token…) ne sont pas exposées.

Le catalogue `server/data/onestock-api.json` est généré à partir de la spécification OpenAPI :

```bash
pip install pyyaml
python3 scripts/build_api_catalog.py chemin/vers/APIInterneOneStock.yaml
```

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
| `SETTINGS_API_URL` | URL de l'API Settings de l'application Extensions, ex. `https://extensions-lemon.vercel.app/api/settings` (source recommandée) |
| `SETTINGS_API_KEY` | Clé d'API du chatbot, ajoutée à `SETTINGS_API_KEYS` de l'application Extensions |
| `SETTINGS_EXTENSION_ID` | *Optionnel.* `extension_id` propre au chatbot dans `settings`, prioritaire sur `*` |
| `DATABASE_URL` | *Sans API Settings.* Accès direct à la base contenant `settings` (`POSTGRES_URL` accepté aussi) |
| `SETTINGS_ENCRYPTION_KEY` | *Sans API Settings.* Clé de déchiffrement des settings (identique à l'application Extensions) |
| `ONESTOCK_ENVIRONMENT` | *Recommandé.* Environment à utiliser (`qualif`, `prod`…) ; sinon celui de l'`onestock_api_root` retenue |
| `EXTENSION_ID` | *Optionnel.* Restreint à cet `extension_id` |
| `ALLOWED_SITE_IDS` | *Fortement recommandé.* Liste des `site_id` autorisés |
| `OPENAI_API_KEY` | Clé API OpenAI |
| `OPENAI_MODEL` | *Optionnel.* Défaut `gpt-4o` |
| `FRAME_ANCESTORS` | *Optionnel.* Origines autorisées à intégrer l'iframe (défaut : domaines OneStock) |

### Onglet « Paramètres »

L'interface a deux onglets : **Assistant** et **Paramètres**. L'onglet Paramètres (`GET /api/settings`,
lecture seule, accessible à tout utilisateur de l'extension) affiche :

- le contexte : site, utilisateur et extension reçus de OneStock ;
- les connexions testées : API Settings (ou base de données), API OneStock (recherche d'une commande) et API OpenAI (lecture du
  modèle, sans consommer de tokens) ;
- les lignes `onestock_token` / `onestock_api_root` retenues dans `settings` pour le site (portée, chiffrement) ;
- chaque variable d'environnement : définie, manquante ou valeur par défaut.

Les secrets ne sont jamais renvoyés au navigateur : seule leur présence est indiquée. Pour `ALLOWED_SITE_IDS`, l'onglet indique seulement le nombre de sites et si le site
courant en fait partie. Les variables d'environnement se modifient dans Vercel (puis redéploiement), les valeurs OneStock dans l'application Extensions.

#### Lecture des settings

**Token par `parent_url` (prioritaire)** : chaque environnement OneStock a son propre token, identifié par le
`parent_url` du contexte de l'extension (page du back-office qui affiche l'iframe, par exemple
`https://admin.eu1.qualif.onestock-retail.com`). Le navigateur transmet `parent_url` (et `api_url` reçue dans
`onestock_data`) au serveur, qui appelle `GET …/api/settings/token?parent_url=…&decrypt=1&site_id=…` : la réponse
donne le token et `api_root`, l'URL de l'API OneStock à appeler (le `parent_url` n'est jamais appelé). Il n'y a
aucun repli sur un autre token : sans token saisi pour ce `parent_url`, l'erreur demande de le saisir dans
l'application Extensions (Settings → Token OneStock). Seul un `parent_url` en https sur un hôte OneStock est
accepté. Le cache (5 min) est propre à chaque `parent_url`. Les liens de documents et de factures emportent le
`parent_url` pour rester sur le même environnement.

Sans `parent_url` (ouverture hors back-office), les règles ci-dessous s'appliquent.


Avec `SETTINGS_API_URL` + `SETTINGS_API_KEY`, les settings sont lus par l'API Settings de l'application Extensions
(`GET …/api/settings?key=…&decrypt=1`, token déjà déchiffré : `SETTINGS_ENCRYPTION_KEY` est inutile côté chatbot).
Sinon, ils sont lus directement dans la table (`DATABASE_URL`). Pour chaque clé, une seule ligne est retenue :

1. **environment** : `ONESTOCK_ENVIRONMENT` ; à défaut, celui de l'`onestock_api_root` retenue. Le token et l'URL
   viennent donc toujours du même environment (un token de prod n'est jamais envoyé à l'API de qualif) ;
2. **extension** : `SETTINGS_EXTENSION_ID` puis `*` ; les lignes des autres extensions sont ignorées ;
3. **site** : la ligne du site puis la ligne globale (`site_id` vide ou `*`).

L'onglet Paramètres liste toutes les lignes avec la raison pour laquelle chacune est utilisée ou ignorée.

`onestock_stock_request_name` (facultative) est la vue de stock OneStock (OMC > Configuration > Stock > Stock
Queries) utilisée pour consulter le stock ; sans ligne dans `settings`, la vue `detailed` est utilisée. `default_lang` (facultative) est la langue des fiches
articles quand celle de l'utilisateur n'est pas disponible (puis français). Pour
l'initialiser :

```sql
INSERT INTO settings (key, value, site_id, environment) VALUES ('onestock_stock_request_name', 'detailed', '*', 'qualif');
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
- Avec le catalogue complet, l'assistant peut créer, modifier ou supprimer toute ressource accessible au compte
  du token (zones, routes, règles, points de stock…), toujours après confirmation de l'utilisateur.
- Les appels OneStock utilisent l'utilisateur technique de `onestock_token` : les droits effectifs sont ceux
  de ce compte. Restreignez l'accès à l'extension par rôle dans la configuration de l'anchor.
- L'historique de conversation est conservé par le navigateur et renvoyé à chaque requête : il n'y a pas de
  stockage côté serveur.
