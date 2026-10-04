// A spending store in a JSON file, so limits survive a restart (Node only;
// one process per file). For several agents sharing one budget, pass your own
// store with the same three methods, backed by a database.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const KEEP_MS = 31 * 86_400_000;

export function fileStore(path) {
  if (typeof path !== "string" || !path) throw new TypeError("fileStore needs a file path");
  const read = () => {
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      return Array.isArray(data) ? data : [];
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw new Error(`spending file ${path} is unreadable (${err.message}); fix or remove it`);
    }
  };
  const write = (entries) => {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries.filter((e) => e.at >= Date.now() - KEEP_MS), null, 1));
    renameSync(tmp, path);
  };
  return {
    async add(entry) { write([...read(), entry]); },
    async remove(id) { write(read().filter((e) => e.id !== id)); },
    async list(since) { return read().filter((e) => e.at >= since); },
  };
}
