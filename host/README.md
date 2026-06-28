# ClankerBend Host

ClankerBend is an independent OneWill project compatible with OpenAI Codex
Desktop. It is not affiliated with or endorsed by OpenAI.

This package contains reusable host primitives for ClankerBend `0.1`:

- loopback HTTP server
- JSON response envelopes and error envelopes
- app registry and app-scoped manifests/state/actions
- action idempotency by `(appId, actionId)`
- SSE state/action/heartbeat events
- transcript anchor state
- monotonic selection handling
- mock transcript adapter for tests and local development

The host does not contain VimNav-specific logic. Apps register a
manifest, static panel directory, state function, and action handler.
