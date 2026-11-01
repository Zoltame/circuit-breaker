# Notes de cadrage pré-hackathon (20 oct 2026)

## J1 — 1er nov : ce qui a changé et ce qui est prouvé

**HACKATHON.md en ligne mis à jour** (copie locale rafraîchie). Nouveautés qui nous concernent :
- Post X : doit taguer **@NEARProtocol** et **#NEARHackathon** (optionnel @NearLegion, @NearBuilders). Conseils : 1re ligne = problème utilisateur, montrer un moment complet, rôle concret de NEAR, appel à feedback.
- Q-010 : projets testnet éligibles ; mainnet seulement si l'intégration est mainnet-only → notre option A est explicitement OK. Q-007 confirme : pas de testnet Intents, `dry: true` recommandé.
- Q-012 : **vidéo obligatoire** si les juges ne peuvent pas ouvrir la démo ; démo hébergée = bonus, à garder en ligne jusqu'au 18 nov (idéalement 25 nov).
- Q-014 : fichier **LICENSE** requis (MIT ajouté). Q-005 : lister les libs dans le README.
- Q-017 : Claude Code / Codex font un pré-screening (reproductibilité, vérification des features, score préliminaire). Les humains décident.
- Unicité désormais par **repo** (et max 2 soumissions par email), plus par nom.
- Q-006 : sans JWT 1Click, frais de 0,2 % (et non 0,25 %).
- Exemple de prompt du track security : démo d'**agent victime de prompt injection** qui tente de payer une adresse malveillante et se fait bloquer → à intégrer dans notre scénario de démo. Expliquer les limites de la FC key dans le README.

**Agents on Intents / Agent API** (docs.agentsonintents.com, mainnet only) : wallets d'agents avec politiques (caps par actif/heure/jour/mois, budget USD brut, destinations, horaires, timelock, freeze). **Aucune règle de portefeuille** (drawdown, exposition %, levier, slippage) → confirme le positionnement de Circuit Breaker.

**Spikes réussis :**
- `pnpm spike:1click` : 210 tokens ; devis dry 1 wNEAR → 4,2480 USDC (4,26 $ en entrée), 408 ms, sans clé. `minAmountOut` = −0,5 % (slippage demandé). Coût observé ≈ 0,3 % (frais sans JWT inclus).
- `pnpm spike:near` : FC key ajoutée au compte agent (scope `guestbook.near-examples.testnet` / `add_message`, allowance 0,25 NEAR). Résultats : appel autorisé OK ; +1 yocto → « Deposit is not allowed with function call » ; autre contrat → « Access key receiver … does not match ». À vérifier : le refus du dépôt vient-il du client (near-api-js) ou de la chaîne ? Pour la démo « preuve on-chain », il faudra un rejet visible on-chain.
- Choix techniques : pnpm workspaces, TypeScript 6.0.3 (TS 7.0 sorti le 1er nov, évité), near-api-js 7.4.0, tsx.

Recherche doc faite avant le démarrage du code (1er nov 00:00 UTC). Aucune ligne de code projet écrite.
Sources : docs.near.org, docs.near-intents.org, docs.near.ai, app.outlayer.ai/docs, HACKATHON.md officiel.

---

## 1. Ce que le HACKATHON.md officiel change par rapport au cahier des charges

- **IDs de tracks pour la soumission** : `security`, `agents`, `defi`.
- Soumission par **API** `POST https://nearhackathon.com/api/applications` (ou formulaire #apply), **une seule tentative**, non modifiable. Payload imprimé et validé par l'humain avant envoi.
- Champ `size` : valeurs exactes `1`, `2 - 4`, `4 - 6`, `6 - 8`, `8+`.
- Compte NEAR **mainnet** du lead requis pour le prix (à créer par l'équipe, jamais par l'agent).
- README à écrire **aussi pour un lecteur IA** : quoi, quel problème, étapes « fais X → tu vois Y ». Pas de marketing.
- Hints du track `security` : AGENT SECURITY, **FUNCTION CALL KEYS**, **TEE ATTESTATION** → à nommer dans le README.

## 2. Découvertes bloquantes / structurantes

### 2.1 NEAR Intents n'a PAS de testnet ⚠️
> « There is no testnet deployment. Use small amounts for testing purposes. » (docs.near-intents.org, Verifier introduction)

Conflit direct avec la règle « testnet uniquement ». **Décision utilisateur requise** (voir §5).

### 2.2 Une function call key ne peut attacher AUCUN dépôt (même 1 yocto)
- FC key = un seul contrat (`receiver_id`), méthodes optionnelles, `allowance` = gas uniquement.
- Or déposer sur `intents.near` (`ft_transfer_call`) et `add_public_key` exigent 1 yoctoNEAR.
- ⇒ L'agent ne peut pas trader directement avec une FC key. **Il faut un contrat "vault"** qui détient les fonds, applique les plafonds on-chain, et que l'agent appelle via une FC key restreinte à ses méthodes (`propose_swap`, etc.). C'est le contrat qui attache les dépôts.
- Sous-comptes : le parent n'a **aucun contrôle** après création, pas de plafond protocolaire. Le plafond = « le vault ne détient que X ».
- Gas keys (NEP-611) : n'ajoutent pas de dépôts aux FC keys. Pas de solution miracle.

### 2.3 Chemin alternatif : intents signés off-chain (NEP-413)
Si les fonds sont déjà dans `intents.near` : `POST /v0/generate-intent` → signature off-chain → `POST /v0/submit-intent` (clé partenaire requise). La clé de l'agent est enregistrée dans le Verifier via `add_public_key`.
Défense on-chain possible : `remove_public_key` pour révoquer la clé de l'agent = kill-switch on-chain. *(inférence, à vérifier)*

### 2.4 OutLayer recoupe une partie du MVP
OutLayer (partenaire officiel) fait déjà : wallets d'agents dans TEE (Intel TDX), politiques chiffrées on-chain (plafonds par tx/heure/jour, whitelist, fenêtres horaires, rate limit, capacités `swap`), `freeze_wallet()`, audit log, attestation par exécution. **Testnet OK** pour transfer/call/policy, **mais swaps/intents = mainnet uniquement** (503 sur testnet).
Ce qu'OutLayer ne fait pas : risque **de portefeuille** (exposition par actif, drawdown journalier/total sur PnL marqué, levier, slippage sur devis).
⇒ Positionnement recommandé : **Guardrail = couche de risque portefeuille au-dessus des limites de flux**, pas un concurrent. Différenciateur à mettre en avant dans le pitch.

### 2.5 NEAR AI Cloud (stretch TEE)
- API OpenAI-compatible `https://cloud-api.near.ai/v1`, inférence en TEE (modèles open-weight). **Payant (crédits), pas de free tier trouvé.**
- Attestation : `GET /v1/attestation/report` + vérif Intel DCAP (`dcap-qvl`), repos exemples `near-examples/nearai-cloud-verification-example`.
- **Ne fait pas tourner de code arbitraire** → pour « la politique tourne dans un TEE », c'est OutLayer (WASM en TDX) qui convient, pas NEAR AI Cloud.

## 3. Faits techniques vérifiés (référence rapide)

| Élément | Valeur | Source |
|---|---|---|
| Verifier mainnet | `intents.near` | docs.near-intents.org |
| 1Click API | `https://1click.chaindefuser.com` (`/v0/tokens`, `/v0/quote`, `/v0/status`, `/v0/deposit/submit`) | idem |
| Devis sans risque | `POST /v0/quote` avec `dry: true` → `amountOut`, `minAmountOut`, `amountOutUsd`… sans adresse de dépôt | idem |
| Slippage | `slippageTolerance` en bps | idem |
| Auth 1Click | optionnelle ; sans JWT = +0,25 % de frais. JWT via Partner Portal (`X-API-Key`) | idem |
| SDK TS | `@defuse-protocol/one-click-sdk-typescript`, `@defuse-protocol/intents-sdk` | idem |
| JS NEAR | `near-api-js` ou `near-kit` (doc ne tranche pas) | docs.near.org/tools/near-api |
| CLI | `npm i -g near-cli-rs@latest` ; `near create-account <id> --useFaucet --networkId testnet` | docs.near.org/tools/cli |
| RPC testnet | `https://test.rpc.fastnear.com` | docs.near.org/api/rpc/providers |
| Contrats Rust | `cargo near new`, `cargo near build non-reproducible-wasm` ; testé rustc 1.86, cargo-near 0.16.1 | quickstart |
| OutLayer testnet | `https://testnet-api.outlayer.ai`, contrat `outlayer.testnet` | app.outlayer.ai/docs |

À vérifier J1 : versions npm exactes, `near-sdk` version, repos d'exemples.

## 4. Architecture révisée proposée

```
Agent ──ordre──► Policy Engine (off-chain, pur, règles §4) ──► Exécuteur
                     │                                          │
                     ▼                                          ▼
                 Journal ◄──────────────────────────── Vault contract (testnet)
                     │                                  - plafond par ordre / jour on-chain
                     ▼                                  - whitelist tokens on-chain
                 Dashboard                              - kill-switch on-chain (owner)
                                                        - agent = FC key restreinte
```
- **Couche 2 on-chain = vault contract Rust sur testnet** : c'est la preuve « même si le moteur off-chain est contourné, l'agent ne peut pas dépasser X ». Démontrable à 100 % sur testnet.
- **Prix / slippage** : devis 1Click réels (`dry: true`, mainnet, zéro fonds).
- **Exécution** : voir décision §5.

## 5. Décisions à prendre par l'humain avant J1

1. **Exécution NEAR Intents** (pas de testnet) — ✅ **Option A retenue le 20 oct**. Options étudiées :
   - **A (recommandé)** : testnet pour le vault + permissions ; devis 1Click réels en `dry: true` ; exécution simulée (paper trading) au prix du devis. Optionnel en fin de projet : 1 swap mainnet réel de quelques $ pour la vidéo, avec ton accord explicite.
   - B : mainnet avec petits montants dès J1 (plus « réel », mais risque fonds + exception à la règle testnet).
   - C : tout via OutLayer (wallet + policy) → swaps mainnet-only aussi.
2. **Intégrer OutLayer ou non** (comme couche de flux sous Guardrail, ou juste le citer comme complémentaire).
3. **Langage** : TypeScript partout (recommandé : SDK 1Click et intents en TS) + Rust pour le vault.
4. ✅ **Nom du projet : Circuit Breaker** (choisi le 20 oct, remplace « Guardrail »). **À vérifier le 1er nov** : disponibilité du nom de repo GitHub et d'un nom de domaine.
   - ✅ Handle X réservé le 20 oct : **@cbreaker_ai** (compte dédié au projet) → pour le post de démo.
   - Vérifié le 20 oct (compte GitHub `Zoltame`) : repos `circuit-breaker`, `circuitbreaker`, `cbreaker-ai` libres.
   - Domaines (RDAP, 20 oct) : **non enregistrés** → `cbreaker.ai`, `cbreaker.dev`, `circuit-breaker.ai` ; **pris** → `circuitbreaker.ai/.xyz/.dev`, `cbreaker.xyz`. `.io` non vérifiable par RDAP.
   - ✅ **Décision 20 oct : pas de domaine.** Dashboard public hébergé sur Vercel → `circuit-breaker.vercel.app` (ou `circuit-breaker-<suffixe>.vercel.app` si le nom est pris ; à vérifier au déploiement). `cbreaker.ai` éventuellement après le hackathon.
   - Repo prévu : `Zoltame/circuit-breaker` (privé jusqu'à la publication).
   - ✅ Compte Vercel créé (offre Hobby, connexion GitHub `Zoltame`, accès limité aux repos choisis). Aucun projet importé. CLI `vercel` à installer au moment du déploiement, connexion faite par l'utilisateur.
5. **Clé partenaire 1Click** (JWT) : utile pour éviter +0,25 % et pour `generate-intent`/`submit-intent`. À obtenir sur le **Partner Dashboard : https://partners.near-intents.org/home** (action humaine). Header `X-API-Key`. Avec clé : ~20 bps (1 bp stablecoins). → `.env`, jamais dans le repo.
   Type de clé à demander : **Distribution Channel** (= 1Click). ✅ Créée par l'utilisateur le 20 oct (gardée hors repo, à mettre dans `.env` le 1er nov). Clé Shield : pas encore demandée.
6. ✅ Wallet mainnet du lead créé (Meteor) le 20 oct.

### NEAR Intents SHIELD (découvert le 20 oct)
- Couche de sécurité **de la plateforme** Intents/1Click (pannes de chaînes, bridges, tokens, flux suspects), avec des modes `normal` / `paranoid` / `under_attack`. **Pas** un limiteur de risque par agent : rien sur la taille, l'exposition, le drawdown ou le slippage → pas de doublon fonctionnel avec Circuit Breaker.
- Lecture : `GET https://shield.chaindefuser.com/incident` → `{"status":"operational"}` ou une liste d'incidents `{scopeType: chain|bridge|token|address, scopeValue, direction, ...}`. Auth `Authorization: Bearer <jwt>` (clé de type SHIELD). Doc : docs.near-intents.org/security-compliance/proactive-intents-security.md et shield-incident-api.md
- **Idée d'intégration (règle 0 du moteur)** : si un incident SHIELD actif touche la chaîne ou le token de l'ordre → blocage. Signal externe de kill-switch, bon argument pour les tracks `security` et `defi`.
- ⚠️ Le Partner Dashboard décrit les clés Shield comme des « Adaptive circuit-breaker keys » → risque de confusion avec notre nom. À expliciter dans le README : « Circuit Breaker = risque de portefeuille par agent ; SHIELD = sécurité de l'infrastructure, que nous consommons ».

## 6bis. État de l'environnement (installé le 20 oct)

| Outil | Version | Note |
|---|---|---|
| pnpm | 12.14.0 | |
| near-cli-rs | 0.30.1 | config : `%APPDATA%\near-cli\config.toml` |
| rustup / rustc | 1.99.1 stable (+ wasm32) | le template `cargo near new` épingle **1.93.0** via `rust-toolchain.toml` |
| cargo-near | 0.22.0 | |
| VS 2022 Build Tools (VCTools) | MSVC 14.44 | linker OK |
| NASM | installé dans `%LOCALAPPDATA%\bin\NASM` (pas dans le PATH) | |

Résultats du test de compilation (template `cargo near new`, dans le scratchpad, hors projet) :
- ✅ `cargo near build non-reproducible-wasm --no-abi` → `.wasm` OK sous Windows.
- ❌ Génération ABI sous Windows : erreur `link.exe 1120` (symboles hôtes NEAR non résolus dans une DLL MSVC). ⇒ utiliser `--no-abi` sous Windows, ou builder sous Linux/Docker.
- ❌ `cargo test` (tests d'intégration near-workspaces/sandbox) : chaîne de dépendances natives (aws-lc-sys → NASM, openssl-sys → OpenSSL) et le sandbox NEAR n'a a priori pas de binaire Windows.
  ⇒ **Décision : tests du contrat dans un conteneur Linux (Docker)**, ou tests unitaires purs + tests directs sur testnet.
- ✅ **Docker (image `rust:1.93`) : `cargo test` complet OK** — 7 tests unitaires + 1 test d'intégration sandbox (~39 s), ABI comprise. Commande type :
  `docker run --rm -v "<dossier>:/work" -w /work -e CARGO_TARGET_DIR=/tmp/target rust:1.93 bash -c "rustup target add wasm32-unknown-unknown && <installer cargo-near .sh> && cargo test"`
  ⇒ À transformer en script/Dockerfile réutilisable le 1er nov (cacher l'install de cargo-near dans l'image).

### Comptes testnet (créés le 20 oct via faucet, 10 NEAR chacun, clés dans le trousseau Windows via near-cli)
- `guardrail-vault-sqjpi.testnet` → déploiement du contrat vault
- `guardrail-agent-sqjpi.testnet` → agent (recevra une function call key restreinte au vault)

## 6. Préparation d'environnement (autorisé avant le 1er nov)

Déjà présent : Node 24, npm 11, Python 3.11, git, gh, Docker.
Manquant :
- Rust + target wasm : `rustup` puis `rustup target add wasm32-unknown-unknown`
- `cargo-near` (installer officiel)
- `near-cli-rs` : `npm i -g near-cli-rs@latest`
- pnpm (optionnel, monorepo) : `npm i -g pnpm`
- Compte testnet pour le vault + un pour l'agent (`--useFaucet`)
- Compte NEAR **mainnet** du lead pour le prix (à créer par toi dans un wallet)
- Compte X prêt pour le post de démo
