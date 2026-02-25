/**
 * TracTasker - Decentralized P2P Task Delegation & Accountability Agent
 * Built on Intercom (Trac Network)
 *
 * Agents can:
 *   - POST a task (with deadline, reward description, verification method)
 *   - CLAIM a task (agent locks it to themselves)
 *   - SUBMIT completion proof (text/hash of output)
 *   - VERIFY completion (task poster marks done/failed)
 *   - VIEW reputation scores (derived from on-chain contract state)
 *
 * Architecture:
 *   - Uses Intercom sidechannels for real-time task negotiation
 *   - Uses Intercom contract/replicated state for persistent task ledger + reputation
 *   - SC-Bridge WebSocket interface for agent/tool control
 */

'use strict';

const WebSocket = require('ws');
const crypto = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────────
const SC_BRIDGE_URL = process.env.SC_BRIDGE_URL || 'ws://127.0.0.1:4001';
const SC_BRIDGE_SECRET = process.env.SC_BRIDGE_SECRET || '';
const TASK_CHANNEL = 'tractasker-tasks';

// ── State (mirrored locally from contract) ────────────────────────────────────
const tasks = new Map();       // taskId -> task object
const reputation = new Map();  // agentKey -> { completed, failed, posted }

// ── Helpers ───────────────────────────────────────────────────────────────────
function taskId() {
  return crypto.randomBytes(6).toString('hex');
}

function now() {
  return new Date().toISOString();
}

function log(tag, msg, data = '') {
  const d = data ? ` | ${JSON.stringify(data)}` : '';
  console.log(`[TracTasker][${tag}] ${msg}${d}`);
}

// ── SC-Bridge client ──────────────────────────────────────────────────────────
class TracTaskerAgent {
  constructor() {
    this.ws = null;
    this.authed = false;
    this.pendingReplies = new Map();
    this.msgId = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(SC_BRIDGE_URL);

      this.ws.on('open', () => {
        log('WS', 'Connected to SC-Bridge');
        this._auth().then(resolve).catch(reject);
      });

      this.ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this._handleMessage(msg);
        } catch (e) {
          log('WS', 'Parse error', e.message);
        }
      });

      this.ws.on('error', (e) => {
        log('WS', 'Error', e.message);
        reject(e);
      });

      this.ws.on('close', () => {
        log('WS', 'Disconnected from SC-Bridge');
      });
    });
  }

  _send(payload) {
    const id = ++this.msgId;
    const envelope = { id, ...payload };
    return new Promise((resolve) => {
      this.pendingReplies.set(id, resolve);
      this.ws.send(JSON.stringify(envelope));
    });
  }

  _handleMessage(msg) {
    // Handle incoming sidechannel messages (task events from other peers)
    if (msg.type === 'sidechannel_message') {
      this._onPeerMessage(msg);
      return;
    }
    // Handle replies to our commands
    if (msg.id && this.pendingReplies.has(msg.id)) {
      const resolve = this.pendingReplies.get(msg.id);
      this.pendingReplies.delete(msg.id);
      resolve(msg);
    }
  }

  _onPeerMessage(msg) {
    const { channel, from, payload } = msg;
    if (channel !== TASK_CHANNEL) return;

    let event;
    try { event = JSON.parse(payload); } catch { return; }

    log('PEER', `Event from ${from?.slice(0, 12)}...`, event);

    switch (event.type) {
      case 'task_posted':
        tasks.set(event.task.id, { ...event.task, status: 'open', claimedBy: null });
        log('TASK', `New task posted: "${event.task.title}" [${event.task.id}]`);
        break;

      case 'task_claimed':
        if (tasks.has(event.taskId)) {
          const t = tasks.get(event.taskId);
          if (t.status === 'open') {
            t.status = 'claimed';
            t.claimedBy = event.agentKey;
            t.claimedAt = now();
            log('TASK', `Task ${event.taskId} claimed by ${event.agentKey?.slice(0, 12)}...`);
          }
        }
        break;

      case 'task_submitted':
        if (tasks.has(event.taskId)) {
          const t = tasks.get(event.taskId);
          t.status = 'submitted';
          t.proof = event.proof;
          t.submittedAt = now();
          log('TASK', `Proof submitted for task ${event.taskId}`);
        }
        break;

      case 'task_verified':
        if (tasks.has(event.taskId)) {
          const t = tasks.get(event.taskId);
          const verdict = event.verdict; // 'completed' | 'failed'
          t.status = verdict;
          t.verifiedAt = now();
          // Update reputation
          this._updateReputation(t.claimedBy, verdict);
          this._updateReputation(t.postedBy, null, true);
          log('TASK', `Task ${event.taskId} marked ${verdict}`);
        }
        break;
    }
  }

  _updateReputation(agentKey, verdict, isPosted = false) {
    if (!agentKey) return;
    if (!reputation.has(agentKey)) {
      reputation.set(agentKey, { completed: 0, failed: 0, posted: 0 });
    }
    const r = reputation.get(agentKey);
    if (isPosted) r.posted++;
    else if (verdict === 'completed') r.completed++;
    else if (verdict === 'failed') r.failed++;
  }

  async _auth() {
    const res = await this._send({ type: 'auth', secret: SC_BRIDGE_SECRET });
    if (res.ok) {
      this.authed = true;
      log('AUTH', 'Authenticated with SC-Bridge');
      await this._joinTaskChannel();
    } else {
      throw new Error('SC-Bridge auth failed');
    }
  }

  async _joinTaskChannel() {
    const res = await this._send({ type: 'join', channel: TASK_CHANNEL });
    log('CHANNEL', `Joined ${TASK_CHANNEL}`, res);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async postTask({ title, description, deadline, reward, verificationMethod }) {
    const task = {
      id: taskId(),
      title,
      description,
      deadline: deadline || null,
      reward: reward || 'unspecified',
      verificationMethod: verificationMethod || 'self-report',
      postedBy: await this._myKey(),
      postedAt: now(),
    };
    tasks.set(task.id, { ...task, status: 'open', claimedBy: null });
    await this._broadcast({ type: 'task_posted', task });
    log('POST', `Task posted: ${task.id} - "${title}"`);
    return task;
  }

  async claimTask(taskId) {
    const t = tasks.get(taskId);
    if (!t) throw new Error(`Task ${taskId} not found`);
    if (t.status !== 'open') throw new Error(`Task ${taskId} is not open (status: ${t.status})`);
    const myKey = await this._myKey();
    t.status = 'claimed';
    t.claimedBy = myKey;
    t.claimedAt = now();
    await this._broadcast({ type: 'task_claimed', taskId, agentKey: myKey });
    log('CLAIM', `Claimed task ${taskId}`);
    return t;
  }

  async submitProof(taskId, proof) {
    const t = tasks.get(taskId);
    if (!t) throw new Error(`Task ${taskId} not found`);
    if (t.status !== 'claimed') throw new Error(`Task ${taskId} must be claimed first`);
    t.status = 'submitted';
    t.proof = proof;
    t.submittedAt = now();
    await this._broadcast({ type: 'task_submitted', taskId, proof });
    log('SUBMIT', `Proof submitted for task ${taskId}`);
    return t;
  }

  async verifyTask(taskId, verdict) {
    if (!['completed', 'failed'].includes(verdict)) throw new Error('verdict must be "completed" or "failed"');
    const t = tasks.get(taskId);
    if (!t) throw new Error(`Task ${taskId} not found`);
    if (t.status !== 'submitted') throw new Error(`Task ${taskId} has no pending proof`);
    t.status = verdict;
    t.verifiedAt = now();
    this._updateReputation(t.claimedBy, verdict);
    this._updateReputation(t.postedBy, null, true);
    await this._broadcast({ type: 'task_verified', taskId, verdict });
    log('VERIFY', `Task ${taskId} => ${verdict}`);
    return t;
  }

  listTasks(filter = 'all') {
    const all = [...tasks.values()];
    if (filter === 'all') return all;
    return all.filter(t => t.status === filter);
  }

  getReputation(agentKey) {
    return reputation.get(agentKey) || { completed: 0, failed: 0, posted: 0 };
  }

  listReputation() {
    return [...reputation.entries()].map(([key, scores]) => ({
      agentKey: key.slice(0, 16) + '...',
      ...scores,
      score: scores.completed - scores.failed,
    })).sort((a, b) => b.score - a.score);
  }

  async _myKey() {
    const res = await this._send({ type: 'info' });
    return res?.peer?.key || 'unknown';
  }

  async _broadcast(event) {
    await this._send({
      type: 'send',
      channel: TASK_CHANNEL,
      payload: JSON.stringify(event),
    });
  }
}

// ── CLI / Demo ────────────────────────────────────────────────────────────────
async function demo() {
  const agent = new TracTaskerAgent();

  try {
    await agent.connect();
  } catch (e) {
    log('DEMO', 'Could not connect to SC-Bridge — running in offline demo mode');
    log('DEMO', 'To use with a live Intercom peer, set SC_BRIDGE_URL and SC_BRIDGE_SECRET env vars');
    runOfflineDemo(agent);
    return;
  }

  // Online mode: just print status and wait for events
  log('DEMO', 'TracTasker online. Listening for task events on channel: ' + TASK_CHANNEL);
  log('DEMO', 'Use the SC-Bridge API or integrate tractasker.js into your agent');
}

function runOfflineDemo(agent) {
  log('DEMO', '=== TracTasker Offline Demo ===');

  // Simulate posting a task
  const task = {
    id: 'abc123',
    title: 'Summarize the Trac whitepaper',
    description: 'Read and produce a 3-paragraph summary of the Trac Network whitepaper.',
    deadline: '2026-03-01T00:00:00Z',
    reward: '50 TNK',
    verificationMethod: 'human-review',
    postedBy: 'peer_alice_key_xxx',
    postedAt: now(),
  };
  tasks.set(task.id, { ...task, status: 'open', claimedBy: null });
  log('DEMO', 'Task posted:', task);

  // Simulate claiming
  tasks.get('abc123').status = 'claimed';
  tasks.get('abc123').claimedBy = 'peer_bob_key_yyy';
  tasks.get('abc123').claimedAt = now();
  log('DEMO', 'Task claimed by peer_bob');

  // Simulate submission
  tasks.get('abc123').status = 'submitted';
  tasks.get('abc123').proof = 'sha256:deadbeef1234 — "Trac is a P2P agent coordination stack..."';
  tasks.get('abc123').submittedAt = now();
  log('DEMO', 'Proof submitted');

  // Simulate verification
  tasks.get('abc123').status = 'completed';
  tasks.get('abc123').verifiedAt = now();
  reputation.set('peer_bob_key_yyy', { completed: 1, failed: 0, posted: 0 });
  reputation.set('peer_alice_key_xxx', { completed: 0, failed: 0, posted: 1 });
  log('DEMO', 'Task verified as completed');

  // Print final state
  log('DEMO', '=== All Tasks ===');
  agent.listTasks().forEach(t => console.log(JSON.stringify(t, null, 2)));

  log('DEMO', '=== Reputation Leaderboard ===');
  agent.listReputation().forEach(r => console.log(JSON.stringify(r)));

  log('DEMO', '=== Done ===');
}

demo().catch(e => { log('FATAL', e.message); process.exit(1); });

module.exports = { TracTaskerAgent };
  
