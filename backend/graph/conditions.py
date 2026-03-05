from schemas import MaidState


def router_branch(_: MaidState) -> str:
    """
    Router 条件边判断（骨架占位）。
    """
    raise NotImplementedError("TODO: 在编排层实现 Router 条件分流")


def verifier_branch(_: MaidState) -> str:
    """
    Verifier 条件边判断（骨架占位）。
    """
    raise NotImplementedError("TODO: 在编排层实现 Verifier 条件分流")

