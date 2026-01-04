import re
from typing import List


def split_to_segments(text: str, max_chars: int = 50) -> List[str]:
    """Split long text into display-friendly segments."""
    if not text:
        return []

    if len(text) <= max_chars:
        return [text]

    raw_parts = re.split(r"([。！？；.!?\n])", text)
    segments: List[str] = []
    current = ""

    for part in raw_parts:
        if len(current) + len(part) > max_chars:
            if current:
                segments.append(current)
                current = ""
            while len(part) > max_chars:
                segments.append(part[:max_chars])
                part = part[max_chars:]
            current = part
        else:
            current += part

    if current:
        segments.append(current)

    result: List[str] = []
    for i, seg in enumerate(segments):
        if i > 0:
            seg = "..." + seg
        if i < len(segments) - 1:
            seg = seg + "..."
        result.append(seg)

    return result
