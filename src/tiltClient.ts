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
  currentBuild?: { spanID?: string };
  buildHistory?: Array<{ spanID?: string }>;
  k8sResourceInfo?: { spanID?: string };
}

export interface UIResource {
  metadata?: { name?: string; labels?: Record<string, string> };
  status?: UIResourceStatus;
}

export interface LogSpan {
  manifestName?: string;
}

export interface LogSegment {
  spanId?: string;
  time?: string;
  text?: string;
  level?: string;
}

export interface LogList {
  fromCheckpoint?: number;
  toCheckpoint?: number;
  spans?: Record<string, LogSpan>;
  segments?: LogSegment[];
}

/** Top-level shape of a WebSocket frame from /ws/view. */
export interface WebViewFrame {
  uiResources?: UIResource[];
  logList?: LogList;
}

// ─── Session cookie fetch ─────────────────────────────────────────────────────

/**
 * Fetches the session cookie(s) Tilt sets on the root path.
 *
 * Recent Tilt versions require a `Tilt-Token` cookie to be present on API
 * requests (including `/api/websocket_token` and the `/ws/view` handshake).
 * That cookie is handed out via a `Set-Cookie` header on the first request to
 * `/`, so we make that request here and collect whatever it sets.
 *
 * Returns a value suitable for use as a `Cookie` request header
 * (e.g. `"Tilt-Token=abc123"`), or `undefined` if the server set no cookie.
 */
export function fetchSessionCookie(port: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const url = `http://localhost:${port}/`;
    const req = http.get(url, (res) => {
      res.resume(); // drain the body so the socket can be freed
      const setCookie = res.headers['set-cookie'] ?? [];
      const pairs = setCookie
        .map((entry) => entry.split(';', 1)[0].trim())
        .filter((pair) => pair.length > 0);
      resolve(pairs.length > 0 ? pairs.join('; ') : undefined);
    });
    req.on('error', reject);
  });
}

// ─── CSRF token fetch ─────────────────────────────────────────────────────────

/**
 * Fetches the CSRF token required for the /ws/view WebSocket connection.
 * Tilt returns a raw string (not JSON) from this endpoint.
 *
 * `cookie`, when provided, is sent as the `Cookie` request header — recent Tilt
 * versions reject this request without the `Tilt-Token` session cookie.
 */
export function fetchCsrfToken(port: number, cookie?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = `http://localhost:${port}/api/websocket_token`;
    const options: http.RequestOptions = cookie ? { headers: { Cookie: cookie } } : {};
    const req = http.get(url, options, (res) => {
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
  cookie?: string,
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

  const ws = new WebSocket(url, cookie ? { headers: { Cookie: cookie } } : undefined);

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
