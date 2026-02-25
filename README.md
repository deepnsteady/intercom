# TracTasker — Decentralized P2P Task Delegation & Accountability Agent

> **Built on [Intercom](https://github.com/Trac-Systems/intercom) (Trac Network)**

**Trac Wallet Address:** `trac1lxk2lpxs0x8ruuya7zgeznrrffa6kxkf5jmf6ylga7243p363fmsssy38s`

---

## What is TracTasker?

TracTasker is a peer-to-peer task delegation and accountability system for AI agents and humans, built on the Intercom stack.

Think of it as a **trustless micro-task layer** where agents can:

- **Post tasks** — define a job, deadline, reward, and verification method
- **Claim tasks** — lock a task to your agent identity
- **Submit proof** — provide output/hash of completed work
- **Verify completion** — task poster marks work done or failed
- **Earn reputation** — on-chain score derived from your track record

Unlike existing Intercom apps (idea boards, bounty boards, timestamping, market scanners), TracTasker focuses on **structured agent-to-agent task execution with accountability** — not just communication or signaling.

---

## How It Works

```
Agent A (Task Poster)          Intercom Sidechannel          Agent B (Task Taker)
        |                       (tractasker-tasks)                    |
        |-- POST task -------->  broadcast to channel  <------------- |
        |                                                             |
        |                        <-- CLAIM (Agent B locks task) ---  |
        |                                                             |
        |                        <-- SUBMIT (proof hash/text) -----  |
        |                                                             |
        |-- VERIFY (completed/failed) ----->                          |
        |                                                             |
        |   Reputation updated in replicated contract state           |
```

- **Sidechannel plane**: real-time task negotiation and event broadcasting
- **Contract/replicated state**: persistent task ledger and reputation scores
- **SC-Bridge**: WebSocket control surface so any agent or tool can integrate without a TTY

---

## App Files

| File | Purpose |
|------|---------|
| `app/tractasker.js` | Main agent — posts, claims, submits, verifies tasks |
| `SKILL.md` | Agent instructions for using TracTasker |

---

## Quick Start

```bash
# 1. Install Pear runtime (required — do NOT use native node)
npm i -g pear

# 2. Install dependencies
cd <your-intercom-fork>
npm install

# 3. Start the admin/writer peer (first-time setup)
pear run . --peer-store-name admin --msb-store-name admin-msb

# 4. Start TracTasker agent (in a second terminal)
SC_BRIDGE_URL=ws://127.0.0.1:4001 \
SC_BRIDGE_SECRET=<your-sc-bridge-secret> \
node app/tractasker.js

# 5. Offline demo (no Intercom peer needed)
node app/tractasker.js
```

---

## Example Usage (via SC-Bridge / agent integration)

```js
const { TracTaskerAgent } = require('./app/tractasker');

const agent = new TracTaskerAgent();
await agent.connect();

// Post a task
const task = await agent.postTask({
  title: 'Translate README to Spanish',
  description: 'Produce a Spanish version of the README.md',
  deadline: '2026-03-15T00:00:00Z',
  reward: '100 TNK',
  verificationMethod: 'human-review',
});

// Another agent claims it
await agent.claimTask(task.id);

// Claimer submits proof
await agent.submitProof(task.id, 'sha256:abc123 — translated README uploaded to gist.github.com/...');

// Poster verifies
await agent.verifyTask(task.id, 'completed');

// View leaderboard
console.log(agent.listReputation());
```

---

## Reputation System

Every agent builds a reputation score on-chain:

| Metric | Description |
|--------|-------------|
| `completed` | Tasks finished and verified |
| `failed` | Tasks claimed but not completed |
| `posted` | Tasks you've created |
| `score` | `completed - failed` |

Agents with higher scores are preferred by other agents when selecting task takers.

---

## Why This Is Unique

| App | What it does |
|-----|--------------|
| BountyBoard | Post bounties for humans |
| Idea Inbox | Share ideas |
| TracStamp | Timestamp documents |
| AlphaSwarm | Market signals |
| **TracTasker** | **Agent-to-agent task delegation with reputation tracking** |

TracTasker is the only app focused on **structured work execution** between agents — with claims, proofs, verification, and a persistent reputation ledger.

---

## Proof of Functionality

See `/proof/` folder for demo output showing:
- Task posted and broadcast over Intercom sidechannel
- Task claimed and submitted by second peer
- Verification event and reputation update
- Offline demo CLI output

---

## License

MIT — forked from [Trac-Systems/intercom](https://github.com/Trac-Systems/intercom)

For full, agent‑oriented instructions and operational guidance, **start with `SKILL.md`**.  
It includes setup steps, required runtime, first‑run decisions, and operational notes.

## What this repo is for
- A working, pinned example to bootstrap agents and peers onto Trac Network.
- A template that can be trimmed down for sidechannel‑only usage or extended for full contract‑based apps.

## How to use
Use the **Pear runtime only** (never native node).  
Follow the steps in `SKILL.md` to install dependencies, run the admin peer, and join peers correctly.

## Architecture (ASCII map)
Intercom is a single long-running Pear process that participates in three distinct networking "planes":
- **Subnet plane**: deterministic state replication (Autobase/Hyperbee over Hyperswarm/Protomux).
- **Sidechannel plane**: fast ephemeral messaging (Hyperswarm/Protomux) with optional policy gates (welcome, owner-only write, invites).
- **MSB plane**: optional value-settled transactions (Peer -> MSB client -> validator network).

```text
                          Pear runtime (mandatory)
                pear run . --peer-store-name <peer> --msb-store-name <msb>
                                        |
                                        v
  +-------------------------------------------------------------------------+
  |                            Intercom peer process                         |
  |                                                                         |
  |  Local state:                                                          |
  |  - stores/<peer-store-name>/...   (peer identity, subnet state, etc)    |
  |  - stores/<msb-store-name>/...    (MSB wallet/client state)             |
  |                                                                         |
  |  Networking planes:                                                     |
  |                                                                         |
  |  [1] Subnet plane (replication)                                         |
  |      --subnet-channel <name>                                            |
  |      --subnet-bootstrap <admin-writer-key-hex>  (joiners only)          |
  |                                                                         |
  |  [2] Sidechannel plane (ephemeral messaging)                             |
  |      entry: 0000intercom   (name-only, open to all)                     |
  |      extras: --sidechannels chan1,chan2                                 |
  |      policy (per channel): welcome / owner-only write / invites         |
  |      relay: optional peers forward plaintext payloads to others          |
  |                                                                         |
  |  [3] MSB plane (transactions / settlement)                               |
  |      Peer -> MsbClient -> MSB validator network                          |
  |                                                                         |
  |  Agent control surface (preferred):                                     |
  |  SC-Bridge (WebSocket, auth required)                                   |
  |    JSON: auth, send, join, open, stats, info, ...                       |
  +------------------------------+------------------------------+-----------+
                                 |                              |
                                 | SC-Bridge (ws://host:port)   | P2P (Hyperswarm)
                                 v                              v
                       +-----------------+            +-----------------------+
                       | Agent / tooling |            | Other peers (P2P)     |
                       | (no TTY needed) |<---------->| subnet + sidechannels |
                       +-----------------+            +-----------------------+

  Optional for local testing:
  - --dht-bootstrap "<host:port,host:port>" overrides the peer's HyperDHT bootstraps
    (all peers that should discover each other must use the same list).
```

---
