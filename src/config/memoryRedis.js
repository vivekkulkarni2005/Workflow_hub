'use strict';

/**
 * A tiny in-process substitute for Redis.
 *
 * It implements the (small) command surface this codebase relies on so the exact
 * same application code can run without a Redis server during unit tests and
 * CI. Semantics deliberately mirror Redis for the supported commands:
 *   - SET key value EX seconds / PX milliseconds
 *   - GET / SET / SETEX / DEL / EXISTS / INCR / DECR
 *   - EXPIRE / PEXPIRE / TTL / PERSIST
 *   - SCAN + KEYS
 *   - PUBLISH / SUBSCRIBE / PSUBSCRIBE (+ the ioredis *Buffer event variants)
 *   - MULTI (promise-chained, executed in order)
 *
 * `duplicate()` returns a second client over the SAME keyspace, exactly like a
 * second TCP connection to a real Redis — which is what Socket.io's Redis
 * adapter needs (a dedicated subscriber connection).
 */
class MemoryRedis {
  constructor() {
    this.store = new Map(); // key -> { value, expiresAt|null }
    this.sets = new Map(); // key -> Set<string>
    this.channels = new Map(); // channel -> Set<MemoryRedis>
    this.patterns = new Map(); // glob pattern -> Set<MemoryRedis>
    this.handlers = new Map(); // event name -> Set<fn>
    this.closed = false;
    this.status = 'ready';
  }

  static now() {
    return Date.now();
  }

  #live(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= MemoryRedis.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  #write(key, value, ttlMs) {
    if (this.closed) throw new Error('Connection is closed.');
    this.store.set(key, {
      value: String(value),
      expiresAt: ttlMs ? MemoryRedis.now() + ttlMs : null,
    });
    return 'OK';
  }

  #multi() {
    const chain = [];
    const push = (fn) => (...args) => {
      chain.push(() => fn(...args));
      return api;
    };
    const api = {
      get: push((key) => this.get(key)),
      set: push((key, value, mode, ttl) => this.set(key, value, mode, ttl)),
      incr: push((key) => this.incr(key)),
      incrby: push((key, n) => this.incrby(key, n)),
      decr: push((key) => this.decr(key)),
      sadd: push((...args) => this.sadd(...args)),
      srem: push((...args) => this.srem(...args)),
      pexpire: push((key, ms) => this.pexpire(key, ms)),
      expire: push((key, s) => this.expire(key, s)),
      del: push((...keys) => this.del(...keys)),
      ttl: push((key) => this.ttl(key)),
      exec: async () =>
        // Real Redis returns one [err, value] tuple per queued command, already
        // resolved — so each queued result must be awaited here too.
        Promise.all(
          chain.map(async (fn) => {
            try {
              return [null, await fn()];
            } catch (err) {
              return [err, null];
            }
          })
        ),
    };
    return api;
  }

  async get(key) {
    const entry = this.#live(key);
    return entry ? entry.value : null;
  }

  async set(key, value, mode, ttl) {
    let ttlMs = null;
    if (mode === 'EX') ttlMs = Number(ttl) * 1000;
    else if (mode === 'PX') ttlMs = Number(ttl);
    else if (mode !== undefined && mode !== null) {
      throw new Error(`Unsupported SET mode: ${mode}`);
    }
    return this.#write(key, value, ttlMs);
  }

  async setex(key, seconds, value) {
    return this.#write(key, value, seconds * 1000);
  }

  async incr(key) {
    return this.incrby(key, 1);
  }

  async incrby(key, amount = 1) {
    const entry = this.#live(key);
    const next = (entry ? Number(entry.value) : 0) + Number(amount);
    if (!Number.isFinite(next)) throw new Error('value is not an integer or out of range');
    // INCR must preserve the key's existing TTL, exactly like Redis does.
    this.#write(key, next, entry ? remainingTtl(entry) : null);
    return next;
  }

  async decr(key) {
    return this.incrby(key, -1);
  }

  async del(...keys) {
    let removed = 0;
    for (const key of keys.flat()) {
      if (this.#live(key)) removed += 1;
      this.store.delete(key);
      this.sets.delete(key);
    }
    return removed;
  }

  async exists(key) {
    return this.#live(key) ? 1 : 0;
  }

  async expire(key, seconds) {
    return this.pexpire(key, seconds * 1000);
  }

  async pexpire(key, ms) {
    const entry = this.#live(key);
    if (!entry) return 0;
    entry.expiresAt = MemoryRedis.now() + ms;
    return 1;
  }

  async persist(key) {
    const entry = this.#live(key);
    if (!entry) return 0;
    entry.expiresAt = null;
    return 1;
  }

  async ttl(key) {
    const entry = this.#live(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.max(0, Math.ceil((entry.expiresAt - MemoryRedis.now()) / 1000));
  }

  async pttl(key) {
    const entry = this.#live(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.max(0, entry.expiresAt - MemoryRedis.now());
  }

  /* ----------------------------- sets ----------------------------- */

  async sadd(key, ...members) {
    const set = this.sets.get(key) ?? new Set();
    let added = 0;
    for (const m of members.flat()) {
      if (!set.has(String(m))) {
        set.add(String(m));
        added += 1;
      }
    }
    this.sets.set(key, set);
    return added;
  }

  async srem(key, ...members) {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members.flat()) if (set.delete(String(m))) removed += 1;
    return removed;
  }

  async smembers(key) {
    return [...(this.sets.get(key) ?? [])];
  }

  async sismember(key, member) {
    return this.sets.get(key)?.has(String(member)) ? 1 : 0;
  }

  async keys(pattern) {
    const re = globToRegExp(pattern);
    return [...this.store.keys()].filter((k) => re.test(k) && this.#live(k));
  }

  async scan(cursor, ...args) {
    const [pattern] = args;
    const re = globToRegExp(pattern || '*');
    const all = [...this.store.keys()].filter((k) => re.test(k) && this.#live(k));
    return ['0', all];
  }

  async publish(channel, message) {
    const payload = String(message);
    let delivered = 0;

    // Redis delivers a PUBLISH to both exact-channel and matching-pattern
    // subscribers; the adapter relies on that.
    for (const client of this.channels.get(channel) ?? []) {
      client.#deliver('message', channel, payload);
      client.#deliver('messageBuffer', channel, payload);
      delivered += 1;
    }
    for (const [pattern, clients] of this.patterns) {
      if (!globToRegExp(pattern).test(channel)) continue;
      for (const client of clients) {
        client.#deliver('pmessage', pattern, channel, payload);
        client.#deliver('pmessageBuffer', pattern, channel, payload);
        delivered += 1;
      }
    }
    return delivered;
  }

  #deliver(event, ...args) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  #add(map, name, cb) {
    if (!map.has(name)) map.set(name, new Set());
    map.get(name).add(this);
    if (typeof cb === 'function') cb(null);
    return 1;
  }

  #remove(map, name) {
    map.get(name)?.delete(this);
    return 1;
  }

  async subscribe(...channels) {
    for (const channel of channels.flat()) this.#add(this.channels, channel);
    return channels.flat().length;
  }

  async unsubscribe(...channels) {
    for (const channel of channels.flat()) this.#remove(this.channels, channel);
    return 1;
  }

  /* ioredis exposes both casings; Socket.io's adapter feature-detects `pSubscribe`. */
  async psubscribe(...patterns) {
    for (const pattern of patterns.flat()) this.#add(this.patterns, pattern);
    return patterns.flat().length;
  }

  async pSubscribe(...patterns) {
    return this.psubscribe(...patterns);
  }

  async punsubscribe(...patterns) {
    for (const pattern of patterns.flat()) this.#remove(this.patterns, pattern);
    return 1;
  }

  async pUnsubscribe(...patterns) {
    return this.punsubscribe(...patterns);
  }

  messageHandler() {}

  multi() {
    return this.#multi();
  }

  duplicate() {
    const copy = new MemoryRedis();
    copy.store = this.store; // share the keyspace, like a real Redis connection
    copy.sets = this.sets;
    copy.channels = this.channels;
    copy.patterns = this.patterns;
    return copy;
  }

  on(event, handler) {
    if (typeof handler !== 'function') return this;
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(handler);
    if (event === 'message') this.messageHandler = handler;
    return this;
  }

  once(event, handler) {
    const wrapped = (...args) => {
      this.off(event, wrapped);
      handler(...args);
    };
    return this.on(event, wrapped);
  }

  off(event, handler) {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  removeListener(event, handler) {
    return this.off(event, handler);
  }

  ping() {
    return Promise.resolve('PONG');
  }

  flushall() {
    this.store.clear();
    this.sets.clear();
    return Promise.resolve('OK');
  }

  quit() {
    for (const clients of this.channels.values()) clients.delete(this);
    for (const clients of this.patterns.values()) clients.delete(this);
    this.closed = true;
    this.status = 'end';
    return Promise.resolve('OK');
  }

  disconnect() {
    return this.quit();
  }
}

function remainingTtl(entry) {
  if (entry.expiresAt === null) return null;
  return Math.max(0, entry.expiresAt - MemoryRedis.now());
}

function globToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

module.exports = MemoryRedis;
