import postgres from 'postgres';

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
