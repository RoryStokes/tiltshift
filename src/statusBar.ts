import * as vscode from 'vscode';
import type { TiltManager, TiltStatus, UIResourceItem } from './tiltManager';

/**
 * Bottom status bar item showing the current Tilt state.
 *
 * Clicking opens the Tilt UI when connected, or triggers Start when stopped.
 */
export class TiltStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly manager: TiltManager) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.item.name = 'TiltShift';

    manager.on('statusChange', () => this.update());
    manager.on('resourcesChange', () => this.update());

    this.update();
    this.item.show();
  }

  update(): void {
    const { status, resources } = this.manager;
    const { text, tooltip, command, color } = this.renderState(status, resources);
    this.item.text = text;
    this.item.tooltip = tooltip;
    this.item.command = command;
    this.item.color = color;
  }

  private renderState(
    status: TiltStatus,
    resources: UIResourceItem[],
  ): {
    text: string;
    tooltip: string;
    command: string;
    color: vscode.ThemeColor | undefined;
  } {
    switch (status) {
      case 'connecting':
        return {
          text: '$(loading~spin) Tilt',
          tooltip: 'TiltShift: connecting…',
          command: 'tiltshift.refresh',
          color: undefined,
        };

      case 'connected': {
        const ok = resources.filter((r) => r.runtimeStatus === 'ok' || r.updateStatus === 'ok').length;
        const err = resources.filter(
          (r) => r.runtimeStatus === 'error' || r.updateStatus === 'error',
        ).length;
        const pending = resources.filter(
          (r) => r.runtimeStatus === 'pending' || r.updateStatus === 'pending',
        ).length;

        if (err > 0) {
          return {
            text: `$(error) Tilt (${err} error${err > 1 ? 's' : ''})`,
            tooltip: `TiltShift: ${err} resource(s) in error`,
            command: 'tiltshift.openUI',
            color: new vscode.ThemeColor('statusBarItem.errorForeground'),
          };
        }
        if (pending > 0) {
          return {
            text: `$(loading~spin) Tilt (${pending} pending)`,
            tooltip: `TiltShift: ${pending} resource(s) updating`,
            command: 'tiltshift.openUI',
            color: new vscode.ThemeColor('statusBarItem.warningForeground'),
          };
        }
        return {
          text: `$(check) Tilt (${ok}/${resources.length})`,
          tooltip: `TiltShift: ${ok} of ${resources.length} resource(s) healthy`,
          command: 'tiltshift.openUI',
          color: undefined,
        };
      }

      case 'error':
        return {
          text: '$(error) Tilt',
          tooltip: 'TiltShift: cannot reach Tilt — click to retry',
          command: 'tiltshift.connectToExisting',
          color: new vscode.ThemeColor('statusBarItem.errorForeground'),
        };

      case 'disconnected':
      default:
        return {
          text: '$(circle-slash) Tilt',
          tooltip: 'TiltShift: not running — click to start',
          command: 'tiltshift.start',
          color: new vscode.ThemeColor('statusBarItem.warningForeground'),
        };
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
