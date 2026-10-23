/**
 * WebSocket 客户端：断线自动重连（指数退避 + 抖动）、心跳、状态回调。
 * 现场网络抖动、路由器重启后大屏可自愈，无需人工刷新。
 */

export class ReconnectingSocket {
  /**
   * @param {string} url
   * @param {{role?:string, onEvent?:(msg:any)=>void, onStatus?:(status:string)=>void, heartbeatMs?:number, maxDelay?:number}} opts
   */
  constructor(url, { role = 'wall', onEvent = () => {}, onStatus = () => {}, heartbeatMs = 20_000, maxDelay = 15_000 } = {}) {
    this.url = url;
    this.role = role;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.heartbeatMs = heartbeatMs;
    this.maxDelay = maxDelay;
    this.ws = null;
    this.retry = 0;
    this.closedByUser = false;
    this.status = 'idle';
    this.heartbeatTimer = null;
    this.retryTimer = null;
    this.lastMessageAt = 0;
  }

  connect() {
    this.closedByUser = false;
    this._open();
  }

  _open() {
    this._setStatus(this.retry === 0 ? 'connecting' : 'reconnecting');
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this._scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this._setStatus('open');
      this._send({ type: 'hello', role: this.role, ua: navigator.userAgent.slice(0, 120) });
      this._startHeartbeat();
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg && msg.type === 'pong') return;
      this.onEvent(msg);
    };
    ws.onerror = () => {
      // onclose 会跟着触发，这里只记录
    };
    ws.onclose = () => {
      this._stopHeartbeat();
      this.ws = null;
      if (this.closedByUser) {
        this._setStatus('closed');
        return;
      }
      this._scheduleRetry();
    };
  }

  _scheduleRetry() {
    this._setStatus('reconnecting');
    const delay = Math.min(this.maxDelay, 400 * Math.pow(1.7, this.retry)) * (0.7 + Math.random() * 0.6);
    this.retry++;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (!navigator.onLine) {
        this._scheduleRetry();
        return;
      }
      this._open();
    }, delay);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this._send({ type: 'ping', t: Date.now() });
      // 超过 3 个心跳周期没有任何消息，主动重连
      if (this.lastMessageAt && Date.now() - this.lastMessageAt > this.heartbeatMs * 3.5) {
        try {
          this.ws?.close();
        } catch {}
      }
    }, this.heartbeatMs);
  }

  _stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(obj));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  send(obj) {
    return this._send(obj);
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status);
  }

  close() {
    this.closedByUser = true;
    clearTimeout(this.retryTimer);
    this._stopHeartbeat();
    try {
      this.ws?.close();
    } catch {}
    this._setStatus('closed');
  }
}

export function wallSocketPath(role) {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=${role}`;
}
