/**
 * Cifra das credenciais dos clientes (tabela `credenciais`).
 *
 * AES-256-GCM via WebCrypto (funciona igual no Node 20+ e nas Edge Functions do Supabase, em Deno).
 * A chave mestra vem da variável CREDENCIAIS_CHAVE (32 bytes em base64), nunca do código.
 *
 * Formato gravado: "v1:<iv base64>:<cifrado+tag base64>".
 * O "contexto" (cliente, plataforma, nome) entra como dado associado: um valor cifrado
 * para um cliente não decifra se for copiado para a linha de outro.
 */

const VERSAO = 'v1';

function b64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function deB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function importarChave(chaveBase64: string | undefined): Promise<CryptoKey> {
  if (!chaveBase64) throw new Error('CREDENCIAIS_CHAVE não definida. Gere com: npm run gerar-chave');
  const bruta = deB64(chaveBase64);
  if (bruta.length !== 32) throw new Error('CREDENCIAIS_CHAVE precisa ter 32 bytes em base64.');
  return crypto.subtle.importKey('raw', bruta, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function cifrar(chave: CryptoKey, texto: string, contexto: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cifrado = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(contexto) },
    chave,
    new TextEncoder().encode(texto),
  );
  return `${VERSAO}:${b64(iv)}:${b64(new Uint8Array(cifrado))}`;
}

export async function decifrar(chave: CryptoKey, valor: string, contexto: string): Promise<string> {
  const [versao, iv, dados] = valor.split(':');
  if (versao !== VERSAO || !iv || !dados) throw new Error('Formato de credencial cifrada desconhecido.');
  try {
    const claro = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: deB64(iv), additionalData: new TextEncoder().encode(contexto) },
      chave,
      deB64(dados),
    );
    return new TextDecoder().decode(claro);
  } catch {
    throw new Error('Não foi possível decifrar a credencial (chave mestra errada ou dado de outro cliente).');
  }
}

export async function sha256Hex(texto: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}
