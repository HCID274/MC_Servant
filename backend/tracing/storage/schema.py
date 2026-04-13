AGENT_RUN_TABLE_SQL = """
-- 任务主表：记录单次指令执行的全生命周期状态
CREATE TABLE agent_run (
    run_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    bot_name TEXT NOT NULL,
    player_name TEXT NOT NULL,
    source_type TEXT NOT NULL,
    request_type TEXT NOT NULL DEFAULT 'player_message',
    user_input TEXT NOT NULL,
    request_payload_json TEXT NOT NULL,
    env_snapshot_json TEXT,
    status TEXT NOT NULL,
    intent TEXT,
    reply_text TEXT,
    error_code TEXT,
    error_message TEXT,
    latest_checkpoint_id TEXT,
    checkpoint_count INTEGER NOT NULL DEFAULT 0,
    workflow_name TEXT NOT NULL DEFAULT 'main_workflow',
    workflow_version TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    duration_ms INTEGER
);
"""

LLM_CALL_TABLE_SQL = """
-- 模型调用表：审计单次大模型交互的输入输出与消耗
CREATE TABLE llm_call (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    node_name TEXT NOT NULL,
    call_seq INTEGER NOT NULL,
    prompt_name TEXT NOT NULL,
    model_name TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'openai',
    base_url TEXT,
    request_messages_json TEXT NOT NULL,
    rendered_prompt_text TEXT NOT NULL,
    prompt_sha256 TEXT,
    raw_response_text TEXT,
    parsed_output_json TEXT,
    parse_ok INTEGER NOT NULL DEFAULT 0,
    parse_error TEXT,
    usage_json TEXT,
    latency_ms INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(run_id) REFERENCES agent_run(run_id)
);
"""

RUN_EVENT_TABLE_SQL = """
-- 执行事件表：记录工作流执行过程中的关键逻辑节点（打点）
CREATE TABLE run_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    thread_id TEXT,
    stage TEXT NOT NULL,
    event_name TEXT NOT NULL,
    node_name TEXT,
    step_index INTEGER,
    payload_json TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(run_id) REFERENCES agent_run(run_id)
);
"""

STEP_SUMMARY_TABLE_SQL = """
-- 步骤摘要表：存储被压缩后的语义记录，用于上下文检索与长短期记忆对齐
CREATE TABLE step_summary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    summary_id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    step_index INTEGER NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    kind TEXT NOT NULL,
    summary_text TEXT NOT NULL,
    summary_input_json TEXT,
    detail_ref_json TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(run_id) REFERENCES agent_run(run_id)
);
"""
