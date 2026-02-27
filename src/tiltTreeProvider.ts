import * as vscode from 'vscode';
import type { TiltManager, UIResourceItem } from './tiltManager';
import type { PortForwarder } from './portForwarder';

// ─── Tree items ───────────────────────────────────────────────────────────────

/** A Tilt resource (service, job, etc.) shown at the root level. */
export class ResourceTreeItem extends vscode.TreeItem {
  constructor(public readonly resource: UIResourceItem) {
    const hasChildren = resource.links.length > 0 || !!resource.buildSpanId;
    super(
      resource.name,
      hasChildren
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    this.contextValue = 'tiltshift.resource';
    this.description = statusDescription(resource);
    this.iconPath = statusIcon(resource);
    this.tooltip = statusTooltip(resource);

    // Clicking the row opens the runtime log (falls back to build log in the command handler).
    this.command = {
      command: 'tiltshift.openResourceLog',
      title: 'Open Runtime Log',
      arguments: [resource.name, 'runtime'],
    };
  }
}

/** The build log entry shown as a child of a resource. */
export class BuildLogTreeItem extends vscode.TreeItem {
  constructor(public readonly resourceName: string, updateStatus: string) {
    super('Build', vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'tiltshift.buildLog';
    this.iconPath = buildStatusIcon(updateStatus);
    this.tooltip = 'Open build log';
    this.command = {
      command: 'tiltshift.openResourceLog',
      title: 'Open Build Log',
      arguments: [resourceName, 'build'],
    };
  }
}

/** A label group header shown at the root level. */
export class LabelGroupTreeItem extends vscode.TreeItem {
  constructor(
    public readonly labelKey: string | null,  // null for the "(unlabeled)" group
    public readonly labelValue: string,
    public readonly groupResources: UIResourceItem[],
  ) {
    super(labelValue, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'tiltshift.labelGroup';
    this.iconPath = new vscode.ThemeIcon('tag');
    if (labelKey !== null) {
      this.description = labelKey;
    }
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

export type TiltTreeItem = LabelGroupTreeItem | ResourceTreeItem | BuildLogTreeItem | LinkTreeItem;

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
    if (element instanceof LabelGroupTreeItem) {
      return element.groupResources.map((r) => new ResourceTreeItem(r));
    }
    if (element instanceof ResourceTreeItem) {
      return this.getResourceChildren(element.resource);
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

    return this.buildLabelGroups(resources);
  }

  private buildLabelGroups(resources: UIResourceItem[]): TiltTreeItem[] {
    // Collect unique label key+value pairs and the resources for each
    const labelMap = new Map<string, { key: string; value: string; resources: UIResourceItem[] }>();
    const unlabeled: UIResourceItem[] = [];

    for (const r of resources) {
      if (r.labels.length === 0) {
        unlabeled.push(r);
      } else {
        for (const lbl of r.labels) {
          const id = `${lbl.key}:${lbl.value}`;
          if (!labelMap.has(id)) {
            labelMap.set(id, { key: lbl.key, value: lbl.value, resources: [] });
          }
          labelMap.get(id)!.resources.push(r);
        }
      }
    }

    // Fall back to flat list when no resources have labels
    if (labelMap.size === 0) {
      return resources.map((r) => new ResourceTreeItem(r));
    }

    // Sort groups alphabetically by value, then key
    const groups = [...labelMap.values()].sort(
      (a, b) => a.value.localeCompare(b.value) || a.key.localeCompare(b.key),
    );

    const items: TiltTreeItem[] = groups.map(
      (g) => new LabelGroupTreeItem(g.key, g.value, g.resources),
    );

    // Append unlabeled resources as a special group at the end
    if (unlabeled.length > 0) {
      items.push(new LabelGroupTreeItem(null, '(unlabeled)', unlabeled));
    }

    return items;
  }

  private async getResourceChildren(resource: UIResourceItem): Promise<TiltTreeItem[]> {
    const items: TiltTreeItem[] = [];

    // Build log sub-item (shown once a build span has been observed for this resource)
    if (resource.buildSpanId) {
      items.push(new BuildLogTreeItem(resource.name, resource.updateStatus));
    }

    // Endpoint links
    const links = await Promise.all(
      resource.links.map(async (link) => {
        const localUrl = await this.portForwarder.localizeUrl(link.url);
        return new LinkTreeItem(link, localUrl);
      }),
    );
    items.push(...links);

    return items;
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

function buildStatusIcon(updateStatus: string): vscode.ThemeIcon {
  if (updateStatus === 'error') {
    return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
  }
  if (updateStatus === 'in_progress' || updateStatus === 'pending') {
    return new vscode.ThemeIcon('loading~spin');
  }
  if (updateStatus === 'ok') {
    return new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
  }
  return new vscode.ThemeIcon('tools'); // fallback: not_applicable, unknown, etc.
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
