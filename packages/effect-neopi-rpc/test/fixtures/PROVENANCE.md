# Fixture provenance

NeoPi revision: `e9ce6299a6646a7525385ebcec1d7118e265a485` (`npi/18.3.2`, `v18.2.11-158-ge9ce6299a6`).

Captured 2026-09-27 from the `npi` binary on PATH, which resolved to that revision. One process, one short prompt.

```sh
PI_NO_PTY=1 npi --mode rpc-ui \
  --no-session \
  --session-dir /tmp/neopi-fixture-capture/session \
  --no-extensions \
  --no-skills \
  --no-rules \
  --model xai-oauth/grok-4.5
```

Stdin, in order: `negotiate_protocol` 2, `get_state`, `get_available_models`, `prompt` `"say hi"`. The prompt settled with `agent_end` (`isTerminal: true`) and `prompt_result` (`agentInvoked: true`). `get_available_models` arrived as 23 `rpc_chunk` frames (`byteLength` 5954937) and was not committed: the catalog is about 6 MiB and is not required to exercise reassembly.

Redaction before commit:

- Session id replaced with `redacted-session`.
- `systemPrompt` and `dumpTools` omitted. They contained home paths and workstation text.
- Custom/system reminder messages omitted. User text kept as `say hi`; assistant text stored as `hi` (the live reply was a short greeting).
- Command entries whose descriptions contained `@` or a home path were dropped. Retained names and descriptions are otherwise from the live `available_commands_update`.
- No account email was present in the retained fields. `model.baseUrl` is the public `https://api.x.ai/v1` host.

`scenarios/*.json` must not contain `@`.
