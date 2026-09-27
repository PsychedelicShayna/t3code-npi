// @effect-diagnostics nodeBuiltinImport:off - path assertions match the resolver's node:path join.
import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "node:path";

import {
  neopiLegacySessionRoot,
  neopiProjectSessionDir,
  neopiSessionRoot,
  resolveNeoPiSessionRoots,
} from "./NeoPiPaths.ts";

describe("NeoPiPaths", () => {
  it("keeps the write root on baseDir and the legacy root on stateDir", () => {
    const baseDir = "/home/user/.t3";
    const userdata = NodePath.join(baseDir, "userdata");
    const dev = NodePath.join(baseDir, "dev");
    expect(neopiSessionRoot({ baseDir })).toBe(NodePath.resolve(baseDir, "neopi", "sessions"));
    expect(neopiLegacySessionRoot({ stateDir: userdata })).toBe(
      NodePath.resolve(userdata, "neopi", "sessions"),
    );
    expect(resolveNeoPiSessionRoots({ baseDir, stateDir: dev })).toEqual({
      canonical: NodePath.resolve(baseDir, "neopi", "sessions"),
      legacy: NodePath.resolve(dev, "neopi", "sessions"),
    });
    expect(neopiProjectSessionDir({ baseDir, profile: "work", projectId: "proj/1" })).toBe(
      NodePath.resolve(baseDir, "neopi", "sessions", "work", "proj%2F1"),
    );
    expect(neopiProjectSessionDir({ baseDir, profile: "", projectId: ".." })).toBe(
      NodePath.resolve(baseDir, "neopi", "sessions", "default", "default"),
    );
    expect(neopiProjectSessionDir({ baseDir, profile: "a.b", projectId: "p" })).toBe(
      NodePath.resolve(baseDir, "neopi", "sessions", "a%2Eb", "p"),
    );
  });
});
