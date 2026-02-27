import * as vscode from 'vscode';
import type { LogList } from './tiltClient';
import { stripAnsi } from './utils';

/**
 * Manages per-resource VS Code LogOutputChannel instances, separated by log type.
 *
 * Two channels are created per resource (manifest name):
 *   - `"Tilt | <name> | build"`   — for build/update log spans
 *   - `"Tilt | <name> | runtime"` — for runtime (pod/process) log spans
 *
 * Span type is registered externally via `registerSpan()` (driven by UIResource data).
 * Segments for unregistered spans that carry a manifestName default to the runtime channel.
 */
export class SpanLogger implements vscode.Disposable {
  /** manifestName → build LogOutputChannel */
  private readonly buildChannels = new Map<string, vscode.LogOutputChannel>();
  /** manifestName → runtime LogOutputChannel */
  private readonly runtimeChannels = new Map<string, vscode.LogOutputChannel>();
  /** spanId → { manifest, type } — registered from UIResource span IDs */
  private readonly spanRegistry = new Map<string, { manifest: string; type: 'build' | 'runtime' }>();
  /** spanId → manifestName — accumulated from logList.spans for fallback naming */
  private readonly spanManifests = new Map<string, string>();

  /**
   * Registers a span ID as belonging to a specific resource and type.
   * Should be called when UIResource data is received, before log segments arrive.
   */
  registerSpan(spanId: string, type: 'build' | 'runtime', manifestName: string): void {
    this.spanRegistry.set(spanId, { manifest: manifestName, type });
  }

  /**
   * Returns the channel for a given resource and log type, or undefined if no
   * log segments have been received for that combination yet.
   */
  getChannel(manifestName: string, type: 'build' | 'runtime'): vscode.LogOutputChannel | undefined {
    return (type === 'build' ? this.buildChannels : this.runtimeChannels).get(manifestName);
  }

  applyLogList(logList: LogList): void {
    // Accumulate span→manifest mappings for spans not yet in the registry
    for (const [spanId, span] of Object.entries(logList.spans ?? {})) {
      if (span.manifestName && !this.spanManifests.has(spanId)) {
        this.spanManifests.set(spanId, span.manifestName);
      }
    }

    for (const seg of logList.segments ?? []) {
      const { spanId, text, level } = seg;
      if (!spanId || !text) continue;

      const entry = this.spanRegistry.get(spanId);
      const manifestName = entry?.manifest ?? this.spanManifests.get(spanId) ?? '';
      if (!manifestName) continue; // skip unattributed internal Tilt spans

      const type = entry?.type ?? 'runtime';
      const channel = this.getOrCreateChannel(manifestName, type);

      // A segment's text may contain multiple lines (and usually ends with \n).
      // Strip ANSI escape sequences first — the output panel renders plain text only.
      const lines = stripAnsi(text).split('\n');
      const end = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;

      for (let i = 0; i < end; i++) {
        const line = lines[i];
        switch (level?.toUpperCase()) {
          case 'WARN':
          case 'WARNING':
            channel.warn(line);
            break;
          case 'ERROR':
            channel.error(line);
            break;
          case 'DEBUG':
            channel.debug(line);
            break;
          default:
            channel.info(line);
        }
      }
    }
  }

  /** Disposes all channels and clears all state. Call before a deliberate reconnect. */
  reset(): void {
    for (const channel of [...this.buildChannels.values(), ...this.runtimeChannels.values()]) {
      channel.dispose();
    }
    this.buildChannels.clear();
    this.runtimeChannels.clear();
    this.spanRegistry.clear();
    this.spanManifests.clear();
  }

  dispose(): void {
    this.reset();
  }

  private getOrCreateChannel(manifestName: string, type: 'build' | 'runtime'): vscode.LogOutputChannel {
    const map = type === 'build' ? this.buildChannels : this.runtimeChannels;
    let channel = map.get(manifestName);
    if (!channel) {
      channel = vscode.window.createOutputChannel(`Tilt | ${manifestName} | ${type}`, { log: true });
      map.set(manifestName, channel);
    }
    return channel;
  }
}
