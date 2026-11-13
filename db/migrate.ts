/**
 * Aplica as migrations de db/migrations em ordem, uma única vez cada.
 * Uso: npm run db:migrate          (só migrations)
 *      npm run db:seed             (migrations + db/seed.sql)
 *
 * O controle do que já rodou fica em controle.migracoes (schema à parte, fora do modelo de negócio).
 */
import 'dotenv/config';
import { executadoDiretamente } from '../harness/execucao.ts';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { conectar, type Sql } from '../harness/db.ts';
import { log } from '../harness/log.ts';

const pasta = dirname(fileURLToPath(import.meta.url));

export async function migrar(sql: Sql, opcoes: { seed?: boolean } = {}): Promise<string[]> {
  await sql.unsafe(`
    create schema if not exists controle;
    create table if not exists controle.migracoes (
      nome text primary key,
      aplicada_em timestamptz not null default now()
    );
    alter table controle.migracoes enable row level security;
  `);
  const feitas = new Set((await sql<{ nome: string }[]>`select nome from controle.migracoes`).map((r) => r.nome));
  const arquivos = (await readdir(join(pasta, 'migrations'))).filter((f) => f.endsWith('.sql')).sort();
  const aplicadas: string[] = [];
  for (const arquivo of arquivos) {
    if (feitas.has(arquivo)) continue;
    const texto = await readFile(join(pasta, 'migrations', arquivo), 'utf8');
    log.info('migracao.aplicando', { arquivo });
    await sql.unsafe(texto); // cada arquivo abre e fecha a própria transação
    await sql`insert into controle.migracoes (nome) values (${arquivo})`;
    aplicadas.push(arquivo);
  }
  if (opcoes.seed) {
    await sql.unsafe(await readFile(join(pasta, 'seed.sql'), 'utf8'));
    log.info('seed.aplicado');
  }
  return aplicadas;
}

if (executadoDiretamente(import.meta.url)) {
  const sql = conectar();
  try {
    const aplicadas = await migrar(sql, { seed: process.argv.includes('--seed') });
    console.log(aplicadas.length ? `Migrations aplicadas: ${aplicadas.join(', ')}` : 'Nenhuma migration pendente.');
  } catch (erro) {
    console.error('Falha ao migrar:', erro instanceof Error ? erro.message : erro);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
