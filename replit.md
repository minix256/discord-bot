# Bot de ID Discord

Bot do Discord que distribui IDs sequenciais aos membros e atualiza seus apelidos automaticamente.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — rodar o servidor + bot (porta 5000)
- `pnpm run typecheck` — checar tipos em todos os pacotes
- `pnpm run build` — typecheck + build completo
- `pnpm --filter @workspace/db run push` — aplicar mudanças no schema do BD (dev)
- Env obrigatório: `DATABASE_URL` — string de conexão Postgres
- Env obrigatório: `DISCORD_BOT_TOKEN` — token do bot Discord
- Env opcional: `DISCORD_GUILD_ID` — ID do servidor Discord (registro instantâneo de comandos)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Discord: discord.js v14
- Validation: Zod (`zod/v4`), `drizzle-zod`
- Build: esbuild (CJS bundle)

## Where things live

- `lib/db/src/schema/discord-ids.ts` — tabela `discord_user_ids` (schema do BD)
- `artifacts/api-server/src/bot.ts` — lógica do bot Discord
- `artifacts/api-server/src/index.ts` — entry point (servidor + bot)

## Product

- Comando `/pedir id` — atribui um ID sequencial único ao membro e muda o apelido para `Nome | ID`
- IDs são persistentes no banco de dados PostgreSQL
- Se o membro já tem um ID, informa sem criar duplicata

## Gotchas

- Comandos registrados globalmente levam até 1 hora para aparecer. Para registro instantâneo, defina `DISCORD_GUILD_ID` com o ID do servidor.
- O bot precisa da permissão "Gerenciar Apelidos" no servidor.
- O bot não consegue mudar o apelido do dono do servidor.
- A hierarquia de cargos deve colocar o bot acima dos membros que vão usar o comando.

## User preferences

_Falar em português._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
