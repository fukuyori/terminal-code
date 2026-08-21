export interface BridgeCtx {
  tode: string[];
  /** the label tode's own theme is contributed under. While the workbench is
   * wearing it, tode's colours are in charge; the moment the user picks another
   * theme, they are not. */
  themeName: string;
  /** where a window advertises the socket or named pipe it listens on */
  ipcDir: string;
  liveThemeFile: string;
  quitHint: string;
  startupOpenFile: string;
  /** the record of the color theme this workbench should wear — enforced by
   * the bridge, updated when a theme is picked in the editor */
  colorThemeFile: string;
}
