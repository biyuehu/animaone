import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { rankDocuments } from '../core/retrieval'
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

export interface ProfileFactRecord {
  readonly id: number
  readonly fact: string
  readonly category: string
  readonly visibility: 'public' | 'private'
  readonly sourceScope: string
  readonly sourceContext: string
  readonly weight: number
  readonly updatedAt: number
}

export interface MemoryLink {
  readonly fromId: number
  readonly toId: number
  readonly concept: string
  readonly strength: number
}

export interface GraphTraversalResult {
  readonly nodes: MemoryNode[]
  readonly cluesToExplore: string[]
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
        message_id TEXT DEFAULT '',
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recent_scope ON recent_messages(scope_key);
      CREATE INDEX IF NOT EXISTS idx_recent_msg_id ON recent_messages(message_id);

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
        ALTER TABLE recent_messages ADD COLUMN message_id TEXT DEFAULT '';
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

  public getProfileFactRecords(
    userId: string,
    limit: number,
    visibilityFilter?: 'public' | 'private'
  ): ProfileFactRecord[] {
    // 严格遵循 refer2 一级记忆（工作区）排序与容量控制原则：
    // 一级记忆只看「评分 (weight)」与「创建/更新时间 (updated_at)」
    // 优先级：高评分排在前面；评分相同时，最新发生/更新的排在前面；
    // 超过 limit (activeMemoryCapacity) 的低分/陈旧事实自然被挤出工作区沉底。
    const query = visibilityFilter
      ? 'SELECT id, user_id as userId, fact, category, visibility, source_scope as sourceScope, source_context as sourceContext, weight, updated_at as updatedAt FROM user_profiles WHERE user_id = ? AND visibility = ? ORDER BY weight DESC, updated_at DESC LIMIT ?'
      : 'SELECT id, user_id as userId, fact, category, visibility, source_scope as sourceScope, source_context as sourceContext, weight, updated_at as updatedAt FROM user_profiles WHERE user_id = ? ORDER BY weight DESC, updated_at DESC LIMIT ?'

    return (visibilityFilter
      ? this.db.prepare(query).all(userId, visibilityFilter, limit)
      : this.db.prepare(query).all(userId, limit)) as unknown as ProfileFactRecord[]
  }

  public getProfileFacts(userId: string, limit: number, visibilityFilter?: 'public' | 'private'): string[] {
    return this.getProfileFactRecords(userId, limit, visibilityFilter).map((r) => r.fact)
  }

  /**
   * 严格借鉴 refer2 的分词重叠度 + 时序打分：深度检索 user_profiles 历史画像
   */
  public searchProfileFacts(
    userId: string,
    query: string,
    limit = 5,
    visibilityFilter?: 'public' | 'private'
  ): ProfileFactRecord[] {
    const baseQuery = visibilityFilter
      ? 'SELECT id, user_id as userId, fact, category, visibility, source_scope as sourceScope, source_context as sourceContext, weight, updated_at as updatedAt FROM user_profiles WHERE user_id = ? AND visibility = ? ORDER BY updated_at DESC LIMIT 100'
      : 'SELECT id, user_id as userId, fact, category, visibility, source_scope as sourceScope, source_context as sourceContext, weight, updated_at as updatedAt FROM user_profiles WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100'

    const rows = (visibilityFilter
      ? this.db.prepare(baseQuery).all(userId, visibilityFilter)
      : this.db.prepare(baseQuery).all(userId)) as unknown as ProfileFactRecord[]

    if (rows.length === 0) return []

    const queryTokens = [...new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(query)]
      .filter((s) => s.isWordLike && s.segment.trim().length >= 1)
      .map((s) => s.segment.toLowerCase())

    if (queryTokens.length === 0) return rows.slice(0, limit)

    return rows
      .map((r) => {
        const factLower = r.fact.toLowerCase()
        const matchCount = queryTokens.reduce((count, token) => (factLower.includes(token) ? count + 1 : count), 0)
        return matchCount === 0
          ? null
          : { record: r, score: matchCount * 100 + (r.weight ?? 1) * 10 + r.updatedAt / 1e12 }
      })
      .filter((item): item is { record: ProfileFactRecord; score: number } => item !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.record)
  }

  public saveRecentMessage(
    scopeKey: string,
    role: 'user' | 'model',
    content: string,
    userId = '',
    senderName = '',
    messageId = ''
  ): void {
    this.db
      .prepare(
        'INSERT INTO recent_messages (scope_key, role, user_id, sender_name, message_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(scopeKey, role, userId, senderName, messageId, content, Date.now())

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

  public findMessageByMessageId(
    messageId: string
  ): { role: string; content: string; senderName: string; userId: string } | null {
    if (!messageId) return null
    return (
      (this.db
        .prepare(
          'SELECT role, content, sender_name as senderName, user_id as userId FROM recent_messages WHERE message_id = ? ORDER BY id DESC LIMIT 1'
        )
        .get(messageId) as { role: string; content: string; senderName: string; userId: string } | undefined) ?? null
    )
  }

  public loadRecentMessages(scopeKey: string, limit: number): ChatMessage[] {
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
   * 支持通过 BM25 + 时间半衰期算法检索历史原话，或按时间倒序分页调取
   */
  public searchDeepHistory(
    scopeKey: string,
    options: { keyword?: string; limit?: number; offset?: number } = {}
  ): { role: string; content: string; time: string }[] {
    const limit = options.limit ?? 10
    const offset = options.offset ?? 0

    if (options.keyword) {
      const candidateRows = this.db
        .prepare(
          'SELECT id, role, content, created_at FROM recent_messages WHERE scope_key = ? ORDER BY id DESC LIMIT 100'
        )
        .all(scopeKey) as { id: number; role: string; content: string; created_at: number }[]

      if (candidateRows.length === 0) return []
      const docs = candidateRows.map((r) => ({ id: r.id, content: r.content, timestamp: r.created_at }))
      const ranked = rankDocuments(options.keyword, docs)
      if (ranked.length > 0) {
        const rowMap = new Map(candidateRows.map((r) => [r.id, r]))
        return ranked
          .slice(offset, offset + limit)
          .map((item) => rowMap.get(item.doc.id))
          .filter((r): r is { id: number; role: string; content: string; created_at: number } => r !== undefined)
          .map((r) => ({
            role: r.role,
            content: r.content,
            time: new Date(r.created_at).toLocaleString('zh-CN')
          }))
      }
    }

    const rows = this.db
      .prepare(
        'SELECT role, content, created_at FROM recent_messages WHERE scope_key = ? ORDER BY id DESC LIMIT ? OFFSET ?'
      )
      .all(scopeKey, limit, offset) as { role: string; content: string; created_at: number }[]

    return rows.map((r) => ({
      role: r.role,
      content: r.content,
      time: new Date(r.created_at).toLocaleString('zh-CN')
    }))
  }

  /**
   * 基于 BM25 检索语义相关的二级记忆节点
   */
  public searchMemoryNodes(scopeKey: string, query: string, limit = 5): MemoryNode[] {
    const rows = this.db
      .prepare(
        'SELECT id, level, scope_key as scopeKey, summary, tags, start_time as startTime, end_time as endTime, created_at as createdAt FROM memory_nodes WHERE scope_key = ? ORDER BY end_time DESC LIMIT 100'
      )
      .all(scopeKey) as unknown as MemoryNode[]

    if (rows.length === 0) return []
    const docs = rows.map((r) => ({
      id: r.id ?? 0,
      content: `${r.summary} ${r.tags ?? ''}`,
      timestamp: r.endTime
    }))
    const ranked = rankDocuments(query, docs)
    const topRankedMap = new Map(ranked.map((rk) => [rk.doc.id, rk.score]))
    return rows.filter((r) => r.id && topRankedMap.has(r.id)).slice(0, limit)
  }

  /**
   * 图谱 BFS 有界遍历（Graph RAG）：从起点节点向外扩展，获取连通记忆并提取发散线索词
   */
  public traverseGraph(startNodeIds: number[], maxDepth = 2, maxNodes = 10): GraphTraversalResult {
    if (startNodeIds.length === 0) return { nodes: [], cluesToExplore: [] }

    const visitedIds = new Set<number>(startNodeIds)
    const collectedNodes = new Map<number, MemoryNode>()
    const clues = new Set<string>()

    for (const id of startNodeIds) {
      const node = this.db
        .prepare(
          'SELECT id, level, scope_key as scopeKey, summary, tags, start_time as startTime, end_time as endTime, created_at as createdAt FROM memory_nodes WHERE id = ?'
        )
        .get(id) as unknown as MemoryNode | undefined
      if (node?.id) {
        collectedNodes.set(node.id, node)
        if (node.tags)
          for (const tag of node.tags.split(/[,，;； ]+/)) {
            const clean = tag.trim()
            if (clean) clues.add(clean)
          }
      }
    }

    let currentLayer = [...startNodeIds]
    for (let depth = 0; depth < maxDepth && currentLayer.length > 0 && collectedNodes.size < maxNodes; depth++) {
      const placeholders = currentLayer.map(() => '?').join(',')
      const links = this.db
        .prepare(
          `SELECT from_id as fromId, to_id as toId, concept, strength FROM memory_links WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`
        )
        .all(...currentLayer, ...currentLayer) as unknown as MemoryLink[]

      const nextLayerIds: number[] = []
      for (const link of links) {
        if (link.concept) clues.add(link.concept.trim())
        const neighborId = visitedIds.has(link.fromId) ? link.toId : link.fromId
        if (!visitedIds.has(neighborId)) {
          visitedIds.add(neighborId)
          nextLayerIds.push(neighborId)
          const neighbor = this.db
            .prepare(
              'SELECT id, level, scope_key as scopeKey, summary, tags, start_time as startTime, end_time as endTime, created_at as createdAt FROM memory_nodes WHERE id = ?'
            )
            .get(neighborId) as unknown as MemoryNode | undefined
          if (neighbor?.id) {
            collectedNodes.set(neighbor.id, neighbor)
            if (neighbor.tags)
              for (const tag of neighbor.tags.split(/[,，;； ]+/)) {
                const clean = tag.trim()
                if (clean) clues.add(clean)
              }
          }
        }
      }
      currentLayer = nextLayerIds
    }

    return {
      nodes: Array.from(collectedNodes.values()).slice(0, maxNodes),
      cluesToExplore: Array.from(clues)
    }
  }
}
