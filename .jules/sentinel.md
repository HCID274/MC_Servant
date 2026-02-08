## 2026-01-18 - Timing Attack in WebSocket Auth
**Vulnerability:** The WebSocket authentication endpoint used simple string comparison (`!=`) for token verification.
**Learning:** String comparisons return early upon mismatch, allowing attackers to infer the token character by character by measuring response times.
**Prevention:** Use `secrets.compare_digest()` for all security-sensitive string comparisons (tokens, passwords, hashes) to ensure constant-time execution.

## 2026-02-18 - Unbounded Pydantic Fields (DoS Risk)
**Vulnerability:** Message models (e.g., `PlayerMessage`) accepted strings of arbitrary length, allowing attackers to crash the server with massive payloads (DoS).
**Learning:** Pydantic `str` fields default to no max length. Validating only types is insufficient for public-facing inputs.
**Prevention:** Always use `Field(..., max_length=N)` for string inputs in Pydantic models to enforce reasonable limits.
