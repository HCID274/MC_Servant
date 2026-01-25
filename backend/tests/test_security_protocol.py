import sys
import os
import pytest
from pydantic import ValidationError

# Ensure backend is in path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from protocol import PlayerMessage, ServantCommandMessage

def test_player_message_content_limit():
    """Verify that PlayerMessage.content is limited to 1000 chars."""
    # 1. Normal content should pass
    msg = PlayerMessage(content="Hello" * 10, player="test")
    assert msg.content == "Hello" * 10

    # 2. Oversized content should fail
    long_content = "A" * 1001
    with pytest.raises(ValidationError, match="String should have at most 1000 characters"):
        PlayerMessage(content=long_content, player="test")

def test_player_name_limit():
    """Verify that PlayerMessage.player is limited to 32 chars."""
    # 1. Normal name
    msg = PlayerMessage(content="hi", player="Steve")
    assert msg.player == "Steve"

    # 2. Oversized name
    long_name = "A" * 33
    with pytest.raises(ValidationError, match="String should have at most 32 characters"):
        PlayerMessage(content="hi", player=long_name)

def test_servant_command_limits():
    """Verify limits on ServantCommandMessage fields."""
    # Target bot name limit
    with pytest.raises(ValidationError):
        ServantCommandMessage(
            command="claim",
            target_bot="A" * 33,
            player="Steve"
        )

    # Player name limit
    with pytest.raises(ValidationError):
        ServantCommandMessage(
            command="claim",
            target_bot="Bot",
            player="A" * 33
        )
