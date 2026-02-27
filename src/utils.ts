/**
 * Removes ANSI/VT escape sequences from a string.
 * Covers colour codes, cursor movement, erase sequences, and other CSI/OSC/ST
 * sequences that terminal emulators interpret but VS Code output panels display
 * as raw characters.
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x1b\x9b](?:[@-Z\\-_]|\[[0-9;]*[ -/]*[@-~])|[\x1b\x9b][()][AB012]/g, '');
}
