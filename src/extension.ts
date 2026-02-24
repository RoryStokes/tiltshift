import * as vscode from 'vscode';
import { TiltManager } from './tiltManager';
import type { TiltManagerConfig, UIResourceItem } from './tiltManager';
import { PortForwarder } from './portForwarder';
import { TiltStatusBar } from './statusBar';
import { TiltTreeProvider } from './tiltTreeProvider';
import { Logger } from './logger';

export function activate(context: vscode.ExtensionContext): void {
  const config = readConfig();

  const channel = vscode.window.createOutputChannel('TiltShift');
  const log = new Logger(channel);

  const remote = vscode.env.remoteName ?? 'local';
  log.info(`TiltShift activated (remote: ${remote})`);

  const manager = new TiltManager(config, log);
  const portForwarder = new PortForwarder(log);
  const statusBar = new TiltStatusBar(manager);
  const treeProvider = new TiltTreeProvider(manager, portForwarder);

  const treeView = vscode.window.createTreeView('tiltshift.resourcesView', {
    treeDataProvider: treeProvider,
    showCollapseAll: false,
  });

  // ── Commands ────────────────────────────────────────────────────────────────

  const start = vscode.commands.registerCommand('tiltshift.start', () => {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage('TiltShift: no workspace folder open.');
      return;
    }
    log.info('Command: start');
    manager.startTilt(root);
    // Begin connecting after a short delay to let Tilt start up
    setTimeout(() => void manager.connect(), 2000);
  });

  const stop = vscode.commands.registerCommand('tiltshift.stop', () => {
    log.info('Command: stop');
    manager.stopTilt();
  });

  const restart = vscode.commands.registerCommand('tiltshift.restart', () => {
    log.info('Command: restart');
    manager.stopTilt();
    const root = workspaceRoot();
    if (!root) return;
    setTimeout(() => {
      manager.startTilt(root);
      setTimeout(() => void manager.connect(), 2000);
    }, 1000);
  });

  const openUI = vscode.commands.registerCommand('tiltshift.openUI', async () => {
    const port = vscode.workspace.getConfiguration('tiltshift').get<number>('tiltPort', 10350);
    try {
      const localUrl = await portForwarder.forwardTiltUI(port);
      log.info(`Opening Tilt UI at ${localUrl}`);
      await vscode.env.openExternal(vscode.Uri.parse(localUrl));
    } catch (err) {
      log.error('Failed to open Tilt UI', err);
      void vscode.window.showErrorMessage(`TiltShift: failed to open UI — ${String(err)}`);
    }
  });

  const connectToExisting = vscode.commands.registerCommand(
    'tiltshift.connectToExisting',
    () => {
      log.info('Command: connectToExisting');
      void manager.connect();
    },
  );

  const refresh = vscode.commands.registerCommand('tiltshift.refresh', () => {
    treeProvider.refresh();
    if (manager.status !== 'connected') {
      void manager.connect();
    }
  });

  const openLink = vscode.commands.registerCommand(
    'tiltshift.openLink',
    (url: string) => void vscode.env.openExternal(vscode.Uri.parse(url)),
  );

  // ── Context key: tiltshift.status ──────────────────────────────────────────

  const updateContext = (status: string): void => {
    void vscode.commands.executeCommand('setContext', 'tiltshift.status', status);
  };
  updateContext(manager.status);
  manager.on('statusChange', (s: string) => updateContext(s));

  // ── Auto-connect + auto-forward UI ────────────────────────────────────────

  if (config.autoForwardUI) {
    manager.on('statusChange', (s: string) => {
      if (s === 'connected') {
        const port = vscode.workspace.getConfiguration('tiltshift').get<number>('tiltPort', 10350);
        void portForwarder.forwardTiltUI(port);
      }
    });
  }

  // ── Auto-forward resource endpoint links ──────────────────────────────────

  manager.on('resourcesChange', (resources: UIResourceItem[]) => {
    const statuses = vscode.workspace.getConfiguration('tiltshift')
      .get<string[]>('autoForwardStatuses', ['ok', 'pending']);
    for (const r of resources) {
      if (r.runtimeStatus && statuses.includes(r.runtimeStatus)) {
        void portForwarder.forwardLinks(r.name, r.links.map((l) => l.url));
      } else {
        portForwarder.clearLinks(r.name);
      }
    }
  });

  manager.on('statusChange', (s: string) => {
    if (s === 'disconnected' || s === 'error') {
      portForwarder.clearAllLinks();
    }
  });

  // Check if Tilt is already running silently on activation
  void manager.connect().catch(() => { /* not running yet — that's fine */ });

  // ── Configuration reload ───────────────────────────────────────────────────

  const onConfigChange = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('tiltshift')) {
      manager.updateConfig(readConfig());
    }
  });

  // ── Disposables ────────────────────────────────────────────────────────────

  context.subscriptions.push(
    channel,
    manager,
    portForwarder,
    statusBar,
    treeProvider,
    treeView,
    start,
    stop,
    restart,
    openUI,
    connectToExisting,
    refresh,
    openLink,
    onConfigChange,
  );
}

export function deactivate(): void {
  // VS Code disposes everything in context.subscriptions automatically
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readConfig(): TiltManagerConfig {
  const cfg = vscode.workspace.getConfiguration('tiltshift');
  return {
    port: cfg.get<number>('tiltPort', 10350),
    pollInterval: cfg.get<number>('pollInterval', 2000),
    tiltfilePath: cfg.get<string>('tiltfilePath', ''),
    tiltArgs: cfg.get<string[]>('tiltArgs', []),
    autoForwardUI: cfg.get<boolean>('autoForwardUI', true),
  };
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
