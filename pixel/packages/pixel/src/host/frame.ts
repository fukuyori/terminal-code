import fs from "node:fs";

import type { Surface } from "../react/surface";
import type { GuestFrame } from "./server";

export function presentGuestFrame(surface: Pick<Surface, "present">, frame: GuestFrame): void {
  let fd: number | null = null;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (fd !== null) fs.closeSync(fd);
    } finally {
      frame.ack();
    }
  };

  try {
    fd = fs.openSync(frame.path, "r");
    if (process.platform === "win32") {
      const bgra = fs.readFileSync(fd);
      surface.present({ bgra, width: frame.width, height: frame.height });
      release();
    } else {
      const stride = frame.width * 4;
      surface.present({
        shm: { fd, width: frame.width, height: frame.height, stride, size: stride * frame.height },
        released: release,
      });
    }
  } catch (error) {
    release();
    throw error;
  }
}
