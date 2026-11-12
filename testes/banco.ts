/**
 * Banco para os testes que usam Postgres de verdade.
 * Só roda com TEST_DATABASE_URL apontando para um banco cujo nome contenha "teste":
 * o schema public dele é APAGADO e recriado.
 * Os arquivos de teste rodam um de cada vez (vitest.config.ts), então não brigam pelo banco.
 */
import { conectar, type Sql } from '../harness/db.ts';
import { migrar } from '../db/migrate.ts';

export const URL_TESTE = process.env.TEST_DATABASE_URL;
export const BANCO_HABILITADO = !!URL_TESTE && /teste/.test(new URL(URL_TESTE).pathname);

export async function bancoLimpo(): Promise<Sql> {
  const sql = conectar(URL_TESTE);
  await sql.unsafe('drop schema if exists public cascade; drop schema if exists controle cascade; create schema public;');
  await migrar(sql, { seed: true });
  return sql;
}
