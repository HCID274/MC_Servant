## 2026-01-18 - Timing Attack in WebSocket Auth
**Vulnerability:** The WebSocket authentication endpoint used simple string comparison (`!=`) for token verification.
**Learning:** String comparisons return early upon mismatch, allowing attackers to infer the token character by character by measuring response times.
**Prevention:** Use `secrets.compare_digest()` for all security-sensitive string comparisons (tokens, passwords, hashes) to ensure constant-time execution.

## 2026-01-18 - DoS Risk via Unbounded Protocol Inputs
**Vulnerability:** `PlayerMessage` and other protocol models lacked length constraints, allowing potentially infinite string inputs which could lead to DoS via memory exhaustion or log flooding.
**Learning:** Backend services must validate input boundaries even from semi-trusted components (like plugins) to practice defense in depth.
**Prevention:** Always apply `Field(max_length=...)` constraints to Pydantic models for all string inputs exposed to network interfaces.
