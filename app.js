require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const { SIGILO_PUBLIC_KEY, SIGILO_SECRET_KEY, ADMIN_KEY = '', CLIENT_EMAIL, CLIENT_PHONE, CLIENT_DOCUMENT } = process.env;

// URL pública para o webhook: BASE_URL / PUBLIC_URL, ou a URL de produção da Vercel (automática).
const BASE_URL = (
  process.env.BASE_URL ||
  process.env.PUBLIC_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : '')
).replace(/\/+$/, '');

const API = 'https://app.sigilopay.com.br/api/v1/gateway/pix/receive';

// Os preços ficam SÓ aqui no servidor: o cliente nunca decide o valor.
const PACOTES = {
  1: { nome: '1 Tiragem Completa', preco: 5 },
  3: { nome: '3 Tiragens Completas', preco: 12 },
  5: { nome: '5 Tiragens Completas', preco: 20 },
};

// Dados do cliente enviados à SigiloPay: sempre fixos (vêm das variáveis de ambiente).
const CLIENTE_FIXO = { email: CLIENT_EMAIL, phone: CLIENT_PHONE, document: CLIENT_DOCUMENT };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// limite simples: 8 Pix por IP a cada 10 minutos (evita abuso)
const hits = new Map();
const limite = (req, res, next) => {
  const agora = Date.now();
  if (hits.size > 5000) hits.clear();
  const lista = (hits.get(req.ip) || []).filter((t) => agora - t < 600000);
  if (lista.length >= 8) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde alguns minutos.' });
  lista.push(agora);
  hits.set(req.ip, lista);
  next();
};

const txt = (v, max) => String(v || '').trim().slice(0, max);
const ID_OK = /^ped_[a-f0-9]{16}$/;

app.post('/api/pix', limite, async (req, res) => {
  try {
    if (!SIGILO_PUBLIC_KEY || !SIGILO_SECRET_KEY || !CLIENTE_FIXO.email || !CLIENTE_FIXO.phone || !CLIENTE_FIXO.document) {
      console.error('Variáveis de ambiente faltando (SIGILO_PUBLIC_KEY, SIGILO_SECRET_KEY, CLIENT_EMAIL, CLIENT_PHONE, CLIENT_DOCUMENT).');
      return res.status(500).json({ erro: 'Pagamento indisponível no momento. Pague pelo WhatsApp.' });
    }

    const b = req.body || {};
    const p = PACOTES[b.pacote];
    const nome = txt(b.nome, 120);
    const tel = txt(b.tel, 25).replace(/[^\d+()\-\s]/g, '');
    if (!p) return res.status(400).json({ erro: 'Consulta inválida.' });
    if (nome.split(/\s+/).length < 2) return res.status(400).json({ erro: 'Informe seu nome completo.' });
    if (tel.replace(/\D/g, '').length < 10) return res.status(400).json({ erro: 'WhatsApp inválido.' });

    const id = 'ped_' + crypto.randomBytes(8).toString('hex');
    const body = {
      identifier: id,
      amount: p.preco,
      client: { name: nome, ...CLIENTE_FIXO },
      products: [{ id: 'tiragem-' + b.pacote, name: p.nome, quantity: 1, price: p.preco }],
      ...(BASE_URL ? { callbackUrl: BASE_URL + '/api/webhook' } : {}),
    };

    const r = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-public-key': SIGILO_PUBLIC_KEY, 'x-secret-key': SIGILO_SECRET_KEY },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.pix || !d.pix.code || ['FAILED', 'REJECTED', 'CANCELED'].includes(d.status)) {
      console.error('Erro SigiloPay:', r.status, JSON.stringify(d));
      return res.status(502).json({ erro: 'Não consegui gerar o Pix agora. Tente novamente ou pague pelo WhatsApp.' });
    }

    await store.salvar({
      id, criadoEm: new Date().toISOString(), status: 'pendente',
      transactionId: d.transactionId, webhookToken: d.webhookToken || null,
      pacote: p.nome, valor: p.preco, nome, tel, modo: b.modo === 'zap' ? 'zap' : 'aqui',
      perguntas: (Array.isArray(b.perguntas) ? b.perguntas : []).slice(0, 5).map((q) => txt(q, 1500)),
      formato: txt(b.formato, 40), obs: txt(b.obs, 1500),
    });
    res.json({ id, code: d.pix.code, image: d.pix.image || '', expiresAt: d.pix.expiresAt || '' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno ao gerar o Pix.' });
  }
});

// o site consulta aqui para saber se já foi pago
app.get('/api/status/:id', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const p = ID_OK.test(req.params.id) ? await store.obter(req.params.id) : null;
    res.json({ status: p ? p.status : 'desconhecido' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ status: 'erro' });
  }
});

// a SigiloPay avisa aqui quando o status muda
app.post('/api/webhook', async (req, res) => {
  try {
    const b = req.body || {};
    const t = b.transaction || b;
    const ident = t.identifier || b.identifier;
    const ped = (ID_OK.test(String(ident)) && (await store.obter(ident))) || (await store.obterPorTransacao(t.id || t.transactionId));
    if (!ped) return res.sendStatus(200);
    if (ped.webhookToken && b.token !== ped.webhookToken) return res.sendStatus(401);
    const st = String(t.status || b.status || '').toUpperCase();
    const ev = String(b.event || '').toUpperCase();
    if (['COMPLETED', 'PAID'].includes(st) || ev.includes('PAID')) {
      if (ped.status !== 'pago') {
        ped.status = 'pago';
        ped.pagoEm = new Date().toISOString();
        console.log('PAGO:', ped.id, ped.nome, ped.pacote);
        await store.salvar(ped);
      }
    } else if (['FAILED', 'EXPIRED', 'CANCELED', 'REFUNDED', 'CHARGED_BACK'].includes(st)) {
      ped.status = st.toLowerCase();
      await store.salvar(ped);
    }
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

// painel simples com seus pedidos: /admin?key=SUA_SENHA
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
app.get('/admin', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(401).send('Acesso negado');
    const lista = (await store.listar()).sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
    const html = lista.map((p) => `<div style="border:1px solid #888;border-radius:8px;padding:12px;margin:12px 0">
    <b>${esc(p.nome)}</b> | ${esc(p.pacote)} | R$ ${esc(p.valor)} | <b style="color:${p.status === 'pago' ? 'green' : 'orange'}">${esc(p.status)}</b><br>
    WhatsApp: <a href="https://wa.me/55${esc(String(p.tel || '').replace(/\D/g, '').replace(/^55/, ''))}">${esc(p.tel)}</a> | Resposta em: ${esc(p.formato)}<br>
    ${p.modo === 'zap' ? '<i>Vai enviar as perguntas pelo WhatsApp</i>' : (p.perguntas || []).map((q, i) => `<p><b>Pergunta ${i + 1}:</b> ${esc(q)}</p>`).join('')}
    ${p.obs ? `<p><b>Obs:</b> ${esc(p.obs)}</p>` : ''}<small>${esc(p.criadoEm)}</small></div>`).join('');
    res.send(`<meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;max-width:800px;margin:auto;padding:16px"><h2>Pedidos</h2>${html || 'Nenhum pedido ainda.'}</body>`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Erro ao carregar pedidos');
  }
});

module.exports = app;
