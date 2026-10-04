import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type Run = (bin: string, args: string[], input?: string) => Promise<string>;

export function shellIn(env: NodeJS.ProcessEnv): Run {
  return async (bin, args, input) => {
    // windowsHide matters here even though nothing is drawn: wezterm.exe and the
    // other terminal clis are console programs, and the daemon that asks them
    // questions has no console of its own, so Windows would give each call a
    // console window of its own — two of them on every open, one for the pane
    // list and one for the split.
    const running = exec(bin, args, {
      env,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 8000,
      windowsHide: true,
    });
    if (input !== undefined) running.child.stdin?.end(input);
    const { stdout } = await running;
    return stdout;
  };
}
