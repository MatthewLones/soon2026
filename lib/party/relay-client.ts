/**
 * Browser WebSocket client for the party relay. Handles:
 *   - reconnect with exponential backoff
 *   - persistent playerId in localStorage
 *   - typed send / typed onMessage
 *   - throttled state sends (10 Hz)
 *
 * Used by both the /party stage and the /m/[roomId] phone.
 */

import type { ClientMsg, ServerMsg } from './types';

export type RelayClientOptions = {
  url: string; // ws:// or wss://
  roomId: string;
  /** True for /party?host=1 — relay won't allocate an avatar. */
  host?: boolean;
  /** Required for first-time joiners; relay echoes on roster. */
  faceDataUrl?: string;
  /** Where to find/persist the playerId. Defaults to localStorage. */
  storage?: Storage | null;
  onMessage: (msg: ServerMsg) => void;
  onStatus?: (status: 'connecting' | 'open' | 'closed' | 'error') => void;
};

const STATE_TICK_MS = 100; // 10 Hz

export class RelayClient {
  private ws: WebSocket | null = null;
  private opts: RelayClientOptions;
  private storage: Storage | null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private stateTimer: ReturnType<typeof setInterval> | null = null;
  private pendingState: { x: number; z: number; yaw: number; waveSeq: number } | null = null;
  private lastSentState: { x: number; z: number; yaw: number; waveSeq: number } | null = null;

  constructor(opts: RelayClientOptions) {
    this.opts = opts;
    this.storage = opts.storage === undefined
      ? (typeof window !== 'undefined' ? window.localStorage : null)
      : opts.storage;
  }

  private playerIdKey(): string {
    return `party:playerId:${this.opts.roomId}`;
  }

  private getPlayerId(): string | undefined {
    return this.storage?.getItem(this.playerIdKey()) ?? undefined;
  }

  setPlayerId(id: string) {
    this.storage?.setItem(this.playerIdKey(), id);
  }

  open() {
    this.closed = false;
    this.connect();
  }

  private connect() {
    if (this.closed) return;
    this.opts.onStatus?.('connecting');
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.opts.onStatus?.('open');
      const hello: ClientMsg = {
        type: 'hello',
        roomId: this.opts.roomId,
        playerId: this.getPlayerId(),
        faceDataUrl: this.opts.faceDataUrl,
        host: this.opts.host,
      };
      ws.send(JSON.stringify(hello));
      this.startStateTimer();
    };

    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data) as ServerMsg;
      } catch {
        return;
      }
      if (msg.type === 'roster') {
        this.setPlayerId(msg.me.id);
      }
      this.opts.onMessage(msg);
    };

    ws.onerror = () => {
      this.opts.onStatus?.('error');
    };

    ws.onclose = () => {
      this.opts.onStatus?.('closed');
      this.stopStateTimer();
      this.ws = null;
      if (this.closed) return;
      const delay = Math.min(8000, 500 * 2 ** this.reconnectAttempt);
      this.reconnectAttempt += 1;
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  /** Send a message immediately (skips state throttling). */
  sendRaw(msg: ClientMsg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  /** Update the local "I want to broadcast this position" buffer. The 10 Hz
   *  timer flushes it. Called every render frame from the controller. */
  pushState(s: { x: number; z: number; yaw: number; waveSeq: number }) {
    this.pendingState = s;
  }

  private startStateTimer() {
    if (this.stateTimer) return;
    this.stateTimer = setInterval(() => this.flushState(), STATE_TICK_MS);
  }

  private stopStateTimer() {
    if (this.stateTimer) clearInterval(this.stateTimer);
    this.stateTimer = null;
  }

  private flushState() {
    if (this.opts.host) return; // host has no avatar
    if (!this.pendingState) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Skip if nothing meaningful changed (saves ~80% of bytes when idle).
    const last = this.lastSentState;
    const s = this.pendingState;
    if (
      last &&
      Math.abs(last.x - s.x) < 0.005 &&
      Math.abs(last.z - s.z) < 0.005 &&
      Math.abs(last.yaw - s.yaw) < 0.01 &&
      last.waveSeq === s.waveSeq
    ) {
      return;
    }
    this.lastSentState = { ...s };
    this.ws.send(
      JSON.stringify({
        type: 'state',
        x: s.x,
        z: s.z,
        yaw: s.yaw,
        waveSeq: s.waveSeq,
      } satisfies ClientMsg)
    );
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopStateTimer();
    this.ws?.close();
    this.ws = null;
  }
}
