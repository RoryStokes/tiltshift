import * as vscode from 'vscode';

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

export class Logger {
  constructor(private readonly channel: vscode.OutputChannel) {}

  info(msg: string): void {
    this.channel.appendLine(`[${timestamp()}] [info]  ${msg}`);
  }

  warn(msg: string, err?: unknown): void {
    this.channel.appendLine(`[${timestamp()}] [warn]  ${msg}`);
    if (err instanceof Error && err.message) {
      this.channel.appendLine(`            ${err.message}`);
    }
  }

  error(msg: string, err?: unknown): void {
    this.channel.appendLine(`[${timestamp()}] [error] ${msg}`);
    if (err instanceof Error && err.message) {
      this.channel.appendLine(`            ${err.message}`);
    }
    // Reveal the channel on error, but don't steal editor focus
    this.channel.show(/*preserveFocus*/ true);
  }
}
