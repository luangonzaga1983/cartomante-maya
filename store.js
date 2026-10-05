// Armazenamento de pedidos.
// - Na Vercel: Upstash Redis (REST). Os dados persistem entre execuções.
// - Local (sem Redis): arquivo pedidos.json.
const fs = require('fs');
const os = require('os');
const path = require('path');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const usaRedis = Boolean(REDIS_URL && REDIS_TOKEN);

async function redis(comandos) {
  const r = await fetch(REDIS_URL.replace(/\/+$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(comandos),
  });
  if (!r.ok) throw new Error('Redis HTTP ' + r.status);
  const out = await r.json();
  const erro = out.find((o) => o && o.error);
  if (erro) throw new Error('Redis: ' + erro.error);
  return out.map((o) => o.result);
}

// ---- fallback em arquivo ----
const ARQUIVO = path.join(process.env.VERCEL ? os.tmpdir() : __dirname, 'pedidos.json');
if (process.env.VERCEL && !usaRedis) {
  console.warn('AVISO: sem Redis configurado. Os pedidos NÃO persistem na Vercel. Conecte o Upstash Redis ao projeto.');
}
const lerArquivo = () => {
  try { return JSON.parse(fs.readFileSync(ARQUIVO, 'utf8')); } catch { return {}; }
};
const gravarArquivo = (obj) => fs.writeFileSync(ARQUIVO, JSON.stringify(obj, null, 2));

async function salvar(ped) {
  if (usaRedis) {
    const cmds = [['SET', 'pedido:' + ped.id, JSON.stringify(ped)], ['SADD', 'pedidos', ped.id]];
    if (ped.transactionId) cmds.push(['SET', 'tx:' + ped.transactionId, ped.id]);
    await redis(cmds);
    return;
  }
  const todos = lerArquivo();
  todos[ped.id] = ped;
  gravarArquivo(todos);
}

async function obter(id) {
  if (!id) return null;
  if (usaRedis) {
    const [v] = await redis([['GET', 'pedido:' + id]]);
    return v ? JSON.parse(v) : null;
  }
  return lerArquivo()[id] || null;
}

async function obterPorTransacao(transactionId) {
  if (!transactionId) return null;
  if (usaRedis) {
    const [id] = await redis([['GET', 'tx:' + transactionId]]);
    return id ? obter(id) : null;
  }
  return Object.values(lerArquivo()).find((p) => p.transactionId === transactionId) || null;
}

async function listar() {
  if (usaRedis) {
    const [ids] = await redis([['SMEMBERS', 'pedidos']]);
    if (!ids || !ids.length) return [];
    const [valores] = await redis([['MGET', ...ids.map((i) => 'pedido:' + i)]]);
    return valores.filter(Boolean).map((v) => JSON.parse(v));
  }
  return Object.values(lerArquivo());
}

module.exports = { salvar, obter, obterPorTransacao, listar, usaRedis };
