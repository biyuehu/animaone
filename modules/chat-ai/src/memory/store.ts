import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface MemoryNode {
  readonly id?: number
  readonly level: 'topic' | 'day' | 'week' | 'month' | 'quarter' | 'year'
  readonly scopeKey: string
  readonly summary: string
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
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_scope_level ON memory_nodes(scope_key, level);
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

  public addNode(node: MemoryNode): void {
    this.db
      .prepare(
        'INSERT INTO memory_nodes (level, scope_key, summary, start_time, end_time, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(node.level, node.scopeKey, node.summary, node.startTime, node.endTime, node.createdAt ?? Date.now())
  }

  public getPyramidMemories(scopeKey: string, maxNodes = 10): MemoryNode[] {
    return this.db
      .prepare(
        'SELECT id, level, scope_key as scopeKey, summary, start_time as startTime, end_time as endTime, created_at as createdAt FROM memory_nodes WHERE scope_key = ? ORDER BY end_time DESC LIMIT ?'
      )
      .all(scopeKey, maxNodes) as unknown as MemoryNode[]
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

  public getProfileFacts(userId: string, limit = 20): string[] {
    return (
      this.db
        .prepare('SELECT fact FROM user_profiles WHERE user_id = ? ORDER BY weight DESC, updated_at DESC LIMIT ?')
        .all(userId, limit) as { fact: string }[]
    ).map((r) => r.fact)
  }
}
