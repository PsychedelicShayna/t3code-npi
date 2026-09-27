// @effect-diagnostics nodeBuiltinImport:off -- standalone mock peer process, spawned outside the Effect runtime.
// @effect-diagnostics globalConsole:off
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

export interface ScenarioStep {
  readonly on?: Record<string, unknown>;
  readonly emit: ReadonlyArray<unknown>;
}

export interface ScenarioFile {
  readonly scenario: ReadonlyArray<ScenarioStep>;
}

const writeFrame = (frame: unknown): void => {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
};

const readyV2 = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1024 * 1024,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
  capabilities: ["rpc-ui"],
};

const negotiateOk = (id: string) => ({
  id,
  type: "response",
  command: "negotiate_protocol",
  success: true,
  data: { protocolVersion: 2 },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const substitute = (value: unknown, id: string): unknown => {
  if (value === "$id") {
    return id;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => substitute(entry, id));
  }
  if (isRecord(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = substitute(entry, id);
    }
    return next;
  }
  return value;
};

const matches = (expected: Record<string, unknown>, actual: Record<string, unknown>): boolean => {
  for (const [key, value] of Object.entries(expected)) {
    if (!same(value, actual[key])) {
      return false;
    }
  }
  return true;
};

const same = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => same(entry, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length && keys.every((key) => same(left[key], right[key]))
    );
  }
  return false;
};

const loadScenario = (path: string): ScenarioFile => {
  const parsed: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.scenario)) {
    throw new Error("scenario file must be { scenario: [...] }");
  }
  return parsed as unknown as ScenarioFile;
};

const runScenario = async (scenario: ReadonlyArray<ScenarioStep>): Promise<void> => {
  let index = 0;
  const emitReadySteps = (): void => {
    while (index < scenario.length) {
      const step = scenario[index];
      if (!step || step.on) {
        return;
      }
      for (const frame of step.emit) {
        writeFrame(frame);
      }
      index += 1;
    }
  };
  emitReadySteps();

  const lines = NodeReadline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const message: unknown = JSON.parse(line);
    if (!isRecord(message)) {
      continue;
    }
    const step = scenario[index];
    const id = typeof message.id === "string" ? message.id : "";
    if (!step?.on || !matches(step.on, message)) {
      writeFrame({
        id: message.id,
        type: "response",
        command: typeof message.type === "string" ? message.type : "unknown",
        success: false,
        error: "no scenario match",
        code: "no_match",
      });
      continue;
    }
    for (const frame of step.emit) {
      writeFrame(substitute(frame, id));
    }
    index += 1;
    emitReadySteps();
  }
};

const handshakeThen = async (
  onCommand: (message: Record<string, unknown>) => void,
): Promise<void> => {
  writeFrame(readyV2);
  const lines = NodeReadline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const message: unknown = JSON.parse(line);
    if (!isRecord(message)) {
      continue;
    }
    if (message.type === "negotiate_protocol") {
      writeFrame(negotiateOk(typeof message.id === "string" ? message.id : "negotiate"));
      continue;
    }
    onCommand(message);
  }
};

const runEchoImage = async (): Promise<void> => {
  await handshakeThen((message) => {
    const images = Array.isArray(message.images) ? message.images : [];
    const first = images[0];
    const data = isRecord(first) && typeof first.data === "string" ? first.data : "";
    writeFrame({
      id: message.id,
      type: "response",
      command: message.type,
      success: true,
      data: { imageLength: data.length },
    });
  });
};

const runHang = async (): Promise<void> => {
  process.stderr.write("neopi-rpc-tail\n");
  process.on("SIGTERM", () => {
    writeFrame({ type: "notice", message: "got-term" });
  });
  writeFrame(readyV2);
  const lines = NodeReadline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (line.trim().length === 0) {
      return;
    }
    const message: unknown = JSON.parse(line);
    if (isRecord(message) && message.type === "negotiate_protocol") {
      writeFrame(negotiateOk(typeof message.id === "string" ? message.id : "negotiate"));
    }
  });
  lines.on("close", () => {
    writeFrame({ type: "notice", message: "after-eof" });
  });
  await new Promise(() => {});
};

const runV1Chunk = async (): Promise<void> => {
  writeFrame({
    type: "ready",
    protocolVersion: 1,
    maxFrameBytes: 1024 * 1024,
    maxReassembledFrameBytes: 64 * 1024 * 1024,
  });
  const lines = NodeReadline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    writeFrame({
      type: "rpc_chunk",
      chunkId: "v1",
      index: 0,
      count: 2,
      byteLength: 2,
      data: "e30=",
    });
  }
};

/** Entry point for `node neopi-mock-peer.ts [scenario.json]`. */
export const runMockPeerCli = async (): Promise<void> => {
  const mode = process.env.NEOPI_MOCK_MODE;
  if (mode === "echo-image") {
    await runEchoImage();
    return;
  }
  if (mode === "hang") {
    await runHang();
    return;
  }
  if (mode === "v1-chunk") {
    await runV1Chunk();
    return;
  }
  const scenarioPath = process.argv[2];
  if (!scenarioPath) {
    throw new Error(
      "usage: neopi-mock-peer.ts <scenario.json> | NEOPI_MOCK_MODE=echo-image|hang|v1-chunk",
    );
  }
  await runScenario(loadScenario(scenarioPath).scenario);
};

const entry = process.argv[1] ?? "";
if (entry.endsWith("neopi-mock-peer.ts")) {
  await runMockPeerCli();
}
