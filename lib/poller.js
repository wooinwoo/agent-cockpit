/**
 * @typedef {Object} CacheEntry
 * @property {*} data - Cached data
 * @property {string} raw - JSON-stringified data for change detection
 * @property {number} timestamp - When cached
 * @property {number} ttl - Time-to-live in ms
 */

/**
 * Periodic data poller with SSE broadcast and adaptive speed control.
 */
export class Poller {
  constructor() {
    this.cache = new Map();
    this.sseClients = new Set();
    this.intervalMap = new Map();
    this.errorCounts = new Map();
    this._speedMultiplier = 1; // 1 = normal, >1 = slower (adaptive)
  }

  /**
   * Register a polling task.
   * @param {string} name - Unique poller name
   * @param {() => Promise<*>} fetchFn - Async function to fetch data
   * @param {number} interval - Polling interval in ms
   * @param {string} eventName - SSE event name to broadcast
   */
  register(name, fetchFn, interval, eventName) {
    if (this.intervalMap.has(name)) {
      clearInterval(this.intervalMap.get(name));
    }

    const poll = async () => {
      // 구독자(SSE 클라)가 없으면 폴링을 쉰다 — 앱을 안 보는 동안에도 프로젝트별
      // git status/exec·SQLite 조회가 서버 CPU·디스크를 계속 먹던 것을 방지.
      // 최초 1회(캐시 없음)는 웜업 겸 실행하고, 재접속 시 init 이벤트가 캐시를 내려준다.
      if (this.sseClients.size === 0 && this.cache.has(name)) return;
      try {
        const data = await fetchFn();
        const prev = this.cache.get(name);
        const dataStr = JSON.stringify(data);

        // Reset error count on success
        this.errorCounts.set(name, 0);

        if (!prev || prev.raw !== dataStr) {
          this.cache.set(name, { data, raw: dataStr, timestamp: Date.now(), ttl: interval * 2 });
          this.broadcast(eventName, data);
        }
      } catch (err) {
        const count = (this.errorCounts.get(name) || 0) + 1;
        this.errorCounts.set(name, count);
        if (count <= 3) {
          console.error(`[Poller] ${name}: ${err.message} (${count}/3)`);
        } else if (count === 4) {
          console.error(`[Poller] ${name}: suppressing further errors`);
        }
      }
    };

    poll();
    const adaptiveInterval = () => Math.round(interval * this._speedMultiplier);
    // Use dynamic interval via recursive setTimeout instead of fixed setInterval
    const scheduleNext = () => {
      const timerId = setTimeout(async () => {
        await poll();
        this.intervalMap.set(name, scheduleNext());
      }, adaptiveInterval());
      return timerId;
    };
    this.intervalMap.set(name, scheduleNext());
  }

  /**
   * Set adaptive speed multiplier (1 = normal, >1 = slower).
   * @param {number} multiplier - Speed multiplier, clamped to [1, 10]
   */
  setSpeed(multiplier) {
    this._speedMultiplier = Math.max(1, Math.min(multiplier, 10));
  }

  /** @param {string} name */
  unregister(name) {
    if (this.intervalMap.has(name)) {
      clearTimeout(this.intervalMap.get(name));
      this.intervalMap.delete(name);
    }
    this.cache.delete(name);
    this.errorCounts.delete(name);
  }

  /**
   * Broadcast SSE event to all connected clients.
   * @param {string} event - SSE event name
   * @param {*} data - Data to JSON-serialize
   */
  broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const dead = [];
    for (const res of this.sseClients) {
      try {
        if (res.writableEnded || res.destroyed) { dead.push(res); continue; }
        res.write(msg);
      } catch {
        dead.push(res);
      }
    }
    for (const res of dead) this.sseClients.delete(res);
  }

  /**
   * @param {string} name
   * @returns {*|null}
   */
  getCached(name) {
    const entry = this.cache.get(name);
    if (!entry) return null;
    return entry.data;
  }

  /**
   * @param {string} prefix - Key prefix to match
   * @returns {Object<string, *>} Map of suffix → data
   */
  getAllCached(prefix) {
    const result = {};
    for (const [key, entry] of this.cache) {
      if (key.startsWith(prefix)) {
        result[key.replace(prefix, '')] = entry.data;
      }
    }
    return result;
  }

  /** @param {import('node:http').ServerResponse} res */
  addClient(res) {
    // M8: Limit max SSE clients to prevent resource exhaustion
    if (this.sseClients.size >= 50) {
      // Close the oldest client
      const oldest = this.sseClients.values().next().value;
      try { oldest.end(); } catch { /* client already disconnected */ }
      this.sseClients.delete(oldest);
    }
    this.sseClients.add(res);
  }

  /** @param {import('node:http').ServerResponse} res */
  removeClient(res) {
    this.sseClients.delete(res);
  }

  /** Stop all polling tasks. */
  stop() {
    for (const id of this.intervalMap.values()) clearTimeout(id);
    this.intervalMap.clear();
  }
}
