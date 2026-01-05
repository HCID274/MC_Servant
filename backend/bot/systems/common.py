# Shared system utilities

from __future__ import annotations

import logging
import re
import time
from typing import Any, List

from bot.drivers.interfaces import IDriverAdapter

logger = logging.getLogger(__name__)

_INT_RE = re.compile(r"-?\d+")


def _coerce_js_int(value: Any) -> int:
    """
    Safely coerce a JS proxy value into int when possible.
    """
    if value is None:
        raise TypeError("cannot coerce None to int")

    if isinstance(value, bool):
        raise TypeError("cannot coerce bool to int")

    if isinstance(value, int):
        return value

    if isinstance(value, float):
        return int(value)

    if isinstance(value, str):
        s = value.strip()
        if s == "":
            raise ValueError("empty string")
        try:
            return int(s)
        except ValueError:
            return int(float(s))

    try:
        return int(value)  # type: ignore[arg-type]
    except Exception:
        pass

    try:
        return _coerce_js_int(str(value))
    except Exception:
        pass

    m = _INT_RE.search(repr(value))
    if m:
        return int(m.group(0))

    raise TypeError(f"cannot coerce {type(value)} to int: {value!r}")


class ProgressTimer:
    """Progress-aware timeout helper."""

    def __init__(self, timeout_seconds: float = 30.0) -> None:
        self._timeout = timeout_seconds
        self._last_progress_time = time.time()
        self._progress_count = 0
        self._progress_log: List[str] = []

    def reset(self, event_name: str = "progress") -> None:
        self._last_progress_time = time.time()
        self._progress_count += 1
        self._progress_log.append(f"{event_name}@{time.time():.2f}")
        logger.debug(f"[ProgressTimer] Reset by {event_name}, count={self._progress_count}")

    def is_expired(self) -> bool:
        return (time.time() - self._last_progress_time) > self._timeout

    def elapsed_since_progress(self) -> float:
        return time.time() - self._last_progress_time

    @property
    def progress_count(self) -> int:
        return self._progress_count


class BackgroundTaskManager:
    """Track background threads and coordinate shutdown."""

    def __init__(self, driver: IDriverAdapter) -> None:
        import threading

        self._driver = driver
        self._threads: List[threading.Thread] = []
        self._lock = threading.Lock()
        self._shutdown_requested = False

    @property
    def shutdown_requested(self) -> bool:
        return self._shutdown_requested

    def track_thread(self, thread: "threading.Thread") -> None:
        with self._lock:
            self._threads = [t for t in self._threads if t.is_alive()]
            self._threads.append(thread)

    def stop_all(self, timeout: float = 5.0) -> int:
        self._shutdown_requested = True
        self._driver.stop_pathfinder()

        with self._lock:
            threads = list(self._threads)

        still_running = 0
        for t in threads:
            if t.is_alive():
                t.join(timeout=timeout / len(threads) if threads else timeout)
                if t.is_alive():
                    still_running += 1
                    logger.warning(f"Thread {t.name} did not terminate in time")

        with self._lock:
            self._threads.clear()

        self._shutdown_requested = False
        return still_running
