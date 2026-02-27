import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { fetchCsrfToken, watchView } from './tiltClient';
import type { UIResource, WebViewFrame } from './tiltClient';
import type { Logger } from './logger';

// ─── Public types ────────────────────────────────────────────────────────────

export type TiltStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Flattened, display-ready representation of a UIResource. */
export interface UIResourceItem {
  name: string;
  runtimeStatus: string;
  updateStatus: string;
  links: Array<{ name: string; url: string }>;
  order: number;
  labels: Array<{ key: string; value: string }>;
  buildSpanId?: string;
  runtimeSpanId?: string;
}

export interface TiltManagerConfig {
  port: number;
  pollInterval: number;
  tiltfilePath: string;
  tiltArgs: string[];
  autoForwardUI: boolean;
}

// ─── TiltManager ─────────────────────────────────────────────────────────────

/**
 * Manages the lifecycle of a Tilt WebSocket connection.
 *
 * Emits:
 *   'statusChange'    (status: TiltStatus)
 *   'resourcesChange' (resources: UIResourceItem[])
 */
export class TiltManager extends EventEmitter implements vscode.Disposable {
  private _status: TiltStatus = 'disconnected';
  private _resources: UIResourceItem[] = [];

  private _watchAbort: AbortController | undefined;
  private _terminal: vscode.Terminal | undefined;

  constructor(
    private config: TiltManagerConfig,
    private readonly log: Logger,
  ) {
    super();
  }

  get status(): TiltStatus {
    return this._status;
  }

  get resources(): UIResourceItem[] {
    return this._resources;
  }

  updateConfig(config: TiltManagerConfig): void {
    this.config = config;
  }

  // ── Connection management ──────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') {
      return;
    }
    this.log.info(`Connecting to Tilt at http://localhost:${this.config.port}/`);
    this.setStatus('connecting');

    let token: string;
    try {
      token = await fetchCsrfToken(this.config.port);
      this.log.info(`CSRF token fetched — opening WebSocket`);
    } catch (err) {
      this.log.error(
        `Failed to fetch CSRF token from http://localhost:${this.config.port}/api/websocket_token`,
        err,
      );
      this.setStatus('error');
      return;
    }

    this.setStatus('connected');
    this.startWatch(token);
  }

  disconnect(): void {
    this.log.info('Disconnected');
    this.stopWatch();
    this._resources = [];
    this.setStatus('disconnected');
    this.emit('resourcesChange', this._resources);
  }

  // ── Tilt process management ────────────────────────────────────────────────

  /** Launches `tilt up` in a dedicated VS Code terminal. */
  startTilt(workspaceRoot: string): void {
    if (this._terminal) {
      this._terminal.show();
      return;
    }

    const tiltfileArg = this.config.tiltfilePath
      ? `--file "${this.config.tiltfilePath}"`
      : '';
    const extraArgs = this.config.tiltArgs.join(' ');
    const cmd = ['tilt up', tiltfileArg, extraArgs].filter(Boolean).join(' ');

    this.log.info(`Starting Tilt in terminal (${workspaceRoot}): ${cmd}`);

    this._terminal = vscode.window.createTerminal({
      name: 'TiltShift',
      cwd: workspaceRoot,
    });
    this._terminal.sendText(cmd);
    this._terminal.show();

    // Watch for terminal close
    const disposable = vscode.window.onDidCloseTerminal((t) => {
      if (t === this._terminal) {
        this._terminal = undefined;
        disposable.dispose();
        if (this._status === 'connected') {
          this.log.warn('Tilt terminal closed — disconnecting');
          this.disconnect();
        }
      }
    });
  }

  /** Sends Ctrl-C to the Tilt terminal. */
  stopTilt(): void {
    this.log.info('Stopping Tilt (sending Ctrl-C)');
    if (this._terminal) {
      this._terminal.sendText('', false); // ensure focus
      this._terminal.sendText('\x03');    // Ctrl-C
    }
    this.disconnect();
  }

  // ── Internal watch management ──────────────────────────────────────────────

  private startWatch(token: string): void {
    this.stopWatch();
    this._watchAbort = new AbortController();
    this.log.info('WebSocket watch stream starting');

    this.runWatchLoop(token, this._watchAbort.signal).catch((err: unknown) => {
      if (this._watchAbort?.signal.aborted) {
        // Clean shutdown — not an error
        return;
      }
      this.log.error('WebSocket watch stream failed', err instanceof Error ? err : undefined);
      this.setStatus('error');
    });
  }

  private async runWatchLoop(token: string, signal: AbortSignal): Promise<void> {
    for await (const frame of watchView(this.config.port, token, signal, this.log)) {
      if (signal.aborted) break;
      this.applyViewFrame(frame);
    }

    if (!signal.aborted && this._status === 'connected') {
      // Stream ended unexpectedly — reconnect after a short delay
      this.log.info('WebSocket stream ended, reconnecting in 2 s');
      await new Promise<void>((res) => setTimeout(res, 2000));
      if (!signal.aborted && this._status === 'connected') {
        void this.connect();
      }
    }
  }

  private applyViewFrame(frame: WebViewFrame): void {
    // Process resources first so span type registrations are available before log routing
    if (frame.uiResources) {
      let upserted = 0;
      let removed = 0;

      for (const raw of frame.uiResources) {
        const item = toUIResourceItem(raw);

        if (item.runtimeStatus === 'none' && item.updateStatus === 'none') {
          // Tilt signals this resource is gone
          const before = this._resources.length;
          this._resources = this._resources.filter((r) => r.name !== item.name);
          if (this._resources.length < before) removed++;
        } else {
          const idx = this._resources.findIndex((r) => r.name === item.name);
          if (idx >= 0) {
            this._resources[idx] = item;
          } else {
            this._resources.push(item);
          }
          upserted++;
        }
      }

      this._resources.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
      this.log.info(`WS frame: ${upserted} upserted, ${removed} removed`);
      this.emit('resourcesChange', this._resources);
    }

    if (frame.logList) {
      this.emit('logList', frame.logList);
    }
  }

  private stopWatch(): void {
    this._watchAbort?.abort();
    this._watchAbort = undefined;
  }

  private setStatus(s: TiltStatus): void {
    if (s !== this._status) {
      this._status = s;
      this.emit('statusChange', s);
    }
  }

  dispose(): void {
    this.stopWatch();
    this._terminal?.dispose();
    this.removeAllListeners();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toUIResourceItem(r: UIResource): UIResourceItem {
  const status = r.status ?? {};
  return {
    name: r.metadata?.name ?? '(unknown)',
    runtimeStatus: status.runtimeStatus ?? '',
    updateStatus: status.updateStatus ?? '',
    links: (status.endpointLinks ?? [])
      .filter((l) => l.url)
      .map((l) => ({ name: l.name ?? l.url ?? '', url: l.url ?? '' })),
    order: status.order ?? 0,
    labels: Object.entries(r.metadata?.labels ?? {}).map(([key, value]) => ({ key, value })),
    buildSpanId: status.currentBuild?.spanID ?? status.buildHistory?.[0]?.spanID,
    runtimeSpanId: status.k8sResourceInfo?.spanID,
  };
}
