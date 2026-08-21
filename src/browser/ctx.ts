import type { TerminalTheme } from "./api";

export type PreloadCtx = Record<string, never>;

export interface MainCtx {
  socketDir: string;
  timingFile: string;
  /** the marker written when the user picked a theme file: while it is there,
   * the terminal's colours are not the ones in charge */
  themeChoiceFile: string;
  modules: {
    livesync: string;
    generate: string;
    ipc: string;
  };
}

export interface ThemeMessage {
  type: "theme";
  colors: TerminalTheme;
}

export interface PageTiming {
  at: number;
  origin: number;
  responseEnd: number;
  domInteractive: number;
  loadEnd: number;
  marks: Record<string, number>;
}

export interface TimingMessage {
  type: "timing";
  page: PageTiming;
}
