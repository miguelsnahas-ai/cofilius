import postgres from 'postgres';
import { comRetentativa } from './retentativa.ts';

export type Sql = postgres.Sql;

/**
 * Conexão com o Postgres (Supabase) pela DATABASE_URL.
 * - prepare: false para funcionar também pelo pooler do Supabase em modo transação.
 * - Timeout de conexão (10 s) e de cada consulta (30 s).
 */
export function conectar(url: string | undefined = process.env.DATABASE_URL): Sql {
  if (!url) throw new Error('DATABASE_URL não definida. Veja o .env.example.');
  return postgres(url, {
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 20,
    max: 5,
    onnotice: () => {},
    connection: { statement_timeout: 30_000, application_name: 'cofilius' },
  });
}

/**
 * Executa uma transação com até 3 novas tentativas em erro de conexão (a transação inteira é refeita;
 * nada fica pela metade). Erros de dado (restrição, tipo) não se repetem.
 */
export async function conectarTransacao<T>(sql: Sql, operacao: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return comRetentativa(() => sql.begin((tx) => fn(tx)) as Promise<T>, {
    operacao: `db.${operacao}`,
    deveTentarDeNovo: erroDeConexao,
  });
}

/** Erros de rede/conexão do postgres.js e códigos Postgres de conexão (classe 08) e de serialização. */
export function erroDeConexao(erro: unknown): boolean {
  const e = erro as { code?: string };
  if (!e?.code) return false;
  return (
    e.code.startsWith('08') || e.code === '40001' || e.code === '57P01' ||
    ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECT_TIMEOUT'].includes(e.code)
  );
}
