# pi-claude-runtime

Run Claude Code inside Pi through Anthropic's official Agent SDK.

## Install

```sh
pi install git:github.com/m7l5/pi-claude-runtime
```

Requires Pi 0.80.10+, Claude Code on `PATH`, and `claude auth login`.

Select a model from the `claude-runtime` provider. Claude owns its tool loop while Pi keeps the authoritative session and UI. Cross-model switches use branch-safe, compaction-aware handoffs.

## Commands

```text
/handoff-claude <goal>
/claude-permissions full-access|interactive
/claude-version
/claude-update
```

MIT
