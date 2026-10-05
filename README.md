# Tarô | Agende sua consulta

Site de agendamento de consultas de tarô com pagamento via Pix (SigiloPay).

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
