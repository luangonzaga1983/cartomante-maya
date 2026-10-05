require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { SIGILO_PUBLIC_KEY, SIGILO_SECRET_KEY, BASE_URL = '', ADMIN_KEY = '', PORT = 3000 } = process.env;
if (!SIGILO_PUBLIC_KEY || !SIGILO_SECRET_KEY) {
  console.error('Faltam SIGILO_PUBLIC_KEY e SIGILO_SECRET_KEY no arquivo .env');
  process.exit(1);
}

const API = 'https://app.sigilopay.com.br/api/v1/gateway/pix/receive';
// Os preços ficam SÓ aqui no servidor: o cliente nunca decide o valor.
const PACOTES = {
  1: { nome: '1 Tiragem Completa', preco: 5 },
  3: { nome: '3 Tiragens Completas', preco: 12 },
  5: { nome: '5 Tiragens Completas', preco: 20 },
};

// Dados do cliente enviados à SigiloPay: sempre fixos, independente do que o cliente digitar.
const CLIENTE_FIXO = { email: 'testebluekiriku@gmail.com', phone: '11964533002', document: '141.129.606-03' };

const DB = path.join(__dirname, 'pedidos.json');
let pedidos = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : {};
const salvar = () => fs.writeFileSync(DB, JSON.stringify(pedidos, null, 2));

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// limite simples: 8 Pix por IP a cada 10 minutos (evita abuso)
const hits = new Map();
const limite = (req, res, next) => {
  const agora = Date.now();
  const lista = (hits.get(req.ip) || []).filter((t) => agora - t < 600000);
  if (lista.length >= 8) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde alguns minutos.' });
  lista.push(agora);
  hits.set(req.ip, lista);
  next();
};

const txt = (v, max) => String(v || '').trim().slice(0, max);

app.post('/api/pix', limite, async (req, res) => {
  try {
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

    pedidos[id] = {
      id, criadoEm: new Date().toISOString(), status: 'pendente',
      transactionId: d.transactionId, webhookToken: d.webhookToken || null,
      pacote: p.nome, valor: p.preco, nome, tel, modo: b.modo === 'zap' ? 'zap' : 'aqui',
      perguntas: (Array.isArray(b.perguntas) ? b.perguntas : []).slice(0, 5).map((q) => txt(q, 1500)),
      formato: txt(b.formato, 40), obs: txt(b.obs, 1500),
    };
    salvar();
    res.json({ id, code: d.pix.code, image: d.pix.image || '', expiresAt: d.pix.expiresAt || '' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno ao gerar o Pix.' });
  }
});

// o site consulta aqui para saber se já foi pago
app.get('/api/status/:id', (req, res) => {
  const p = pedidos[req.params.id];
  res.json({ status: p ? p.status : 'desconhecido' });
});

// a SigiloPay avisa aqui quando o status muda
app.post('/api/webhook', (req, res) => {
  const b = req.body || {};
  const t = b.transaction || b;
  const ped = pedidos[t.identifier || b.identifier] || Object.values(pedidos).find((x) => x.transactionId && x.transactionId === (t.id || t.transactionId));
  if (!ped) return res.sendStatus(200);
  if (ped.webhookToken && b.token !== ped.webhookToken) return res.sendStatus(401);
  const st = String(t.status || b.status || '').toUpperCase();
  const ev = String(b.event || '').toUpperCase();
  if (['COMPLETED', 'PAID'].includes(st) || ev.includes('PAID')) {
    if (ped.status !== 'pago') { ped.status = 'pago'; ped.pagoEm = new Date().toISOString(); console.log('PAGO:', ped.id, ped.nome, ped.pacote); }
  } else if (['FAILED', 'EXPIRED', 'CANCELED', 'REFUNDED', 'CHARGED_BACK'].includes(st)) {
    ped.status = st.toLowerCase();
  }
  salvar();
  res.sendStatus(200);
});

// painel simples com seus pedidos: /admin?key=SUA_SENHA
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
app.get('/admin', (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(401).send('Acesso negado');
  const lista = Object.values(pedidos).sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
  const html = lista.map((p) => `<div style="border:1px solid #888;border-radius:8px;padding:12px;margin:12px 0">
    <b>${esc(p.nome)}</b> | ${esc(p.pacote)} | R$ ${p.valor} | <b style="color:${p.status === 'pago' ? 'green' : 'orange'}">${esc(p.status)}</b><br>
    WhatsApp: <a href="https://wa.me/55${esc(p.tel.replace(/\D/g, '').replace(/^55/, ''))}">${esc(p.tel)}</a> | Resposta em: ${esc(p.formato)}<br>
    ${p.modo === 'zap' ? '<i>Vai enviar as perguntas pelo WhatsApp</i>' : p.perguntas.map((q, i) => `<p><b>Pergunta ${i + 1}:</b> ${esc(q)}</p>`).join('')}
    ${p.obs ? `<p><b>Obs:</b> ${esc(p.obs)}</p>` : ''}<small>${esc(p.criadoEm)}</small></div>`).join('');
  res.send(`<meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;max-width:800px;margin:auto;padding:16px"><h2>Pedidos</h2>${html || 'Nenhum pedido ainda.'}</body>`);
});

app.listen(PORT, () => console.log('Site rodando em http://localhost:' + PORT));