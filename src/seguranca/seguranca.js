// RNF03 (criptografia) e RNF04 (controle de acesso): senhas com scrypt,
// tokens assinados com HMAC-SHA256 e documentos fiscais cifrados com AES-256-GCM.
import crypto from 'node:crypto';

const SEGREDO_TOKEN = process.env.TOKEN_SECRET || 'flowdock-dev-token-secret-troque-em-producao';
const CHAVE_DOCS = crypto.createHash('sha256').update(process.env.DOC_KEY || 'flowdock-dev-doc-key-troque-em-producao').digest();

// ---------------------------------------------------------------- senhas
export function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(senha), sal, 32, { N: 4096 });
  return `${sal.toString('hex')}:${hash.toString('hex')}`;
}

export function verificarSenha(senha, armazenado) {
  if (!armazenado) return false;
  const [salHex, hashHex] = armazenado.split(':');
  const hash = crypto.scryptSync(String(senha), Buffer.from(salHex, 'hex'), 32, { N: 4096 });
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

// ---------------------------------------------------------------- tokens
const b64 = (buf) => Buffer.from(buf).toString('base64url');

export function assinarToken({ papel, id }, validadeHoras = 24 * 7) {
  const corpo = b64(JSON.stringify({ papel, id, exp: Date.now() + validadeHoras * 3600_000 }));
  const assinatura = b64(crypto.createHmac('sha256', SEGREDO_TOKEN).update(corpo).digest());
  return `${corpo}.${assinatura}`;
}

export function lerToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [corpo, assinatura] = token.split('.');
  const esperado = b64(crypto.createHmac('sha256', SEGREDO_TOKEN).update(corpo).digest());
  const a = Buffer.from(assinatura);
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const dados = JSON.parse(Buffer.from(corpo, 'base64url').toString());
    if (dados.exp < Date.now()) return null;
    return { papel: dados.papel, id: dados.id };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- documentos
export function cifrar(buffer) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', CHAVE_DOCS, iv);
  const dados = Buffer.concat([c.update(buffer), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), dados: dados.toString('base64') };
}

export function decifrar({ iv, tag, dados }) {
  const d = crypto.createDecipheriv('aes-256-gcm', CHAVE_DOCS, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(dados, 'base64')), d.final()]);
}
