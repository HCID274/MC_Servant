import json
import re
from typing import Any, TypeVar

from pydantic import BaseModel


ModelT = TypeVar("ModelT", bound=BaseModel)

_CODE_BLOCK_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL | re.IGNORECASE)


def stringify_message_content(content: Any) -> str:
    """文本提取器：将 LangChain 的各种消息内容统一转化为纯文本字符串。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                text = item.get("text")
                if text:
                    parts.append(str(text))
            else:
                parts.append(str(item))
        return "\n".join(parts).strip()
    return str(content or "").strip()


def extract_json_text(text: str) -> str:
    """JSON 提取器：从 LLM 返回的 Markdown 代码块或杂乱文本中精准剥离 JSON 字符串。"""
    source = (text or "").strip()
    if not source:
        raise ValueError("LLM 返回为空")

    # 优先匹配 Markdown 代码块。
    block_match = _CODE_BLOCK_RE.search(source)
    if block_match:
        source = block_match.group(1).strip()

    if source.startswith("{") or source.startswith("["):
        return source

    # 容错处理：若没有代码块，尝试通过首尾括号定位。
    for start_char, end_char in (("{", "}"), ("[", "]")):
        start = source.find(start_char)
        end = source.rfind(end_char)
        if start != -1 and end != -1 and end > start:
            return source[start : end + 1]

    raise ValueError("LLM 返回中未找到 JSON")


def parse_model_output(model_cls: type[ModelT], raw_text: str) -> tuple[ModelT, dict[str, Any], str]:
    """结构化转换器：将 LLM 原始文本解析并校验为 Pydantic 数据模型。"""
    json_text = extract_json_text(raw_text)
    payload = json.loads(json_text)
    model = model_cls.model_validate(payload)
    return model, payload, json_text
