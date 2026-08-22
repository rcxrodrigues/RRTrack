/*
 * Cifragem das credenciais guardadas no banco.
 *
 * Token da Meta, chave de API de gateway e afins não podem ficar legíveis numa
 * coluna jsonb: quem conseguir uma cópia do banco — um backup mal guardado, um
 * dump de suporte — sairia com acesso às contas de anúncio de todas as lojas.
 *
 * AES-256-GCM: além de cifrar, autentica. Um valor adulterado falha ao decifrar
 * em vez de devolver lixo silenciosamente.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

let cached: CryptoKey | null = null;

async function getKey(): Promise<CryptoKey> {
  if (cached) return cached;
  const raw = process.env.CREDENTIALS_KEY;
  if (!raw) throw new Error("CREDENTIALS_KEY ausente");
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) throw new Error("CREDENTIALS_KEY precisa ter 32 bytes em base64");
  cached = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  return cached;
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** Devolve "iv.textocifrado", ambos em base64. */
export async function encryptValue(plain: string): Promise<string> {
  const key = await getKey();
  /* IV novo a cada chamada; reaproveitar IV em GCM quebra a cifra por completo. */
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const out = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain));
  return `${b64(iv)}.${b64(new Uint8Array(out))}`;
}

export async function decryptValue(stored: string): Promise<string> {
  const [ivPart, dataPart] = stored.split(".");
  if (!ivPart || !dataPart) throw new Error("credencial em formato inválido");
  const key = await getKey();
  const iv = Uint8Array.from(atob(ivPart), (c) => c.charCodeAt(0));
  const data = Uint8Array.from(atob(dataPart), (c) => c.charCodeAt(0));
  const out = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return dec.decode(out);
}

export async function encryptRecord(r: Record<string, string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) out[k] = await encryptValue(v);
  return out;
}

export async function decryptRecord(r: Record<string, string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) out[k] = await decryptValue(v);
  return out;
}
