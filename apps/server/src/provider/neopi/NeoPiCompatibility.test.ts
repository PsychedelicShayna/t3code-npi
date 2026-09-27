import { expect, it } from "vite-plus/test";
import {
  NEOPI_CAPABILITIES,
  neopiCompatibility,
  supportsNeoPiCapability,
} from "./NeoPiCompatibility.ts";

it("rejects older transports while leaving named extensions optional", () => {
  expect(neopiCompatibility(null, false).status).toBe("unsupported");
  const ready = { type: "ready" as const, protocolVersion: 1, supportedProtocolVersions: [1, 2] };
  expect(neopiCompatibility(ready, false).status).toBe("unsupported");
  expect(neopiCompatibility(ready, true).status).toBe("supported");
  expect(neopiCompatibility({ ...ready, protocolVersion: 0 }, true).status).toBe("unsupported");
  expect(supportsNeoPiCapability(new Set([NEOPI_CAPABILITIES.setChatMode]), "setChatMode")).toBe(
    true,
  );
  expect(supportsNeoPiCapability(new Set(), "setChatMode")).toBe(false);
});
