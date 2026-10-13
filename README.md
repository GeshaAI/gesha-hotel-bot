# GESHA HOTEL BOT

MVP for small hotels: guest QR web chat, Telegram guest bot, staff ticket notifications, FAQ and basic admin dashboard.

## Status
Prototype v0.1. Rules-based demo, not a production-ready AI service. WhatsApp, multi-hotel tenancy, and LLM integration are planned.

## Run locally
```bash
export ADMIN_KEY='replace-with-a-long-random-secret'
python app.py
```
Open http://localhost:8080 after adding `app.py` and `index.html`.

Optional environment variables: `PORT`, `HOTEL_NAME`, `TELEGRAM_BOT_TOKEN`, `STAFF_CHAT_ID`.

**Security:** Do not expose the prototype to the public internet or enter real guest personal data until authentication, rate limiting, tenant isolation, privacy protections, and security testing are implemented.
