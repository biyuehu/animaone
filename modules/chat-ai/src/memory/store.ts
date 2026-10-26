import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { ChatMessage } from './sliding-window'
import { modelMessage, userMessage } from './sliding-window'

export interface MemoryNode {
  readonly id?: number
  readonly level: 'topic' | 'day' | 'week' | 'month' | 'quarter' | 'year'
  readonly scopeKey: string
  readonly summary: string
  readonly tags?: string // 逗号分隔的概念线索词，供顺藤摸瓜联想
  readonly startTime: number
  readonly endTime: number
  readonly createdAt: number
}

export interface UserFact {
  readonly id?: number
  readonly userId: string
  readonly fact: string
  readonly category: 'preference' | 'identity' | 'event' | 'relation'
  readonly weight: number
  readonly updatedAt: number
}

export interface MemoryLink {
  readonly fromId: number
  readonly toId: number
  readonly concept: string
  readonly strength: number
}

export class MemoryDatabase {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.initTables()
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        summary TEXT NOT NULL,
        tags TEXT DEFAULT '',
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_scope_level ON memory_nodes(scope_key, level);

      -- 概念关联图谱边表（Graph Association）
      CREATE TABLE IF NOT EXISTS memory_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id INTEGER NOT NULL,
        to_id INTEGER NOT NULL,
        concept TEXT NOT NULL,
        strength REAL DEFAULT 1.0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_links_from ON memory_links(from_id);
      CREATE INDEX IF NOT EXISTS idx_memory_links_concept ON memory_links(concept);

      CREATE TABLE IF NOT EXISTS user_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        fact TEXT NOT NULL,
        category TEXT NOT NULL,
        visibility TEXT DEFAULT 'private',
        source_scope TEXT DEFAULT '',
        source_context TEXT DEFAULT '',
        weight INTEGER DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_profile_user ON user_profiles(user_id);

      -- 短期多轮对话持久化表（防止重启后失忆）
      CREATE TABLE IF NOT EXISTS recent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_key TEXT NOT NULL,
        role TEXT NOT NULL,
        user_id TEXT DEFAULT '',
        sender_name TEXT DEFAULT '',
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recent_scope ON recent_messages(scope_key);

      -- 插件系统元数据表（存储首次启动时间等核心档案）
      CREATE TABLE IF NOT EXISTS bot_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)

    // 自动数据库无损平滑迁移：兼容旧数据库增加 user_id / sender_name 字段
    try {
      this.db.exec(`
        ALTER TABLE recent_messages ADD COLUMN user_id TEXT DEFAULT '';
      `)
    } catch {}
    try {
      this.db.exec(`
        ALTER TABLE recent_messages ADD COLUMN sender_name TEXT DEFAULT '';
      `)
    } catch {}
    try {
      this.db.exec(`
        ALTER TABLE user_profiles ADD COLUMN visibility TEXT DEFAULT 'private';
      `)
    } catch {}
    try {
      this.db.exec(`
        ALTER TABLE user_profiles ADD COLUMN source_scope TEXT DEFAULT '';
      `)
    } catch {}
    try {
      this.db.exec(`
        ALTER TABLE user_profiles ADD COLUMN source_context TEXT DEFAULT '';
      `)
    } catch {}
  }

  public addNode(node: MemoryNode): number {
    const stmt = this.db.prepare(
      'INSERT INTO memory_nodes (level, scope_key, summary, tags, start_time, end_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    const result = stmt.run(
      node.level,
      node.scopeKey,
      node.summary,
      node.tags ?? '',
      node.startTime,
      node.endTime,
      node.createdAt ?? Date.now()
    )
    const newId = Number(result.lastInsertRowid)

    // 如果包含概念线索标签，顺藤摸瓜与历史节点自动织网连边
    if (node.tags) {
      const tagList = node.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      for (const tag of tagList) {
        const related = this.db
          .prepare('SELECT id FROM memory_nodes WHERE id != ? AND tags LIKE ? ORDER BY end_time DESC LIMIT 2')
          .all(newId, `%${tag}%`) as { id: number }[]
        for (const target of related) {
          this.linkNodes(newId, target.id, tag)
        }
      }
    }

    return newId
  }

  public linkNodes(fromId: number, toId: number, concept: string): void {
    this.db
      .prepare('INSERT INTO memory_links (from_id, to_id, concept, strength, created_at) VALUES (?, ?, ?, 1.0, ?)')
      .run(fromId, toId, concept, Date.now())
  }

  public getPyramidMemories(scopeKey: string, maxNodes = 10): MemoryNode[] {
    const directNodes = this.db
      .prepare(
        'SELECT id, level, scope_key as scopeKey, summary, tags, start_time as startTime, end_time as endTime, created_at as createdAt FROM memory_nodes WHERE scope_key = ? ORDER BY end_time DESC LIMIT ?'
      )
      .all(scopeKey, maxNodes) as unknown as MemoryNode[]

    // 顺藤摸瓜主动联想（沿着图谱关联边带出关键线索）
    if (directNodes.length === 0) return []
    const ids = directNodes.map((n) => n.id).filter((id): id is number => typeof id === 'number')
    if (ids.length === 0) return directNodes
    const placeholders = ids.map(() => '?').join(',')
    const associated = this.db
      .prepare(`
        SELECT m.id, m.level, m.scope_key as scopeKey, m.summary, m.tags, m.start_time as startTime, m.end_time as endTime, m.created_at as createdAt
        FROM memory_links l
        JOIN memory_nodes m ON l.to_id = m.id
        WHERE l.from_id IN (${placeholders})
        LIMIT 3
      `)
      .all(...ids) as unknown as MemoryNode[]

    const existingIds = new Set(ids)
    const combined = [...directNodes]
    for (const node of associated) {
      if (node.id && !existingIds.has(node.id)) {
        combined.push(node)
        existingIds.add(node.id)
      }
    }

    return combined
  }

  public getRandomNodesForReflection(limit = 2): MemoryNode[] {
    return this.db
      .prepare(
        'SELECT id, level, scope_key as scopeKey, summary, tags, start_time as startTime, end_time as endTime, created_at as createdAt FROM memory_nodes ORDER BY RANDOM() LIMIT ?'
      )
      .all(limit) as unknown as MemoryNode[]
  }

  public upsertFact(
    userId: string,
    fact: string,
    category: 'preference' | 'identity' | 'event' | 'relation' = 'preference',
    visibility: 'public' | 'private' = 'private',
    sourceScope = '',
    sourceContext = ''
  ): void {
    const exists = this.db.prepare('SELECT id FROM user_profiles WHERE user_id = ? AND fact = ?').get(userId, fact)
    if (exists) {
      this.db
        .prepare(
          'UPDATE user_profiles SET weight = weight + 1, visibility = ?, source_scope = ?, source_context = ?, updated_at = ? WHERE user_id = ? AND fact = ?'
        )
        .run(visibility, sourceScope, sourceContext, Date.now(), userId, fact)
    } else {
      this.db
        .prepare(
          'INSERT INTO user_profiles (user_id, fact, category, visibility, source_scope, source_context, weight, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)'
        )
        .run(userId, fact, category, visibility, sourceScope, sourceContext, Date.now())
    }
  }

  public getAllRecentNodes(limit = 10, platformFilter?: string): MemoryNode[] {
    if (platformFilter) {
      return this.db
        .prepare(
          'SELECT id, level, scope_key as scopeKey, summary, tags, start_time as startTime, end_time as endTime, created_at as createdAt FROM memory_nodes WHERE scope_key LIKE ? ORDER BY end_time DESC LIMIT ?'
        )
        .all(`${platformFilter}:%`, limit) as unknown as MemoryNode[]
    }
    return this.db
      .prepare(
        'SELECT id, level, scope_key as scopeKey, summary, tags, start_time as startTime, end_time as endTime, created_at as createdAt FROM memory_nodes ORDER BY end_time DESC LIMIT ?'
      )
      .all(limit) as unknown as MemoryNode[]
  }

  public getProfileFacts(userId: string, limit = 20, visibilityFilter?: 'public' | 'private'): string[] {
    const query = visibilityFilter
      ? 'SELECT fact FROM user_profiles WHERE user_id = ? AND visibility = ? ORDER BY weight DESC, updated_at DESC LIMIT ?'
      : 'SELECT fact FROM user_profiles WHERE user_id = ? ORDER BY weight DESC, updated_at DESC LIMIT ?'
    const rows = (
      visibilityFilter
        ? this.db.prepare(query).all(userId, visibilityFilter, limit)
        : this.db.prepare(query).all(userId, limit)
    ) as { fact: string }[]
    return rows.map((r) => r.fact)
  }

  public saveRecentMessage(
    scopeKey: string,
    role: 'user' | 'model',
    content: string,
    userId = '',
    senderName = ''
  ): void {
    this.db
      .prepare(
        'INSERT INTO recent_messages (scope_key, role, user_id, sender_name, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(scopeKey, role, userId, senderName, content, Date.now())

    // 保持每个 scope 最多保留 30 条最近消息
    this.db
      .prepare(`
        DELETE FROM recent_messages
        WHERE scope_key = ? AND id NOT IN (
          SELECT id FROM recent_messages WHERE scope_key = ? ORDER BY id DESC LIMIT 30
        )
      `)
      .run(scopeKey, scopeKey)
  }

  public loadRecentMessages(scopeKey: string, limit = 20): ChatMessage[] {
    const rows = this.db
      .prepare(
        'SELECT role, content, user_id as userId, sender_name as senderName, created_at as timestamp FROM recent_messages WHERE scope_key = ? ORDER BY id DESC LIMIT ?'
      )
      .all(scopeKey, limit) as {
      role: 'user' | 'model'
      content: string
      timestamp: number
      userId: string
      senderName: string
    }[]
    return rows
      .reverse()
      .map((r) =>
        r.role === 'model'
          ? modelMessage(r.content, r.timestamp)
          : userMessage(r.content, r.userId, r.senderName, r.timestamp)
      )
  }

  /**
   * 调取跨会话/跨平台的全局最新近期原话（不依赖满10轮压缩）
   */
  public getGlobalRecentMessages(
    limit = 8,
    platformFilter?: string
  ): {
    scope: string
    role: string
    userId: string
    senderName: string
    content: string
    time: string
  }[] {
    const query = platformFilter
      ? 'SELECT scope_key, role, user_id, sender_name, content, created_at FROM recent_messages WHERE scope_key LIKE ? ORDER BY id DESC LIMIT ?'
      : 'SELECT scope_key, role, user_id, sender_name, content, created_at FROM recent_messages ORDER BY id DESC LIMIT ?'
    const rows = (
      platformFilter ? this.db.prepare(query).all(`${platformFilter}:%`, limit) : this.db.prepare(query).all(limit)
    ) as {
      scope_key: string
      role: string
      user_id: string
      sender_name: string
      content: string
      created_at: number
    }[]

    return rows.map((r) => ({
      scope: r.scope_key,
      role: r.role,
      userId: r.user_id,
      senderName: r.sender_name,
      content: r.content,
      time: new Date(r.created_at).toLocaleString('zh-CN')
    }))
  }

  /**
   * 记录并获取 AI Bot 第一次诞生的时间（首次写入后永不改变）
   */
  public getOrCreateBirthTime(): number {
    const row = this.db.prepare('SELECT value FROM bot_metadata WHERE key = ?').get('birth_time') as
      | { value: string }
      | undefined
    if (row?.value) {
      return Number(row.value)
    }
    const now = Date.now()
    this.db
      .prepare('INSERT INTO bot_metadata (key, value, created_at) VALUES (?, ?, ?)')
      .run('birth_time', String(now), now)
    return now
  }

  /**
   * 深度回溯历史对话与记忆（翻旧账能力）：
   * 支持按关键字搜索或时间倒序分页调取更久远之前的原话记录
   */
  public searchDeepHistory(
    scopeKey: string,
    options: { keyword?: string; limit?: number; offset?: number } = {}
  ): { role: string; content: string; time: string }[] {
    const limit = options.limit ?? 10
    const offset = options.offset ?? 0

    let rows: { role: string; content: string; created_at: number }[] = []
    if (options.keyword) {
      rows = this.db
        .prepare(
          'SELECT role, content, created_at FROM recent_messages WHERE scope_key = ? AND content LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?'
        )
        .all(scopeKey, `%${options.keyword}%`, limit, offset) as {
        role: string
        content: string
        created_at: number
      }[]
    } else {
      rows = this.db
        .prepare(
          'SELECT role, content, created_at FROM recent_messages WHERE scope_key = ? ORDER BY id DESC LIMIT ? OFFSET ?'
        )
        .all(scopeKey, limit, offset) as { role: string; content: string; created_at: number }[]
    }

    return rows.map((r) => ({
      role: r.role,
      content: r.content,
      time: new Date(r.created_at).toLocaleString('zh-CN')
    }))
  }
}
