import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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

  constructor(dbPath?: string) {
    const finalPath = dbPath ?? path.join(process.cwd(), 'data', 'memory.db')
    const dir = path.dirname(finalPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    this.db = new DatabaseSync(finalPath)
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
        weight INTEGER DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_profile_user ON user_profiles(user_id);
    `)
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
    category: 'preference' | 'identity' | 'event' | 'relation' = 'preference'
  ): void {
    const exists = this.db.prepare('SELECT id FROM user_profiles WHERE user_id = ? AND fact = ?').get(userId, fact)
    if (exists) {
      this.db
        .prepare('UPDATE user_profiles SET weight = weight + 1, updated_at = ? WHERE user_id = ? AND fact = ?')
        .run(Date.now(), userId, fact)
    } else {
      this.db
        .prepare('INSERT INTO user_profiles (user_id, fact, category, weight, updated_at) VALUES (?, ?, ?, 1, ?)')
        .run(userId, fact, category, Date.now())
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

  public getProfileFacts(userId: string, limit = 20): string[] {
    return (
      this.db
        .prepare('SELECT fact FROM user_profiles WHERE user_id = ? ORDER BY weight DESC, updated_at DESC LIMIT ?')
        .all(userId, limit) as { fact: string }[]
    ).map((r) => r.fact)
  }
}
