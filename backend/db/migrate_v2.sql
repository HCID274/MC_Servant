-- MC_Servant Database Migration v2
-- 从 JSON 配置迁移到 PostgreSQL
-- 执行前请确保数据库已连接

-- ============================================
-- Phase 0: 清空测试数据
-- ============================================
TRUNCATE TABLE compression_logs, conversation_contexts, players, bots CASCADE;

-- ============================================
-- Phase 1: 扩展 players 表
-- ============================================
ALTER TABLE players 
ADD COLUMN IF NOT EXISTS is_online BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS last_login TIMESTAMP;

COMMENT ON COLUMN players.is_online IS '当前是否在线';
COMMENT ON COLUMN players.last_login IS '最后登录时间';

-- ============================================
-- Phase 2: 扩展 bots 表
-- ============================================
ALTER TABLE bots
ADD COLUMN IF NOT EXISTS owner_name VARCHAR(16),
ADD COLUMN IF NOT EXISTS skin_url TEXT,
ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS auto_spawn BOOLEAN DEFAULT TRUE;

-- 为 owner_uuid 添加索引 (如果不存在)
CREATE INDEX IF NOT EXISTS ix_bots_owner_uuid ON bots(owner_uuid);

COMMENT ON COLUMN bots.owner_name IS '当前主人名称';
COMMENT ON COLUMN bots.skin_url IS '皮肤 URL';
COMMENT ON COLUMN bots.claimed_at IS '认领时间';
COMMENT ON COLUMN bots.auto_spawn IS '主人上线时自动生成';

-- ============================================
-- Phase 3: 插入默认 Bot (Alice)
-- ============================================
INSERT INTO bots (name, personality, auto_spawn, created_at, updated_at) 
VALUES (
    'Alice', 
    '你是 Alice，一只可爱的猫娘女仆助手~ 每句话结尾都要加上"喵~"', 
    TRUE,
    NOW(),
    NOW()
) ON CONFLICT (name) DO NOTHING;

-- ============================================
-- 验证结果
-- ============================================
SELECT 'Players 表结构:' AS info;
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'players' 
ORDER BY ordinal_position;

SELECT 'Bots 表结构:' AS info;
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'bots'
ORDER BY ordinal_position;

SELECT 'Bots 数据:' AS info;
SELECT id, name, owner_uuid, owner_name, auto_spawn FROM bots;
