import * as http from 'http';
import WebSocket from 'ws';
import type { Logger } from './logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UIResourceLink {
  name?: string;
  url?: string;
}

export interface UIResourceStatus {
  runtimeStatus?: string;
  updateStatus?: string;
  endpointLinks?: UIResourceLink[];
  order?: number;
}

export interface UIResource {
  metadata?: { name?: string };
  status?: UIResourceStatus;
}

/** Top-level shape of a WebSocket frame from /ws/view. */
export interface WebViewFrame {
  uiResources?: UIResource[];
}

// ─── CSRF token fetch ─────────────────────────────────────────────────────────

/**
 * Fetches the CSRF token required for the /ws/view WebSocket connection.
 * Tilt returns a raw string (not JSON) from this endpoint.
 */
export function fetchCsrfToken(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = `http://localhost:${port}/api/websocket_token`;
    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`CSRF token request failed: HTTP ${res.statusCode ?? 'unknown'}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve(body.trim()));
    });
    req.on('error', reject);
  });
}

// ─── WebSocket view stream ────────────────────────────────────────────────────

/**
 * Opens a WebSocket to /ws/view and yields parsed WebViewFrame objects.
 *
 * The stream ends when:
 *   - the AbortSignal fires (clean shutdown)
 *   - the server closes the connection (will re-throw so the caller can reconnect)
 *
 * Each frame is a JSON object that *sometimes* contains a `uiResources` array
 * with the full current snapshot of all Tilt resources.
 */
export async function* watchView(
  port: number,
  token: string,
  signal: AbortSignal,
  log?: Logger,
): AsyncGenerator<WebViewFrame> {
  const url = `ws://localhost:${port}/ws/view?csrf=${encodeURIComponent(token)}`;

  // ── Channel: bridge WS events → async generator ──────────────────────────

  type QueueItem = WebViewFrame | null; // null = end-of-stream sentinel
  const queue: QueueItem[] = [];
  let notify: (() => void) | undefined;
  let wsError: Error | undefined;

  const wake = (): void => {
    const fn = notify;
    notify = undefined;
    fn?.();
  };

  const ws = new WebSocket(url);

  ws.on('open', () => {
    log?.info(`WS connected to ${url}`);
  });

  ws.on('message', (data: WebSocket.RawData) => {
    const raw = data.toString();
    let frame: WebViewFrame;
    try {
      frame = JSON.parse(raw) as WebViewFrame;
    } catch (err) {
      log?.warn(`WS frame: failed to parse JSON — ${String(err)}`);
      return;
    }

    if (frame.uiResources !== undefined) {
      log?.info(`WS frame received — uiResources: ${frame.uiResources.length}`);
    } else {
      log?.warn('WS frame received — no uiResources field');
    }

    queue.push(frame);
    wake();
  });

  ws.on('error', (err: Error) => {
    log?.error('WS error', err);
    wsError = err;
    wake();
  });

  ws.on('close', (code: number, reason: Buffer) => {
    const reasonStr = reason.toString() || '(no reason)';
    if (code === 1000 || code === 1001) {
      log?.info(`WS closed (code ${code}: ${reasonStr})`);
    } else {
      log?.warn(`WS closed unexpectedly (code ${code}: ${reasonStr})`);
    }
    queue.push(null);
    wake();
  });

  // Terminate the socket when the caller aborts
  signal.addEventListener('abort', () => {
    log?.info('WS aborting on signal');
    ws.terminate();
  }, { once: true });

  // ── Wait for open (or immediate error) ───────────────────────────────────

  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  // ── Yield frames ─────────────────────────────────────────────────────────

  while (!signal.aborted) {
    if (queue.length === 0) {
      await new Promise<void>((res) => { notify = res; });
    }

    if (wsError) {
      throw wsError;
    }

    const item = queue.shift();
    if (item === null) {
      // Server closed the connection
      break;
    }
    if (item !== undefined) {
      yield item;
    }
  }
}
