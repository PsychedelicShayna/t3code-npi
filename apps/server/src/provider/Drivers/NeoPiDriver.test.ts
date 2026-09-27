import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NeoPiDriver } from "./NeoPiDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-neopi-driver-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
);

it.layer(testLayer)("NeoPiDriver", (it) => {
  it.effect(
    "marks a configured missing binary unavailable without falling back to npi on PATH",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const instance = yield* NeoPiDriver.create({
            instanceId: ProviderInstanceId.make("neopi-missing"),
            displayName: "NeoPi/OMP",
            enabled: true,
            environment: [],
            config: {
              ...NeoPiDriver.defaultConfig(),
              binaryPath: "/nonexistent/t3-neopi-cli",
              enabled: true,
            },
          });
          const snapshot = yield* instance.snapshot.refresh;
          expect(snapshot.installed).toBe(false);
          expect(snapshot.status).toBe("error");
          expect(snapshot.message).toContain("/nonexistent/t3-neopi-cli");
          expect(snapshot.displayName).toBe("NeoPi/OMP");
        }),
      ),
  );
});
