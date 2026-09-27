# effect-neopi-rpc

JSONL stdio client for NeoPi/OMP (`oh-my-pi` compatible) `--mode rpc-ui`.

The client speaks protocol v1 until `ready.supportedProtocolVersions` includes `2`, then sends `negotiate_protocol`. After that, oversized stdout objects arrive as `rpc_chunk` frames and are reassembled under `ready.maxReassembledFrameBytes`. Inbound commands, including image prompts, are single JSON lines. There is no stdin chunking.

`request` correlates `response` frames by id and times out. `prompt` does not: its `PromptHandle.outcome` resolves once, as `local`, `rejected`, or `agent`. A late `success: false` for that id is applied to the prompt record rather than dropped.

`apps/server/scripts/neopi-mock-rpc-agent.ts` re-exports the fixture peer in `test/fixtures/neopi-mock-peer.ts`.
