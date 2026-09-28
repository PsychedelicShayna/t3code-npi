import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { TextGenerationError, type ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import {
  type NeoPiRpcClient,
  type NeoPiRpcClientOptions,
  type PromptHandle,
  type SessionEventFrame,
  type SpawnFn,
} from "effect-neopi-rpc/client";
import { NeoPiRpcError } from "effect-neopi-rpc/errors";
import { isRecord } from "effect-neopi-rpc/schema";

import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";

const DEADLINE_MS = 60_000;
const CLOSE_GRACE_MS = 1_000;

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export interface NeoPiTextGenerationInput {
  readonly binary: string;
  readonly env: Record<string, string>;
  readonly spawn: SpawnFn;
  /**
   * `NeoPiRpcClient.make`. Injected so tests can wrap the client without
   * editing the transport package.
   */
  readonly makeClient: (
    options: NeoPiRpcClientOptions,
  ) => Effect.Effect<NeoPiRpcClient, NeoPiRpcError, Scope.Scope>;
  /**
   * Generation deadline. Defaults to 60s. A shorter value is only for tests.
   */
  readonly deadlineMs?: number;
}

/**
 * Disposable NeoPi/OMP text generation. Each call spawns a trimmed RPC
 * process (no tools, extensions, skills, or rules) and removes its session
 * directory afterwards. N7 wires this into the provider; do not start a
 * full-loadout session here.
 */
export const makeNeoPiTextGeneration = (
  input: NeoPiTextGenerationInput,
): TextGeneration.TextGeneration["Service"] => {
  const deadlineMs = input.deadlineMs ?? DEADLINE_MS;

  const runJson = <S extends Schema.Top>(args: {
    readonly operation: string;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sessionDir = yield* fs.makeTempDirectory({ prefix: "t3-neopi-text-" }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: args.operation,
              detail: "Failed to create a disposable NeoPi/OMP session directory.",
              cause,
            }),
        ),
      );
      yield* Effect.addFinalizer(() =>
        fs.remove(sessionDir, { recursive: true, force: true }).pipe(Effect.ignore),
      );

      const schemaJson = yield* encodeJson(toJsonSchemaObject(args.outputSchema)).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: args.operation,
              detail: "Failed to encode the output schema.",
              cause,
            }),
        ),
      );
      const message = `${args.prompt}\n\nAnswer with a single JSON object matching this schema, and no other text:\n${schemaJson}`;
      const client = yield* input
        .makeClient({
          spawn: input.spawn,
          command: input.binary,
          args: launchArgs(args.cwd, sessionDir, modelArg(args.modelSelection)),
          cwd: args.cwd,
          env: input.env,
          requestTimeoutMs: deadlineMs,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: args.operation,
                detail: cause.message,
                cause,
              }),
          ),
        );
      yield* Effect.addFinalizer(() => client.close(CLOSE_GRACE_MS));

      const settled = yield* Deferred.make<string, TextGenerationError>();
      yield* collectAssistantText(client, settled, args.operation);

      const handle = yield* client.prompt({ type: "prompt", message }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: args.operation,
              detail: cause.message,
              cause,
            }),
        ),
      );
      const text = (yield* awaitAssistantText(client, handle, settled, args.operation)).trim();
      if (text.length === 0) {
        return yield* new TextGenerationError({
          operation: args.operation,
          detail: "NeoPi/OMP returned empty output.",
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(args.outputSchema));
      return yield* decodeOutput(extractJsonObject(text)).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: args.operation,
              detail: "NeoPi/OMP returned a reply that was not valid JSON.",
              cause,
            }),
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeFileSystem.layer),
      Effect.timeoutOrElse({
        duration: deadlineMs,
        orElse: () =>
          Effect.fail(
            new TextGenerationError({
              operation: args.operation,
              detail: "NeoPi/OMP text generation exceeded the deadline.",
            }),
          ),
      }),
      Effect.mapError((cause) =>
        normalizeCliError("npi", args.operation, cause, "NeoPi/OMP text generation failed."),
      ),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("NeoPiTextGeneration.generateCommitMessage")(function* (request) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: request.branch,
        stagedSummary: request.stagedSummary,
        stagedPatch: request.stagedPatch,
        includeBranch: request.includeBranch === true,
        policy: request.policy,
      });
      const generated = yield* runJson({
        operation: "generateCommitMessage",
        cwd: request.cwd,
        prompt,
        outputSchema,
        modelSelection: request.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("NeoPiTextGeneration.generatePrContent")(function* (request) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: request.baseBranch,
        headBranch: request.headBranch,
        commitSummary: request.commitSummary,
        diffSummary: request.diffSummary,
        diffPatch: request.diffPatch,
        policy: request.policy,
        changeRequestTemplate: request.changeRequestTemplate,
      });
      const generated = yield* runJson({
        operation: "generatePrContent",
        cwd: request.cwd,
        prompt,
        outputSchema,
        modelSelection: request.modelSelection,
      });
      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("NeoPiTextGeneration.generateBranchName")(function* (request) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: request.message,
        attachments: request.attachments,
      });
      const generated = yield* runJson({
        operation: "generateBranchName",
        cwd: request.cwd,
        prompt,
        outputSchema,
        modelSelection: request.modelSelection,
      });
      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("NeoPiTextGeneration.generateThreadTitle")(function* (request) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: request.message,
        previousTitle: request.previousTitle,
        linkedContext: request.linkedContext,
        attachments: request.attachments,
      });
      const generated = yield* runJson({
        operation: "generateThreadTitle",
        cwd: request.cwd,
        prompt,
        outputSchema,
        modelSelection: request.modelSelection,
      });
      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
};

const modelArg = (selection: ModelSelection): string | undefined => {
  const model = selection.model.trim();
  if (model.length === 0) {
    return undefined;
  }
  return model;
};

const launchArgs = (cwd: string, sessionDir: string, model: string | undefined): Array<string> => [
  "--mode",
  "rpc",
  "--cwd",
  cwd,
  "--no-session",
  "--session-dir",
  sessionDir,
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--no-rules",
  "--no-title",
  ...(model === undefined ? [] : ["--model", model]),
];

const isTerminalAgentEnd = (frame: SessionEventFrame): boolean =>
  frame.type === "agent_end" && frame.isTerminal !== false;

const textDelta = (frame: SessionEventFrame): string | undefined => {
  if (frame.type !== "message_update") {
    return undefined;
  }
  const event = frame.assistantMessageEvent;
  if (!isRecord(event) || event.type !== "text_delta" || typeof event.delta !== "string") {
    return undefined;
  }
  return event.delta;
};

const textFromContent = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: Array<string> = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
};

const textFromMessage = (message: unknown): string => {
  if (!isRecord(message) || message.role !== "assistant") {
    return "";
  }
  return textFromContent(message.content);
};

const isFailedAssistant = (message: unknown): boolean => {
  if (!isRecord(message) || message.role !== "assistant") return false;
  if (message.stopReason === "error" || message.stopReason === "aborted") return true;
  return typeof message.errorMessage === "string" && message.errorMessage.length > 0;
};

const finalAssistantFromAgentEnd = (
  frame: SessionEventFrame,
): { text: string; failure?: string } | undefined => {
  const messages = frame.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") continue;
    if (isFailedAssistant(message))
      return {
        text: "",
        failure:
          typeof message.errorMessage === "string" && message.errorMessage
            ? message.errorMessage
            : `Final NeoPi/OMP assistant attempt ${String(message.stopReason)}.`,
      };
    return { text: textFromMessage(message) };
  }
  return undefined;
};

interface AssistantAttempt {
  messageId?: string;
  deltas: string;
  snapshot: string;
  failed: boolean;
}

const messageIdOf = (frame: SessionEventFrame): string | undefined =>
  typeof frame.messageId === "string" && frame.messageId.length > 0 ? frame.messageId : undefined;

const collectAssistantText = (
  client: NeoPiRpcClient,
  settled: Deferred.Deferred<string, TextGenerationError>,
  operation: string,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    let current: AssistantAttempt = { deltas: "", snapshot: "", failed: false };
    const beginAttempt = (messageId?: string): void => {
      current = { deltas: "", snapshot: "", failed: false, ...(messageId ? { messageId } : {}) };
    };
    yield* Stream.runForEach(client.events, (frame) =>
      Effect.gen(function* () {
        if (
          frame.type === "message_start" &&
          isRecord(frame.message) &&
          frame.message.role === "assistant"
        ) {
          beginAttempt(messageIdOf(frame));
        }
        if (frame.type === "auto_retry_start") {
          current.failed = true;
          beginAttempt();
        }
        const delta = textDelta(frame);
        if (delta !== undefined) {
          const messageId = messageIdOf(frame);
          if (
            current.failed ||
            (messageId !== undefined &&
              current.messageId !== undefined &&
              messageId !== current.messageId)
          ) {
            beginAttempt(messageId);
          } else if (messageId !== undefined && current.messageId === undefined) {
            current.messageId = messageId;
          }
          current.deltas += delta;
        }
        if (frame.type === "message_end") {
          const text = textFromMessage(frame.message);
          if (text.length > 0) current.snapshot = text;
          if (isFailedAssistant(frame.message)) current.failed = true;
        }
        if (isTerminalAgentEnd(frame)) {
          const final = finalAssistantFromAgentEnd(frame);
          if (final?.failure) {
            yield* Deferred.fail(
              settled,
              new TextGenerationError({ operation, detail: final.failure }),
            ).pipe(Effect.ignore);
          } else {
            const sameAttempt = !current.failed ? current.snapshot || current.deltas : "";
            yield* Deferred.succeed(settled, final ? final.text : sameAttempt).pipe(Effect.ignore);
          }
        }
      }),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(client.exit).pipe(
      Effect.flatMap((exit) => Deferred.fail(settled, exitError(operation, exit))),
      Effect.ignore,
      Effect.forkScoped,
    );
  });

const exitError = (
  operation: string,
  exit: {
    readonly code: number | null;
    readonly signal: string | null;
    readonly stderrTail: string;
  },
): TextGenerationError => {
  const status = exit.signal !== null ? `signal ${exit.signal}` : `code ${String(exit.code)}`;
  const tail = exit.stderrTail.trim();
  return new TextGenerationError({
    operation,
    detail:
      tail.length > 0
        ? `NeoPi/OMP exited before a reply (${status}): ${tail}`
        : `NeoPi/OMP exited before a reply (${status}).`,
  });
};

const awaitAssistantText = (
  client: NeoPiRpcClient,
  handle: PromptHandle,
  settled: Deferred.Deferred<string, TextGenerationError>,
  operation: string,
): Effect.Effect<string, TextGenerationError> =>
  Deferred.await(settled).pipe(
    Effect.raceFirst(
      Deferred.await(handle.outcome).pipe(
        Effect.flatMap((outcome) => {
          if (outcome.kind === "agent") {
            return Effect.never;
          }
          if (outcome.kind === "local") {
            return Effect.fail(
              new TextGenerationError({
                operation,
                detail: "NeoPi/OMP did not invoke an agent for text generation.",
              }),
            );
          }
          // `failPending` resolves the prompt before the exit deferred, and
          // only the exit path uses this error text. Wait for stderr in that
          // case; a live rejection must not block on a process that is still up.
          if (!outcome.error.includes("process exited")) {
            return Effect.fail(
              new TextGenerationError({
                operation,
                detail: outcome.error,
              }),
            );
          }
          return Deferred.await(client.exit).pipe(
            Effect.flatMap((exit) => Effect.fail(exitError(operation, exit))),
          );
        }),
      ),
    ),
  );
