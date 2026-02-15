## 2026-01-18 - Timing Attack in WebSocket Auth
**Vulnerability:** The WebSocket authentication endpoint used simple string comparison (`!=`) for token verification.
**Learning:** String comparisons return early upon mismatch, allowing attackers to infer the token character by character by measuring response times.
**Prevention:** Use `secrets.compare_digest()` for all security-sensitive string comparisons (tokens, passwords, hashes) to ensure constant-time execution.

## 2026-05-24 - AuthMe Login Spoofing
**Vulnerability:** The bot used loose keyword matching (e.g., "please" + "/login") to detect AuthMe prompts, allowing players to trick the bot into sending its password by mimicking system messages in public chat.
**Learning:** Text content alone is insufficient for verifying the origin of a message in Minecraft. Players can easily craft messages that look like system prompts.
**Prevention:** Always validate the message source metadata (`position` == 'system'/'game_info' or `sender` is nil/zero UUID) before performing sensitive actions like authentication. Use strict regex anchors to prevent prefix injection.
