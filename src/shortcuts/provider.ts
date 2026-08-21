import { ghosttyProvider } from "./backends/ghostty";
import { kittyProvider } from "./backends/kitty";
import { weztermProvider } from "./backends/wezterm";
/**
 * this API is pretty awful and subject to very large change
 */

export interface EditorHold {
  command: string;
  guard?: string;
  claimant?: string;
  describes?: string;
}

export interface ProviderConflict {
  editorId: string;
  trigger: string;
  current: string | null;
  editor: {
    means: string;
    command: string;
    guard?: string;
  };
  others: EditorHold[];
  inTerminal: string;
  short: string;
  freed: string;
  tradeoff: string;
  shared?: { action: string; note: string };
}

export interface FreedMove {
  trigger: string;
  to?: string;
  action?: string;
  emit?: string;
}

export interface ShortcutProvider {
  id: string;
  name: string;
  detect(env: NodeJS.ProcessEnv): boolean;
  ready(): string | null;
  scan(): ProviderConflict[];
  takenAs(chord: string): string | null;
  trigger(chord: string): string;
  describe(action: string): string;
  apply(moves: FreedMove[]): string;
  onApplied(): boolean;
  undo(): boolean;
  reloadHint(): string;
}

/** The ghostty and kitty backends read a unix config file and shell out to the
 * terminal's own binary, so they have nothing to say on Windows; there the
 * wezterm backend persists its override through the registry instead, which is
 * why it is the one Windows offers. A terminal with no provider here is what
 * the wizard already treats as "not supported": it prints that and steps aside
 * rather than failing. */
const PROVIDERS: ShortcutProvider[] =
  process.platform === "win32" ? [weztermProvider] : [ghosttyProvider, kittyProvider];

export function providerFor(env: NodeJS.ProcessEnv = process.env): ShortcutProvider | null {
  return PROVIDERS.find((provider) => provider.detect(env)) ?? null;
}
