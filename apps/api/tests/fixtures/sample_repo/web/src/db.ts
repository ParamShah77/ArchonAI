import { Pool } from "pg";
export const pool = new Pool();
export function query(sql: string, params: unknown[] = []) {
  return pool.query(sql, params);
}
