export function attachWindowsConsole(pid: number): void {
  if (process.platform !== "win32") throw new Error("console attachment requires Windows");
  if (!Number.isInteger(pid) || pid <= 0 || pid >= 0xffffffff) {
    throw new Error("console process id must be a positive Windows process id");
  }
  const binding = require(`@zenbu-labs/pixel-native-win32-${process.arch}/pixel.node`) as {
    attachWindowsConsole(pid: number): void;
  };
  binding.attachWindowsConsole(pid);
}
