import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

export function fixturePath(name) {
  return join(HERE, "fixtures", name);
}
