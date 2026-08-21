import fs from "node:fs";
import tty from "node:tty";

import type { Rgb } from "../theme/color";

export interface TerminalPalette {
  background: Rgb;
  foreground: Rgb;
  /** the sixteen ansi slots, in order */
  ansi: Rgb[];
}

/** Terminals answer colour queries as rgb:RRRR/GGGG/BBBB, at whatever width they
 * feel like, so each component is scaled by its own digit count. */
export function parseColor(reply: string): Rgb | null {
  const match = /rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(reply);
  if (!match) return null;
  const scale = (raw: string) => Math.round((parseInt(raw, 16) / (16 ** raw.length - 1)) * 255);
  return [scale(match[1]), scale(match[2]), scale(match[3])];
}

const OSC_REPLY = /\x1b\](\d+);(?:(\d+);)?([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

export interface ParsedReplies {
  background: Rgb | null;
  foreground: Rgb | null;
  ansi: (Rgb | null)[];
}

export function parseReplies(raw: string): ParsedReplies {
  const ansi: (Rgb | null)[] = new Array(16).fill(null);
  let background: Rgb | null = null;
  let foreground: Rgb | null = null;
  for (const [, code, index, body] of raw.matchAll(OSC_REPLY)) {
    const color = parseColor(body);
    if (!color) continue;
    if (code === "11") background = color;
    else if (code === "10") foreground = color;
    else if (code === "4" && index !== undefined) {
      const slot = Number(index);
      if (slot >= 0 && slot < 16) ansi[slot] = color;
    }
  }
  return { background, foreground, ansi };
}

function buildQuery(): string {
  const slots = Array.from({ length: 16 }, (_, index) => `\x1b]4;${index};?\x07`).join("");
  // the device-attributes reply comes after the colours, so it marks the end
  return `\x1b]11;?\x07\x1b]10;?\x07${slots}\x1b[c`;
}

const DONE = /\x1b\[\?[0-9;]*c/;

/** Windows has no /dev/tty to open a second handle on, so the console tode was
 * started with is borrowed: stdin goes raw for as long as the answers take, and
 * is handed back exactly as it was found. */
function queryOwnConsole(idleMs: number, capMs: number): Promise<ParsedReplies | null> {
  return new Promise((resolve) => {
    const input = process.stdin as tty.ReadStream;
    if (!input.isTTY || !process.stdout.isTTY) return resolve(null);
    const wasRaw = input.isRaw;
    // isPaused() is false on a stdin nothing has read yet — flowing is null,
    // not false — so it cannot say whether this console was already being read.
    // Nothing else in tode reads stdin before the palette, and the browser is
    // spawned with this same console inherited: leaving the stream flowing here
    // means tode goes on consuming the bytes meant for the pane, and every
    // mouse report and key press disappears into this process instead.
    const wasFlowing = input.readableFlowing === true;
    let raw = "";
    let settled = false;
    const onData = (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (DONE.test(raw)) return finish(parseReplies(raw));
      clearTimeout(idle);
      idle = setTimeout(settle, idleMs);
    };
    const finish = (value: ParsedReplies | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      clearTimeout(cap);
      input.off("data", onData);
      try {
        input.setRawMode(wasRaw);
      } catch {}
      if (!wasFlowing) input.pause();
      resolve(value);
    };
    const settle = () => finish(raw ? parseReplies(raw) : null);
    let idle = setTimeout(settle, idleMs);
    const cap = setTimeout(settle, capMs);
    try {
      input.setRawMode(true);
      input.on("data", onData);
      input.resume();
      process.stdout.write(buildQuery());
    } catch {
      finish(null);
    }
  });
}

export function queryTerminal(idleMs = 400, capMs = 2000): Promise<ParsedReplies | null> {
  if (process.platform === "win32") return queryOwnConsole(idleMs, capMs);
  return new Promise((resolve) => {
    if (!process.stdout.isTTY) return resolve(null);
    let fd: number;
    try {
      fd = fs.openSync("/dev/tty", "r+");
    } catch {
      return resolve(null);
    }
    let input: tty.ReadStream | null = null;
    let raw = "";
    let settled = false;
    const finish = (value: ParsedReplies | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      clearTimeout(cap);
      try {
        input?.setRawMode(false);
      } catch {}
      try {
        if (input) input.destroy();
        else fs.closeSync(fd);
      } catch {}
      resolve(value);
    };
    const settle = () => finish(raw ? parseReplies(raw) : null);
    let idle = setTimeout(settle, idleMs);
    const cap = setTimeout(settle, capMs);
    try {
      input = new tty.ReadStream(fd);
      if (!input.isTTY) return finish(null);
      input.setRawMode(true);
      input.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
        if (DONE.test(raw)) return finish(parseReplies(raw));
        clearTimeout(idle);
        idle = setTimeout(settle, idleMs);
      });
      input.on("error", () => finish(null));
      fs.writeSync(fd, buildQuery());
    } catch {
      finish(null);
    }
  });
}

// eh?
// i see, this is that blue stuff. i suppose that's fine
const FALLBACK_ANSI: Rgb[] = [
  [26, 27, 30],
  [229, 72, 77],
  [48, 164, 108],
  [245, 165, 36],
  [93, 156, 255],
  [186, 148, 255],
  [94, 201, 227],
  [200, 205, 215],
  [90, 96, 106],
  [255, 108, 112],
  [76, 194, 138],
  [255, 196, 84],
  [124, 178, 255],
  [206, 176, 255],
  [126, 220, 240],
  [235, 238, 245],
];

export function withFallbacks(parsed: ParsedReplies | null): TerminalPalette {
  return {
    background: parsed?.background ?? [13, 15, 19],
    foreground: parsed?.foreground ?? [230, 233, 239],
    ansi: FALLBACK_ANSI.map((slot, index) => parsed?.ansi[index] ?? slot),
  };
}

/** Everything a drawing pane switches on, switched back off.
 *
 * terminal-browser writes this itself when it exits, but it can only do that if
 * it gets to exit: a pane whose browser was killed outright is left on the
 * alternate screen, with no cursor, with mouse reporting on, and with the last
 * frame still drawn over it. `tode --reset-terminal` writes the same sequence
 * from the outside, so the pane can be had back without closing it.
 *
 * The order matters: the modes go off while the alternate screen is still up,
 * the leftover frame is cleared there, and only then is the screen left — so
 * nothing is cleared out of the shell's own scrollback. */
const RESTORE = [
  "\x1b[<u", // pop the kitty keyboard flags terminal-browser pushed
  "\x1b[>4;0m", // modifyOtherKeys off
  "\x1b[?2031l", // colour scheme change reports off
  "\x1b[?2048l", // in-band resize reports off
  "\x1b[?2004l", // bracketed paste off
  "\x1b[?1004l", // focus reporting off
  "\x1b[?1016l", // pixel mouse coordinates off
  "\x1b[?1006l", // SGR mouse encoding off
  "\x1b[?1003l", // any-event mouse tracking off
  "\x1b_Ga=d\x1b\\", // delete every kitty graphics image
  "\x1b[2J\x1b[H", // clear whatever frame is still drawn, alternate screen and all
  "\x1b[?25h", // cursor back
  "\x1b[?1049l", // and back to the shell's own screen
  "\x1b[0m", // with no colour left over
].join("");

/** Writes the restore sequence to this terminal. Does nothing when stdout is
 * not one, so it is safe in a pipe. */
export function restoreTerminal(): boolean {
  if (!process.stdout.isTTY) return false;
  process.stdout.write(RESTORE);
  return true;
}
