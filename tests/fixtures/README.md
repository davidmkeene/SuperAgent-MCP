# Test fixtures (Codex `exec --json` event streams)

- `codex-large-success.jsonl` - recorded 2026-09-25 from a real superagent Codex
  call (the live server spilled it to a Claude Code tool-results file, 298,711
  chars). Sanitised: every string value except `type`, `status`, `kind` and `id`
  was replaced by same-length filler, the one changed file's path renamed, thread id zeroed, final
  agent message replaced. Event types, exit codes, item counts and token usage are
  the recorded values. 53 events, 293,494 chars.
- `codex-model-rejected.jsonl` - recorded 2026-09-27: `codex exec --json -m
  superagent-nonexistent-model-probe` (codex-cli 0.157.0, ChatGPT-account auth).
  The provider refused the request with HTTP 400 before any inference (no tokens).
  Only the thread id was changed.
- `codex-small-success.jsonl`, `codex-empty-final.jsonl` - synthetic, in the same
  event shape as the recordings.
