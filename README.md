# Universal Webhook Receiver

Cloudflare Worker pro univerzální příjem a ukládání webhooků s podporou více zákazníků, audit logováním a management API.

## Funkce

- **Příjem webhooků** - `POST /webhook/:type/:customer_id`
- **Ukládání do R2** - Payloady organizované podle typu/zákazníka/data
- **Audit logování** - Do KV (30 dnů TTL) a Turso databáze
- **IP validace** - Volitelné omezení na povolené IP adresy
- **Token autentizace** - Per-customer tokeny pro webhook endpoint
- **S2S autentizace** - Server-to-server token pro management API
- **Management API** - Listování, stahování a mazání webhooků
- **Plánovaný cleanup** - Automatické mazání starých audit logů (cron)

## Technologie

- [Cloudflare Workers](https://workers.cloudflare.com/)
- [Hono](https://hono.dev/) - Web framework
- [R2](https://developers.cloudflare.com/r2/) - Object storage pro payloady
- [KV](https://developers.cloudflare.com/kv/) - Audit logy s TTL
- [Turso](https://turso.tech/) - SQLite databáze pro audit logy

## API Endpointy

### Webhook
```
POST /webhook/:type/:customer_id
```
Přijímá webhook payload a ukládá do R2. Podporované typy: `esl`.

### Management (vyžaduje S2S token)
```
GET  /manage/customers                 # Seznam zákazníků
GET  /manage/webhooks                  # Seznam webhooků
GET  /manage/webhooks/:webhookId       # Stažení payloadu
DELETE /manage/webhooks/:webhookId     # Smazání webhooku
GET  /manage/audit                     # Audit logy
```

## Setup

1. Nainstaluj závislosti:
   ```bash
   npm install
   ```

2. Vytvoř KV namespace:
   ```bash
   npx wrangler kv:namespace create AUDIT_KV
   ```
   Aktualizuj `id` v `wrangler.jsonc`.

3. Vytvoř R2 bucket:
   ```bash
   npx wrangler r2 bucket create webhook-payloads
   ```

4. Nastav secrets:
   ```bash
   npx wrangler secret put S2S_TOKEN
   npx wrangler secret put CUSTOMER_TOKENS
   npx wrangler secret put TURSO_AUTH_TOKEN
   ```

5. Deploy:
   ```bash
   npm run deploy
   ```

## Konfigurace

### Environment Variables (wrangler.jsonc)
- `ALLOWED_IPS` - Čárkou oddělené povolené IP (prázdné = všechny)
- `TURSO_DATABASE_URL` - URL Turso databáze

### Secrets
- `S2S_TOKEN` - Token pro management API
- `CUSTOMER_TOKENS` - JSON objekt `{"customer-id": "token"}`
- `TURSO_AUTH_TOKEN` - Auth token pro Turso

### Zákazníci (src/data/customers.json)
Konfigurace zákazníků včetně povolených formátů dat, outletů a ESL párování.

## Struktura projektu

```
src/
├── index.ts              # Hlavní router a scheduled handler
├── types.ts              # TypeScript typy
├── data/
│   └── customers.json    # Konfigurace zákazníků
├── endpoints/
│   ├── webhook.ts        # Příjem webhooků
│   └── webhookManagement.ts  # Management API
├── lib/
│   └── turso.ts          # Turso klient
└── middleware/
    ├── auth.ts           # IP a token autentizace
    └── audit.ts          # Audit logging middleware
```

## R2 Storage Struktura

```
/{type}/{customer_id}/{YYYY-MM-DD}/{uuid}.{ext}
```

Příklad: `esl/mpl-zlin/2025-01-08/550e8400-e29b-41d4-a716-446655440000.csv`
