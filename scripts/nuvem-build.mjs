/**
 * Monta o Cofilius para o Vercel (Build Output API v3), sem framework:
 *
 *   .vercel/output/config.json               rotas (tudo para a função) e agendamentos (cron)
 *   .vercel/output/functions/index.func/     a função: código empacotado + telas, prompts e migrations
 *
 * O Vercel roda isto pelo "buildCommand" do vercel.json. Localmente: npm run nuvem:build
 */
import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAIDA = join(RAIZ, '.vercel', 'output');
const FUNCAO = join(SAIDA, 'functions', 'index.func');

/**
 * Agendamentos no plano grátis do Vercel: no máximo uma vez por dia cada, com até 59 minutos de atraso.
 * Horários em UTC: 9h = 6h em Brasília; domingo 23h = 20h em Brasília.
 */
export const AGENDAMENTOS = [
  { path: '/api/cron/esteira?rodada=manha', schedule: '0 9 * * *' },
  { path: '/api/cron/esteira?rodada=noite', schedule: '0 23 * * 0' },
];

await rm(SAIDA, { recursive: true, force: true });
await mkdir(FUNCAO, { recursive: true });
await mkdir(join(SAIDA, 'static'), { recursive: true });

await build({
  entryPoints: [join(RAIZ, 'nuvem', 'funcao.ts')],
  outfile: join(FUNCAO, 'index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  legalComments: 'none',
  logLevel: 'warning',
  // Antes de tudo: "require" para pacotes CommonJS e a raiz dos arquivos (telas, prompts, migrations)
  // ao lado do código empacotado.
  banner: {
    js: [
      "import { createRequire as __criarRequire } from 'node:module';",
      "import { dirname as __pasta } from 'node:path';",
      "import { fileURLToPath as __caminho } from 'node:url';",
      'const require = __criarRequire(import.meta.url);',
      'process.env.COFILIUS_RAIZ ||= __pasta(__caminho(import.meta.url));',
    ].join('\n'),
  },
});

// Arquivos lidos em tempo de execução, na mesma estrutura de pastas do projeto.
for (const pasta of ['painel/publico', 'agents', 'db/migrations', 'docs/modelos']) {
  await cp(join(RAIZ, pasta), join(FUNCAO, pasta), { recursive: true, filter: (f) => !/\.(ts|mts)$/.test(f) });
}
await cp(join(RAIZ, 'db', 'seed.sql'), join(FUNCAO, 'db', 'seed.sql'));

await writeFile(join(FUNCAO, '.vc-config.json'), JSON.stringify({
  runtime: 'nodejs22.x',
  handler: 'index.mjs',
  launcherType: 'Nodejs',
  shouldAddHelpers: false,
  maxDuration: 300,
  // São Paulo, perto do Supabase (sa-east-1).
  regions: ['gru1'],
  environment: { DB_MAX_CONEXOES: '2' },
}, null, 2));

await writeFile(join(SAIDA, 'config.json'), JSON.stringify({
  version: 3,
  routes: [{ src: '^/(.*)$', dest: '/index?__caminho=$1' }],
  crons: AGENDAMENTOS,
}, null, 2));

console.log('Pronto: .vercel/output (função index + agendamentos).');
