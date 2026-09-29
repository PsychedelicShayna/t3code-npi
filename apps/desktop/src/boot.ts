import { runNeoPiCli } from "./neopi/NeoPiCli.ts";
// Packaged app entry. Enables the compile cache before the main bundle loads,
// so the cache also covers main.cjs itself.
if (!runNeoPiCli()) {
  require("./compileCache.cjs");
  require("./main.cjs");
}
