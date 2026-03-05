from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from data.graph import build_graph
from data.schemas import TaskRouterOutput


def test_offline_router_enqueues_coal_mining_task(monkeypatch) -> None:
    def fake_invoke_task_router(_: str) -> TaskRouterOutput:
        return TaskRouterOutput(action="mine", target="coal_ore")

    monkeypatch.setattr("data.graph._invoke_task_router", fake_invoke_task_router)
    graph = build_graph()

    result = graph.invoke({"user_input": "去给我挖点煤。", "task_queue": []})

    assert result["intent"] == "task"
    assert result["task_queue"]
    assert result["task_queue"][0]["action"] == "mine"
    assert result["task_queue"][0]["target"] == "coal_ore"
