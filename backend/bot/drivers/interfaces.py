# Driver Adapter Interfaces

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class IDriverAdapter(ABC):
    """Abstract driver interface for bot/world interaction."""

    @property
    @abstractmethod
    def bot(self) -> Any:
        """Raw bot handle (driver-specific)."""

    @property
    @abstractmethod
    def mcdata(self) -> Any:
        """Minecraft data handle (driver-specific)."""

    @property
    @abstractmethod
    def pathfinder(self) -> Any:
        """Pathfinder handle (driver-specific)."""

    @property
    @abstractmethod
    def goals(self) -> Any:
        """Pathfinder goals handle (driver-specific)."""

    @abstractmethod
    def vec3(self, x: int, y: int, z: int) -> Any:
        """Create a Vec3 object compatible with the driver."""

    @abstractmethod
    def stop_pathfinder(self) -> None:
        """Stop pathfinder movement."""

    @abstractmethod
    def chat(self, message: str) -> None:
        """Send chat message via the driver."""

    @property
    @abstractmethod
    def username(self) -> str:
        """Bot username."""
