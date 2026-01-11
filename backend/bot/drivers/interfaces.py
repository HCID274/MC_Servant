# Driver Adapter Interfaces

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Optional, List, Dict


class IDriverAdapter(ABC):
    """Abstract driver interface for bot/world interaction."""

    @abstractmethod
    def vec3(self, x: int, y: int, z: int) -> Any:
        """Create a Vec3 object compatible with the driver."""

    # Navigation goals
    @abstractmethod
    def create_goal_near(self, x: int, y: int, z: int, reach: int) -> Any:
        """Create a goal near a position."""

    @abstractmethod
    def create_goal_near_xz(self, x: int, z: int, reach: int, y_hint: Optional[int] = None) -> Any:
        """Create a goal near an XZ position with optional Y hint."""

    @abstractmethod
    def create_goal_block(self, x: int, y: int, z: int) -> Any:
        """Create a goal for a specific block position."""

    @abstractmethod
    def goal_target_coords(self, goal: Any) -> Optional[tuple[int, int, int]]:
        """Extract target coordinates from a goal, if available."""

    @abstractmethod
    def is_goal_reached(self, goal: Any, position: Any) -> bool:
        """Return whether the current position satisfies the goal."""

    # Navigation
    @abstractmethod
    def set_goal(self, goal: Any) -> None:
        """Set a pathfinder goal."""

    @abstractmethod
    def is_moving(self) -> bool:
        """Return whether the pathfinder is moving."""

    @abstractmethod
    def current_goal(self) -> Any:
        """Return the current goal (if any)."""

    # Entity + Control
    @abstractmethod
    def get_position(self) -> Any:
        """Get current bot position."""

    @abstractmethod
    def get_health(self) -> float:
        """Get current bot health."""

    @abstractmethod
    def get_food(self) -> int:
        """Get current bot food level."""

    @abstractmethod
    def look_at(self, target: Any) -> None:
        """Look at a target position."""

    @abstractmethod
    def set_control_state(self, control: str, state: bool) -> None:
        """Set a control state such as forward/jump."""

    @abstractmethod
    def get_player(self, name: str) -> Optional[Any]:
        """Get a player handle by name."""

    @abstractmethod
    def get_player_names(self) -> List[str]:
        """List known player names."""

    # World
    @abstractmethod
    def block_at(self, pos: Any) -> Any:
        """Get block at a position."""

    @abstractmethod
    async def dig(self, block: Any) -> None:
        """Dig a block."""

    @abstractmethod
    def find_blocks(self, query: Any) -> Any:
        """Find blocks with a driver-specific query."""

    @abstractmethod
    def find_block(self, query: Any) -> Any:
        """Find a single block with a driver-specific query."""

    @abstractmethod
    def place_block(self, reference_block: Any, offset: Any) -> None:
        """Place a block relative to a reference block."""

    @abstractmethod
    def collect_block(self, block: Any) -> None:
        """Collect a block using the driver plugin, if available."""

    @abstractmethod
    def get_entities(self) -> Dict[int, Any]:
        """Get visible entities keyed by id."""

    @abstractmethod
    def get_inventory_items(self) -> List[Any]:
        """Get inventory items."""

    @abstractmethod
    def get_held_item(self) -> Optional[Any]:
        """Get the currently held item."""

    @abstractmethod
    def equip_item(self, item: Any, destination: str = "hand") -> None:
        """Equip an item to a destination slot."""

    @abstractmethod
    def toss_item(self, item_type: Any, metadata: Any, count: int) -> None:
        """Toss items from inventory."""

    @abstractmethod
    def get_yaw(self) -> float:
        """Get current yaw."""

    # Crafting + Window
    @abstractmethod
    def recipes_all(self, item_id: int, crafting_table: Any = None) -> Any:
        """Get all recipes for an item."""

    @abstractmethod
    def recipes_for(self, item_id: int, count: Optional[int] = None, crafting_table: Any = None) -> Any:
        """Get recipes for an item with optional count."""

    @abstractmethod
    def craft_recipe(self, recipe: Any, count: int, crafting_table: Any = None) -> None:
        """Craft using a recipe."""

    @abstractmethod
    def get_current_window(self) -> Any:
        """Get current open window."""

    @abstractmethod
    def get_inventory_window(self) -> Any:
        """Get inventory window handle."""

    @abstractmethod
    def get_inventory_slots(self) -> List[Any]:
        """Get inventory slots."""

    @abstractmethod
    def click_window(self, slot: int, mouse_button: int, mode: int) -> None:
        """Click a window slot."""

    @abstractmethod
    def activate_block(self, block: Any) -> None:
        """Activate a block (e.g., open crafting table)."""

    @abstractmethod
    def open_furnace(self, block: Any) -> Any:
        """Open a furnace."""

    @abstractmethod
    def open_blast_furnace(self, block: Any) -> Any:
        """Open a blast furnace."""

    @abstractmethod
    def open_smoker(self, block: Any) -> Any:
        """Open a smoker."""

    @abstractmethod
    def get_window_title(self, window: Any) -> str:
        """Get a window title."""

    @abstractmethod
    def get_window_type(self, window: Any) -> str:
        """Get a window type."""

    @abstractmethod
    def get_window_slots(self, window: Any) -> List[Any]:
        """Get slots from a window."""

    @abstractmethod
    def get_window_slot(self, window: Any, index: int) -> Any:
        """Get a slot by index from a window."""

    @abstractmethod
    def get_window_length(self, window: Any) -> int:
        """Get window slots length."""

    @abstractmethod
    def stop_pathfinder(self) -> None:
        """Stop pathfinder movement."""

    @abstractmethod
    def chat(self, message: str) -> None:
        """Send chat message via the driver."""

    # Data lookups
    @abstractmethod
    def get_item_id(self, item_name: str) -> Optional[int]:
        """Get item id by name."""

    @abstractmethod
    def get_item_name(self, item_id: int) -> Optional[str]:
        """Get item name by id."""

    @abstractmethod
    def get_block_id(self, block_name: str) -> Optional[int]:
        """Get block id by name."""

    @abstractmethod
    def get_recipe_data(self, item_id: int) -> Any:
        """Get raw recipe data for an item id."""

    @property
    @abstractmethod
    def username(self) -> str:
        """Bot username."""
