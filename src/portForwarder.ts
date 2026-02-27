import * as vscode from 'vscode';
import type { Logger } from './logger';

/**
 * Translates remote localhost URIs to externally-accessible local URIs using
 * `vscode.env.asExternalUri`.
 *
 * In a VS Code Remote session (SSH, Dev Containers, WSL), `asExternalUri`
 * triggers port forwarding and returns the local tunnel address, e.g.
 * `http://localhost:10350` on the remote becomes `http://127.0.0.1:54321`
 * locally. In a local workspace it returns the URI unchanged.
 *
 * Per-resource link tracking allows the extension to proactively forward ports
 * when a resource becomes healthy, and clear its tracking when it becomes
 * unhealthy. Note: VS Code's actual tunnel lifetime is managed by the editor —
 * `clearLinks` / `clearAllLinks` only remove entries from our internal state.
 */
export class PortForwarder implements vscode.Disposable {
  /** Cache of remote URL string → resolved external URI */
  private readonly cache = new Map<string, vscode.Uri>();

  /** Per-resource URL tracking: resource name → set of URLs we forwarded */
  private readonly _resourceLinks = new Map<string, Set<string>>();

  constructor(private readonly log: Logger) {}

  /**
   * Resolves a remote URL to an externally-accessible URI.
   * Results are cached for the lifetime of the session.
   */
  async localizeUrl(remoteUrl: string): Promise<string> {
    const cached = this.cache.get(remoteUrl);
    if (cached) return cached.toString();

    try {
      const uri = vscode.Uri.parse(remoteUrl);
      const external = await vscode.env.asExternalUri(uri);
      this.cache.set(remoteUrl, external);
      return external.toString();
    } catch (err) {
      // If resolution fails (e.g. non-localhost URL), return as-is
      this.log.warn(`Failed to localize URL ${remoteUrl}: ${String(err)}`);
      return remoteUrl;
    }
  }

  /** Pre-resolves the Tilt UI port so it appears in the Ports panel immediately. */
  async forwardTiltUI(port: number): Promise<string> {
    const url = `http://localhost:${port}`;
    return this.localizeUrl(url);
  }

  /**
   * Proactively forwards all given URLs for a resource.
   * Calls `asExternalUri` for any URL not already in the cache, ensuring the
   * port appears in VS Code's Forwarded Ports panel without user interaction.
   * Errors for individual URLs are logged as warnings and skipped.
   */
  async forwardLinks(resourceName: string, urls: string[]): Promise<void> {
    if (urls.length === 0) return;

    let tracked = this._resourceLinks.get(resourceName);
    if (!tracked) {
      tracked = new Set<string>();
      this._resourceLinks.set(resourceName, tracked);
    }

    for (const url of urls) {
      if (tracked.has(url)) continue; // already forwarded
      try {
        await this.localizeUrl(url);
        tracked.add(url);
        this.log.info(`Auto-forwarded ${url} for resource ${resourceName}`);
      } catch (err) {
        this.log.warn(`Failed to auto-forward ${url} for resource ${resourceName}: ${String(err)}`);
      }
    }
  }

  /**
   * Clears port tracking for a specific resource.
   * Removes the resource's URLs from our internal cache and tracking map.
   * VS Code's actual tunnel (if any) remains open — this is best-effort cleanup.
   */
  clearLinks(resourceName: string): void {
    const urls = this._resourceLinks.get(resourceName);
    if (!urls || urls.size === 0) return;

    for (const url of urls) {
      this.cache.delete(url);
    }
    this._resourceLinks.delete(resourceName);
    this.log.info(`Cleared port tracking for resource ${resourceName} (${urls.size} URL(s))`);
  }

  /**
   * Clears all forwarding state including the full URL cache.
   * Call this before a deliberate reconnect so every port is re-forwarded fresh.
   */
  reset(): void {
    this.clearAllLinks();
    this.cache.clear();
  }

  /**
   * Clears port tracking for all resources.
   * Called when Tilt disconnects or errors.
   */
  clearAllLinks(): void {
    if (this._resourceLinks.size === 0) return;
    this.log.info(`Clearing port tracking for all resources (${this._resourceLinks.size} resource(s))`);
    for (const name of [...this._resourceLinks.keys()]) {
      this.clearLinks(name);
    }
  }

  /** Clears all caches and tracked state. */
  dispose(): void {
    this.clearAllLinks();
    this.cache.clear();
  }
}
