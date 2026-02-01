
import sys
import pytest
from unittest.mock import MagicMock, patch

# Mock javascript module before importing bot.mineflayer_adapter
mock_javascript = MagicMock()
sys.modules['javascript'] = mock_javascript

# Mock require to return a mock object
mock_require = MagicMock()
mock_javascript.require = mock_require

# Mock On decorator
# On(emitter, event_name) returns a decorator
def mock_on(emitter, event_name):
    def decorator(func):
        # Store the handler in the emitter for triggering later
        if not hasattr(emitter, '_handlers'):
            emitter._handlers = {}
        emitter._handlers[event_name] = func
        return func
    return decorator

mock_javascript.On = mock_on

# Now import the class under test
from bot.mineflayer_adapter import MineflayerBot

class TestAuthMeSecurity:

    @pytest.fixture
    def bot(self):
        # Create a bot instance with password
        bot = MineflayerBot("localhost", 25565, "Bot", "secret_password")

        # Mock internal _bot object
        bot._bot = MagicMock()
        bot._bot._handlers = {} # For our mock_on

        # Mock chat method
        bot._bot.chat = MagicMock()

        # Call _register_events to register handlers
        bot._register_events()

        return bot

    def test_authme_login_from_chat_spoof_is_ignored(self, bot):
        """
        Test that a chat message mimicking AuthMe prompt is IGNORED (Security Fix)
        """
        # Case 1: Standard chat message with colon - should be IGNORED
        msg_chat = "Player: Please /login password"
        bot._bot._handlers['message'](bot, msg_chat, 'chat', 'uuid', True)
        bot._bot.chat.assert_not_called()

        # Case 2: Chat message WITHOUT colon (e.g. server plugin or specific format)
        # "Server > Please /login password" (no colon)
        # OR just "Please /login password" (some servers)
        msg_spoof = "Please /login password"

        # We pass 'chat' (or 0) as position to indicate it's from a player
        bot._bot._handlers['message'](bot, msg_spoof, 'chat', 'uuid', True)

        # Expectation: Secure code should NOT try to login
        bot._bot.chat.assert_not_called()

    def test_authme_login_from_system_message(self, bot):
        """Test that legitimate system message triggers login"""
        msg_system = "Please /login <password>"

        # Simulate system message (position='system' or 1)
        bot._bot._handlers['message'](bot, msg_system, 'system', None, True)

        bot._bot.chat.assert_called_with("/login secret_password")
