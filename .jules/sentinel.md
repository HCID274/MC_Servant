## 2026-01-18 - Timing Attack in WebSocket Auth
**Vulnerability:** The WebSocket authentication endpoint used simple string comparison (`!=`) for token verification.
**Learning:** String comparisons return early upon mismatch, allowing attackers to infer the token character by character by measuring response times.
**Prevention:** Use `secrets.compare_digest()` for all security-sensitive string comparisons (tokens, passwords, hashes) to ensure constant-time execution.
