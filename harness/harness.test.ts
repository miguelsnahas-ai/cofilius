import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { cifrar, decifrar, importarChave, sha256Hex } from './cripto.ts';
import { comRetentativa, erroTransitorio, ErroHttp, ErroTimeout, postComTimeout } from './retentativa.ts';
import { mascarar } from './log.ts';

const semEspera = async () => {};

describe('comRetentativa', () => {
  it('tenta de novo até 3 vezes e devolve o resultado', async () => {
    let chamadas = 0;
    const esperas: number[] = [];
    const r = await comRetentativa(
      async () => {
        chamadas++;
        if (chamadas < 4) throw new ErroHttp(503, 'fora');
        return 'ok';
      },
      { operacao: 't', esperar: async (ms) => void esperas.push(ms) },
    );
    expect(r).toBe('ok');
    expect(chamadas).toBe(4);
    expect(esperas).toHaveLength(3);
    expect(esperas[1]!).toBeGreaterThan(esperas[0]!);
    expect(esperas[2]!).toBeGreaterThan(esperas[1]!);
  });

  it('desiste depois da 3ª nova tentativa', async () => {
    let chamadas = 0;
    await expect(
      comRetentativa(async () => { chamadas++; throw new ErroHttp(500, 'x'); }, { operacao: 't', esperar: semEspera }),
    ).rejects.toThrow('HTTP 500');
    expect(chamadas).toBe(4);
  });

  it('não repete erro que não é transitório', async () => {
    let chamadas = 0;
    await expect(
      comRetentativa(async () => { chamadas++; throw new ErroHttp(401, 'x'); }, {
        operacao: 't', esperar: semEspera, deveTentarDeNovo: erroTransitorio,
      }),
    ).rejects.toThrow();
    expect(chamadas).toBe(1);
  });
});

describe('erroTransitorio', () => {
  it('classifica os erros', () => {
    expect(erroTransitorio(new ErroTimeout(1))).toBe(true);
    expect(erroTransitorio(new ErroHttp(429, ''))).toBe(true);
    expect(erroTransitorio(new ErroHttp(502, ''))).toBe(true);
    expect(erroTransitorio(new ErroHttp(400, ''))).toBe(false);
    expect(erroTransitorio(new TypeError('fetch failed'))).toBe(true);
    expect(erroTransitorio(new Error('outro'))).toBe(false);
  });
});

describe('postComTimeout', () => {
  it('lança ErroTimeout quando o servidor não responde', async () => {
    const fetchLento: typeof fetch = (_u, init) =>
      new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    await expect(postComTimeout('http://x', '{}', {}, { timeoutMs: 20, fetch: fetchLento })).rejects.toBeInstanceOf(ErroTimeout);
  });

  it('lança ErroHttp em status de erro', async () => {
    const f: typeof fetch = async () => new Response('falhou', { status: 500 });
    await expect(postComTimeout('http://x', '{}', {}, { fetch: f })).rejects.toBeInstanceOf(ErroHttp);
  });
});

describe('cripto', () => {
  const chaveB64 = randomBytes(32).toString('base64');

  it('cifra e decifra com o mesmo contexto', async () => {
    const chave = await importarChave(chaveB64);
    const c = await cifrar(chave, 'segredo', 'cliente1/shopee/open_api');
    expect(c).not.toContain('segredo');
    expect(await decifrar(chave, c, 'cliente1/shopee/open_api')).toBe('segredo');
  });

  it('não decifra com outro contexto (linha de outro cliente)', async () => {
    const chave = await importarChave(chaveB64);
    const c = await cifrar(chave, 'segredo', 'cliente1/shopee/open_api');
    await expect(decifrar(chave, c, 'cliente2/shopee/open_api')).rejects.toThrow();
  });

  it('recusa chave de tamanho errado', async () => {
    await expect(importarChave(randomBytes(16).toString('base64'))).rejects.toThrow('32 bytes');
    await expect(importarChave(undefined)).rejects.toThrow('CREDENCIAIS_CHAVE');
  });

  it('sha256Hex bate com o node:crypto', async () => {
    expect(await sha256Hex('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
  });
});

describe('mascarar', () => {
  it('esconde campos sensíveis', () => {
    expect(mascarar({ appId: '1', Authorization: 'x', nested: { secret: 's', ok: 1 } })).toEqual({
      appId: '***', Authorization: '***', nested: { secret: '***', ok: 1 },
    });
  });
});
