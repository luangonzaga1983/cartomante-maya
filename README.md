# Oráculo | Consultas de Tarot e Baralho Cigano

Site de agendamento de consultas espirituais (Tarot e Baralho Cigano) com pagamento via Pix (SigiloPay).

## Rodar localmente

```bash
npm install
cp .env.example .env   # preencha os valores
npm start              # http://localhost:3000
```

## Publicar na Vercel

1. Suba esta pasta para um repositório no GitHub.
2. Na Vercel: **Add New > Project**, importe o repositório e clique em **Deploy**.
3. Em **Settings > Environment Variables**, cadastre as variáveis do `.env.example`.
4. Em **Storage**, conecte o **Upstash Redis** ao projeto (ele preenche `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN` sozinho). Sem isso os pedidos não são guardados.
5. Faça um **Redeploy** para aplicar as variáveis.

O webhook da SigiloPay é configurado automaticamente com a URL do projeto na Vercel.
Painel de pedidos: `https://SEU-SITE.vercel.app/admin?key=SUA_ADMIN_KEY`

## Preços (ficam em `app.js`, constante `BARALHOS`)

| Consulta | Tarot | Baralho Cigano |
|---|---|---|
| 1 consulta | R$ 5 | R$ 9 |
| 3 consultas | R$ 12 | R$ 22 |
| 5 consultas | R$ 20 | R$ 36 |

Para mudar valores, edite `BARALHOS` em `app.js` **e** `DECKS` no script de `public/index.html` (o servidor é quem cobra de verdade; o site só exibe).
