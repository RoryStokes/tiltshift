import * as vscode from 'vscode';
import type { TiltManager, UIResourceItem } from './tiltManager';
import type { PortForwarder } from './portForwarder';

// ─── Tree items ───────────────────────────────────────────────────────────────

/** A Tilt resource (service, job, etc.) shown at the root level. */
export class ResourceTreeItem extends vscode.TreeItem {
  constructor(public readonly resource: UIResourceItem) {
    super(
      resource.name,
      resource.links.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    this.contextValue = 'tiltshift.resource';
    this.description = statusDescription(resource);
    this.iconPath = statusIcon(resource);
    this.tooltip = statusTooltip(resource);
  }
}

/** An endpoint link under a resource. */
export class LinkTreeItem extends vscode.TreeItem {
  constructor(
    public readonly link: { name: string; url: string },
    public readonly localUrl: string,
  ) {
    super(link.name || link.url, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'tiltshift.link';
    this.description = localUrl !== link.url ? localUrl : undefined;
    this.tooltip = localUrl;
    this.iconPath = new vscode.ThemeIcon('link-external');
    this.command = {
      command: 'tiltshift.openLink',
      title: 'Open Link',
      arguments: [localUrl],
    };
  }
}

export type TiltTreeItem = ResourceTreeItem | LinkTreeItem;

// ─── Provider ─────────────────────────────────────────────────────────────────

export class TiltTreeProvider
  implements vscode.TreeDataProvider<TiltTreeItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<TiltTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Cache of resource name → resolved local link URLs */
  private linkCache = new Map<string, string[]>();

  constructor(
    private readonly manager: TiltManager,
    private readonly portForwarder: PortForwarder,
  ) {
    manager.on('resourcesChange', () => this.refresh());
    manager.on('statusChange', () => this.refresh());
  }

  refresh(): void {
    this.linkCache.clear();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TiltTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TiltTreeItem): vscode.ProviderResult<TiltTreeItem[]> {
    if (!element) {
      return this.getRootItems();
    }
    if (element instanceof ResourceTreeItem) {
      return this.getLinkItems(element.resource);
    }
    return [];
  }

  private getRootItems(): TiltTreeItem[] {
    const { status, resources } = this.manager;

    if (status === 'disconnected') {
      const item = new vscode.TreeItem('Tilt not running');
      item.description = 'Start Tilt to see resources';
      item.iconPath = new vscode.ThemeIcon('circle-slash');
      item.command = {
        command: 'tiltshift.start',
        title: 'Start Tilt',
      };
      return [item as TiltTreeItem];
    }

    if (status === 'connecting') {
      const item = new vscode.TreeItem('Connecting…');
      item.iconPath = new vscode.ThemeIcon('loading~spin');
      return [item as TiltTreeItem];
    }

    if (status === 'error') {
      const item = new vscode.TreeItem('Cannot reach Tilt');
      item.description = 'Click to retry';
      item.iconPath = new vscode.ThemeIcon('error');
      item.command = {
        command: 'tiltshift.connectToExisting',
        title: 'Retry Connection',
      };
      return [item as TiltTreeItem];
    }

    if (resources.length === 0) {
      const item = new vscode.TreeItem('No resources yet');
      item.iconPath = new vscode.ThemeIcon('loading~spin');
      return [item as TiltTreeItem];
    }

    return resources.map((r) => new ResourceTreeItem(r));
  }

  private async getLinkItems(resource: UIResourceItem): Promise<TiltTreeItem[]> {
    return Promise.all(
      resource.links.map(async (link) => {
        const localUrl = await this.portForwarder.localizeUrl(link.url);
        return new LinkTreeItem(link, localUrl);
      }),
    );
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusDescription(r: UIResourceItem): string {
  const parts: string[] = [];
  if (r.updateStatus && r.updateStatus !== 'ok' && r.updateStatus !== 'not_applicable') {
    parts.push(`build: ${r.updateStatus}`);
  }
  if (r.runtimeStatus && r.runtimeStatus !== 'not_applicable') {
    parts.push(`runtime: ${r.runtimeStatus}`);
  }
  return parts.join('  ');
}

function statusIcon(r: UIResourceItem): vscode.ThemeIcon {
  const combined = [r.runtimeStatus, r.updateStatus];

  if (combined.includes('error')) {
    return new vscode.ThemeIcon(
      'error',
      new vscode.ThemeColor('testing.iconFailed'),
    );
  }
  if (combined.includes('pending') || combined.includes('in_progress')) {
    return new vscode.ThemeIcon('loading~spin');
  }
  if (combined.every((s) => !s || s === 'ok' || s === 'not_applicable' || s === 'none')) {
    return new vscode.ThemeIcon(
      'check',
      new vscode.ThemeColor('testing.iconPassed'),
    );
  }
  return new vscode.ThemeIcon('circle-outline');
}

function statusTooltip(r: UIResourceItem): string {
  const lines = [`Resource: ${r.name}`];
  if (r.updateStatus) lines.push(`Build: ${r.updateStatus}`);
  if (r.runtimeStatus) lines.push(`Runtime: ${r.runtimeStatus}`);
  if (r.links.length > 0) {
    lines.push('', 'Links:');
    r.links.forEach((l) => lines.push(`  ${l.name || l.url}`));
  }
  return lines.join('\n');
}
