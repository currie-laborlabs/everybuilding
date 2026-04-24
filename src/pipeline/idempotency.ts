import fs from "fs";
import path from "path";
import sqlite3 from "sqlite3";
import { open, type Database } from "sqlite";

export interface IdempotencyStore {
  initialize(): Promise<void>;
  hasSeenProperty(propertyKey: string): Promise<boolean>;
  markPropertySeen(propertyKey: string, runId: string): Promise<void>;
  hasSeenContactEmail(email: string): Promise<boolean>;
  markContactEmailSeen(email: string, propertyKey: string, runId: string): Promise<void>;
  close(): Promise<void>;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class SqliteIdempotencyStore implements IdempotencyStore {
  private db: Database | null = null;

  constructor(private readonly sqlitePath: string) {}

  private ensureDirectory(): void {
    const dir = path.dirname(path.resolve(this.sqlitePath));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  async initialize(): Promise<void> {
    this.ensureDirectory();
    this.db = await open({
      filename: path.resolve(this.sqlitePath),
      driver: sqlite3.Database,
    });

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS processed_properties (
        property_key TEXT PRIMARY KEY,
        last_run_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS processed_contacts (
        email TEXT PRIMARY KEY,
        property_key TEXT NOT NULL,
        last_run_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  private requireDb(): Database {
    if (!this.db) {
      throw new Error("Idempotency store is not initialized.");
    }
    return this.db;
  }

  async hasSeenProperty(propertyKey: string): Promise<boolean> {
    const db = this.requireDb();
    const row = await db.get<{ property_key: string }>(
      "SELECT property_key FROM processed_properties WHERE property_key = ?",
      propertyKey
    );
    return Boolean(row);
  }

  async markPropertySeen(propertyKey: string, runId: string): Promise<void> {
    const db = this.requireDb();
    await db.run(
      `
      INSERT INTO processed_properties (property_key, last_run_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(property_key) DO UPDATE SET
        last_run_id = excluded.last_run_id,
        updated_at = excluded.updated_at
      `,
      propertyKey,
      runId,
      new Date().toISOString()
    );
  }

  async hasSeenContactEmail(email: string): Promise<boolean> {
    const db = this.requireDb();
    const normalized = normalizeEmail(email);
    if (!normalized) return false;

    const row = await db.get<{ email: string }>(
      "SELECT email FROM processed_contacts WHERE email = ?",
      normalized
    );
    return Boolean(row);
  }

  async markContactEmailSeen(email: string, propertyKey: string, runId: string): Promise<void> {
    const normalized = normalizeEmail(email);
    if (!normalized) return;

    const db = this.requireDb();
    await db.run(
      `
      INSERT INTO processed_contacts (email, property_key, last_run_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        property_key = excluded.property_key,
        last_run_id = excluded.last_run_id,
        updated_at = excluded.updated_at
      `,
      normalized,
      propertyKey,
      runId,
      new Date().toISOString()
    );
  }

  async close(): Promise<void> {
    if (!this.db) return;
    await this.db.close();
    this.db = null;
  }
}
