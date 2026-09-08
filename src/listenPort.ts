import { createServer } from "node:net";

/** Try `start`, then successive ports until one is free or `attempts` is exhausted. */
export function findAvailablePort(
  start: number,
  attempts = 20,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = start;
    const tryPort = (): void => {
      const tester = createServer();
      tester.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && port < start + attempts - 1) {
          port += 1;
          tryPort();
          return;
        }
        reject(error);
      });
      tester.once("listening", () => {
        tester.close(() => {
          resolve(port);
        });
      });
      tester.listen(port);
    };
    tryPort();
  });
}
