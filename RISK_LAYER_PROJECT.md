# NEAR Hackathon — Risk Layer pour agents de trading autonomes

> Fichier à donner à l'agent de code (Claude Code, Codex...). Il contient le contexte, le périmètre, l'architecture, le backlog et les règles de travail.
> **Mise à jour 4 nov 2026 :** le projet s'appelle **Circuit Breaker** (repo `circuit-breaker`). Le site officiel indique désormais
> « Code written since the announcement counts » (la règle « pas de code avant le 1er nov » ci-dessous est obsolète).
> Le post de démo doit taguer **@NEARProtocol** et **#NEARHackathon**. Voir `README.md` pour l'état réel du code.

---

## 1. Contexte hackathon

- Site : https://nearhackathon.com/#tracks
- Dev : 1–14 nov 2026 (soumission avant le **14 nov, 23:59 UTC**). Résultats 16–18 nov.
- Prix payés en NEAR : grand prix 55K$, puis 10K / 3K / 2K$ par track (13 tracks).
- Jury : Illia Polosukhin (NEAR), a16z crypto, Helius, Electric Capital, Synthetix/Infinex, Dragonfly, cyber•Fund + Claude Code & Codex comme juges IA.
- Critères historiques (guide) : implémentation technique, design, impact, originalité, durabilité.
- Une seule soumission par équipe, plusieurs tracks cochables.

**Tracks ciblés (une soumission) :**
1. 06 — AI Security & Defense (principal)
2. 07 — Agent Economy
3. 01 — Unstoppable DeFi

**Livrables obligatoires :**
- Repo GitHub **public**, prototype fonctionnel
- Post public sur X : mentionner "built at NEAR HACKATHON" + vidéo ou screenshots
- Formulaire : nom du projet, lead, email, taille d'équipe, tracks, adresse wallet NEAR, lien repo, lien post X, description (20–2000 caractères)

---

## 2. Concept

**Nom : `Circuit Breaker`** (« Guardrail » est pris par un autre projet de la galerie)

Problème : donner de l'argent à un agent IA, c'est lui donner trop de pouvoir. Personne ne gère le risque d'un agent autonome comme le ferait une salle de marché.

Solution : une couche de gouvernance du risque entre l'agent et ses fonds.
- L'agent propose des ordres, le moteur de politiques les valide ou les bloque avant exécution.
- Les fonds sont protégés par des **limites on-chain** (clés à permissions restreintes, sous-comptes).
- Chaque décision (autorisée ou bloquée) est enregistrée avec sa raison et consultable dans un dashboard live.
- Stretch : attestation TEE pour prouver que la politique tourne bien dans un environnement vérifiable.

**Message pour le jury :** "Nous donnons à une IA un portefeuille avec des limites de risque de niveau institutionnel, appliquées par du code et non par la confiance."

---

## 3. Périmètre

### MVP (obligatoire, doit marcher pour la démo)
- [ ] Agent de trading simple (stratégie volontairement basique : le sujet est la couche de risque, pas l'alpha)
- [ ] Exécution via NEAR Intents (cross-chain), sur testnet si possible
- [ ] Moteur de politiques avec les règles ci-dessous
- [ ] Permissions on-chain limitées (function call key et/ou sous-compte dédié à l'agent)
- [ ] Journal de décisions (autorisé / bloqué + raison)
- [ ] Dashboard live
- [ ] Scénario de démo scripté qui montre au moins 3 blocages différents

### Stretch (seulement si le MVP est terminé et stable)
- [ ] Attestation TEE / exécution via NEAR AI Cloud
- [ ] Réputation d'agents (score basé sur le respect des politiques)
- [ ] Multi-agents sous un même budget de risque global
- [ ] Détection de scam / token suspect avant exécution

### Hors périmètre
- Optimiser la stratégie de trading
- Token propre, NFT, front de landing marketing élaboré

---

## 4. Moteur de politiques (spécification)

Chaque ordre proposé par l'agent est évalué par ces règles, dans cet ordre. Le premier échec bloque l'ordre et enregistre la raison.

| # | Règle | Paramètre | Comportement |
|---|-------|-----------|--------------|
| 1 | Kill-switch | flag global | Si actif, tout est bloqué |
| 2 | Whitelist d'actifs / paires | liste | Bloque les actifs hors liste |
| 3 | Taille max par ordre | % du capital | Bloque si dépassé |
| 4 | Exposition max par actif | % du capital | Bloque si dépassé |
| 5 | Levier max | x | Bloque si dépassé |
| 6 | Perte journalière max (drawdown daily) | % du capital | Au seuil : blocage des nouveaux ordres jusqu'à reset |
| 7 | Drawdown total max | % depuis le pic | Au seuil : kill-switch automatique |
| 8 | Fréquence max d'ordres | n / heure | Anti-boucle folle |
| 9 | Slippage max toléré | bps | Bloque si le devis dépasse |
| 10 | Fenêtres horaires autorisées | plages UTC | Bloque en dehors |

Ajouts depuis la rédaction de ce brief :
- **Reduce-only** : en cas de kill-switch / perte journalière / drawdown, les ventes d'une position détenue restent autorisées (règles 1, 2, 3, 6, 7 levées pour elles, trace dans `waived`).
- **Auto-flatten** : au drawdown max, toutes les positions sont vendues, même si l'agent ne propose plus rien (monitor toutes les 10 s).
- **Mode swarm** (optionnel) : 2 règles de plus, `agent_quarantine` et `agent_budget` (budget d'exposition et drawdown propres à chaque agent).

Exigences :
- Politiques définies dans un fichier de config versionné (JSON ou YAML), validé par schéma.
- Évaluation **pure et déterministe** (fonction sans effet de bbord) pour faciliter les tests unitaires.
- Chaque décision produit un objet : `{id, timestamp, ordre, verdict, règle_déclenchée, valeurs_observées, limite}`.

---

## 5. Architecture

```
┌─────────────┐   ordre proposé   ┌──────────────────┐   ordre validé   ┌────────────────┐
│ Agent (IA / │ ────────────────► │ Policy Engine    │ ───────────────► │ Exécuteur      │
│ stratégie)  │                   │ (règles §4)      │                  │ NEAR Intents   │
└─────────────┘                   └────────┬─────────┘                  └───────┬────────┘
                                           │ décisions                          │ résultats
                                           ▼                                    ▼
                                  ┌──────────────────┐                ┌────────────────┐
                                  │ Journal (DB/log) │ ◄──────────────│ État du compte │
                                  └────────┬─────────┘                └────────────────┘
                                           ▼
                                  ┌──────────────────┐
                                  │ Dashboard live   │
                                  └──────────────────┘
```

**Défense en profondeur (point clé du pitch) :**
- Couche 1 : politiques off-chain (flexibles, riches).
- Couche 2 : permissions on-chain (function call key limitée, sous-compte avec fonds plafonnés) qui tiennent même si la couche 1 est contournée ou compromise.

### Stack suggérée (à confirmer avec la doc, ne pas supposer)
- Agent + moteur de politiques : TypeScript (Node) ou Python
- Contrat éventuel : Rust (near-sdk) si nécessaire pour les limites on-chain
- Dashboard : Next.js ou page statique + API légère, WebSocket/SSE pour le live
- Persistance : SQLite ou fichier JSONL (simple et suffisant)
- LLM de l'agent : au choix, optionnel (la stratégie peut être à règles)

---

## 6. Structure du repo

```
/
├── README.md              # pitch, démo, instructions de lancement en < 5 commandes
├── HACKATHON.md           # copie du fichier officiel (voir §9)
├── policies/
│   ├── default.yaml
│   └── schema.json
├── packages/
│   ├── policy-engine/     # logique pure + tests
│   ├── agent/             # stratégie + boucle de décision
│   ├── executor/          # intégration NEAR Intents
│   └── dashboard/         # UI live
├── contracts/             # si limites on-chain custom
├── scripts/
│   └── demo.ts            # scénario de démo reproductible
└── docs/
    └── architecture.md
```

---

## 7. Backlog (14 jours)

**J1–2 : fondations**
- Lire la doc NEAR Intents, function call keys, sous-comptes, NEAR AI Cloud. Noter les limites réelles.
- Spike : un swap/ordre de bout en bout sur testnet, même codé en dur.
- Décision go/no-go sur le périmètre selon ce que l'exécution réelle permet.

**J3–5 : cœur**
- Moteur de politiques + tests unitaires (une règle = au moins un test passant et un test bloquant).
- Journal de décisions.
- Agent basique branché sur le moteur.

**J6–8 : on-chain**
- Permissions limitées (clé restreinte / sous-compte).
- Preuve que l'agent ne peut pas dépasser les limites même en contournant le moteur off-chain.

**J9–10 : dashboard**
- Vue live : positions, PnL, drawdown, décisions autorisées/bloquées avec raison.
- Bouton kill-switch.

**J11 : scénario de démo**
- Script reproductible : l'agent essaie 3–4 actions dangereuses (ordre trop gros, actif hors whitelist, boucle de trading, dépassement du drawdown) et le système bloque chacune visiblement.

**J12 : stretch (TEE / réputation) uniquement si tout le reste est vert**

**J13 : polish**
- README, vidéo de démo (60–90 s), screenshots, nettoyage du repo, vérification que tout se lance depuis zéro.

**J14 : soumission (ne pas attendre la dernière heure)**
- Repo public, post X, formulaire. Marge de sécurité : soumettre au plus tard le 14 nov à midi UTC.

---

## 8. Définition de "terminé" pour la démo

- Un inconnu clone le repo et lance la démo avec des instructions claires.
- Au moins 3 types de blocage sont visibles dans le dashboard avec leur raison.
- Le kill-switch coupe réellement l'agent.
- Les tests unitaires du moteur de politiques passent.
- Aucun secret (clé privée, seed, API key) dans le repo ni dans l'historique git.

---

## 9. Règles de travail pour l'agent de code

1. **Ne pas inventer d'API.** Pour NEAR Intents, function call keys, sous-comptes, NEAR AI Cloud : lire la doc officielle (docs.near.org, docs.near-intents.org, docs.near.ai) avant d'écrire du code. Si un point n'est pas vérifiable, le signaler plutôt que deviner.
2. **Télécharger `https://nearhackathon.com/HACKATHON.md`** au démarrage et le lire : il contient les règles et les étapes de soumission à jour. En cas de conflit avec ce fichier, il fait foi.
3. ~~Aucun code avant le 1er nov~~ : règle remplacée par le site (« code written since the announcement counts »).
4. **Testnet uniquement** pendant le dev. Jamais de fonds réels sans validation explicite de l'utilisateur.
5. **Secrets :** variables d'environnement, `.env` dans `.gitignore`, fournir un `.env.example`.
6. **Priorité :** MVP fonctionnel > stretch. Si un composant bloque plus de 4 h, proposer une alternative plus simple plutôt que s'acharner.
7. **Tests d'abord pour le moteur de politiques** (c'est le cœur de la valeur).
8. **Commits fréquents et propres** : le repo est évalué publiquement.
9. **Ne pas soumettre ni poster à la place de l'utilisateur** sans son accord explicite.

---

## 10. Checklist de soumission

- [ ] Repo public, README clair, lancement reproductible
- [ ] Vidéo de démo (60–90 s) + screenshots
- [ ] Post X : "built at NEAR HACKATHON" + vidéo/screenshots
- [ ] Wallet NEAR du lead prêt (adresse pour le prix)
- [ ] Formulaire : tracks 06, 07, 01 cochés
- [ ] Description 20–2000 caractères
- [ ] Soumis avant le 14 nov 2026, 23:59 UTC (objectif : midi UTC)

---

## 11. Pitch (description de soumission, brouillon)

> Guardrail est une couche de gouvernance du risque pour agents de trading autonomes sur NEAR. L'agent propose, un moteur de politiques de niveau institutionnel (taille de position, levier, drawdown, fréquence, slippage, kill-switch) valide ou bloque, et des permissions on-chain limitées garantissent que même un agent compromis ne peut pas vider ses fonds. Chaque décision est tracée et visible en direct. Le but : donner de l'argent à une IA sans lui donner toutes les clés.
