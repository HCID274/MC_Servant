## 2026-01-18 - Timing Attack in WebSocket Auth
**Vulnerability:** The WebSocket authentication endpoint used simple string comparison (`!=`) for token verification.
**Learning:** String comparisons return early upon mismatch, allowing attackers to infer the token character by character by measuring response times.
**Prevention:** Use `secrets.compare_digest()` for all security-sensitive string comparisons (tokens, passwords, hashes) to ensure constant-time execution.

## 2026-02-15 - AuthMe Login Spoofing via Chat
**Vulnerability:** The AuthMe login detection logic relied on weak heuristics (presence of colon) to filter out player chat, allowing players to spoof system messages (e.g., "Please /login") and trick the bot into sending its password.
**Learning:** Heuristics based on message content are fragile against spoofing. Relying on protocol-level metadata (like message position/type) is crucial for security-sensitive operations.
**Prevention:** Always verify the source and type of the message (e.g., `position == 'system'` or `game_info`) before performing privileged actions like authentication, rather than parsing the message text alone.
