import re
import unittest

def check_authme_logic(msg, args):
    """
    Simulates the security logic in backend/bot/mineflayer_adapter.py
    This function must be kept in sync with the actual implementation.
    """
    msg_lower = msg.lower()

    # args: [position, sender]
    position = args[0] if len(args) > 0 else "chat"
    sender = args[1] if len(args) > 1 else None

    # Logic from on_message
    is_system = (position == 'system' or position == 'game_info')
    if not is_system and position == 'chat':
        # Check if sender is None or nil UUID
        if not sender or sender == "00000000-0000-0000-0000-000000000000":
            is_system = True

    if not is_system:
        return False # Ignored (Spoofing attempt or player chat)

    should_login = False

    if "/login" in msg_lower or "/register" in msg_lower:
        # Strict regex check
        if re.search(r"(?i)(?:please|use|command|/login|/register)", msg):
            should_login = True

    return should_login

class TestAuthMeSecurity(unittest.TestCase):
    def test_legit_system_prompts(self):
        # Case 1: Standard system message
        self.assertTrue(check_authme_logic("Please /login password", ["system", None]))

        # Case 2: System message sent as chat with no sender (common plugin behavior)
        self.assertTrue(check_authme_logic("Please /login password", ["chat", None]))

        # Case 3: System message with nil UUID
        self.assertTrue(check_authme_logic("Please /login password", ["chat", "00000000-0000-0000-0000-000000000000"]))

        # Case 4: Various AuthMe formats
        self.assertTrue(check_authme_logic("/login <password>", ["system", None]))
        self.assertTrue(check_authme_logic("Use /login to authenticate", ["system", None]))
        self.assertTrue(check_authme_logic("Command: /login password", ["system", None]))
        self.assertTrue(check_authme_logic("[AuthMe] Please register /register ...", ["system", None]))

    def test_spoofing_attempts(self):
        # Case 1: Player sending the exact same message
        # position='chat', sender=Valid UUID
        player_uuid = "12345678-1234-1234-1234-123456789012"
        self.assertFalse(check_authme_logic("Please /login password", ["chat", player_uuid]))

        # Case 2: Player trying to mimic system prefix
        self.assertFalse(check_authme_logic("[Server] Please /login", ["chat", player_uuid]))

        # Case 3: Player chat with keywords
        self.assertFalse(check_authme_logic("Player: Please /login", ["chat", player_uuid]))
        self.assertFalse(check_authme_logic("<Player> Please /login", ["chat", player_uuid]))

    def test_non_login_messages(self):
        # Case 1: Generic system messages should not trigger login
        self.assertFalse(check_authme_logic("Welcome to the server!", ["system", None]))
        self.assertFalse(check_authme_logic("Server restarting", ["system", None]))

if __name__ == "__main__":
    unittest.main()
