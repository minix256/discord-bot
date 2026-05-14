import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type Interaction,
  type GuildMember,
} from "discord.js";
import { db, discordUserIdsTable } from "@workspace/db";
import { eq, count } from "drizzle-orm";
import { logger } from "./lib/logger";

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!TOKEN) {
  throw new Error("DISCORD_BOT_TOKEN environment variable is required.");
}

const commands = [
  new SlashCommandBuilder()
    .setName("pedir")
    .setDescription("Comandos de pedido")
    .addSubcommand((sub) =>
      sub.setName("id").setDescription("Pede um ID único e atualiza seu apelido"),
    ),
].map((cmd) => cmd.toJSON());

async function registerCommands(clientId: string) {
  const rest = new REST({ version: "10" }).setToken(TOKEN!);

  if (GUILD_ID) {
    logger.info({ guildId: GUILD_ID }, "Registrando comandos no servidor (guild)");
    await rest.put(Routes.applicationGuildCommands(clientId, GUILD_ID), {
      body: commands,
    });
  } else {
    logger.info("Registrando comandos globalmente (pode levar até 1 hora)");
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
  }

  logger.info("Comandos registrados com sucesso");
}

async function handlePedirId(interaction: Interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "pedir") return;
  if (interaction.options.getSubcommand() !== "id") return;

  await interaction.deferReply({ ephemeral: true });

  const userId = interaction.user.id;
  const member = interaction.member as GuildMember | null;

  if (!member) {
    await interaction.editReply("Este comando só pode ser usado em um servidor.");
    return;
  }

  try {
    const existing = await db
      .select()
      .from(discordUserIdsTable)
      .where(eq(discordUserIdsTable.discordUserId, userId))
      .limit(1);

    if (existing.length > 0) {
      const record = existing[0]!;
      await interaction.editReply(
        `Você já possui o ID **${record.seqId}**. Seu apelido é: \`${record.displayName} | ${record.seqId}\``,
      );
      return;
    }

    const [countResult] = await db
      .select({ value: count() })
      .from(discordUserIdsTable);

    const nextId = (countResult?.value ?? 0) + 1;
    const displayName = member.displayName;
    const newNickname = `${displayName} | ${nextId}`;

    await db.insert(discordUserIdsTable).values({
      discordUserId: userId,
      seqId: nextId,
      displayName: displayName,
    });

    try {
      await member.setNickname(newNickname, "ID atribuído via /pedir id");
    } catch (nickErr) {
      logger.warn({ err: nickErr, userId }, "Não foi possível alterar o apelido (verifique permissões do bot)");
      await interaction.editReply(
        `Seu ID é **${nextId}**! Não consegui mudar seu apelido automaticamente (verifique se o bot tem permissão de gerenciar apelidos e se seu cargo é inferior ao do bot). Apelido sugerido: \`${newNickname}\``,
      );
      return;
    }

    logger.info({ userId, seqId: nextId, nickname: newNickname }, "ID atribuído");
    await interaction.editReply(
      `✅ Seu ID é **${nextId}**! Seu apelido foi atualizado para: \`${newNickname}\``,
    );
  } catch (err) {
    logger.error({ err, userId }, "Erro ao processar /pedir id");
    await interaction.editReply("Ocorreu um erro ao processar seu pedido. Tente novamente.");
  }
}

export function startBot() {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once("ready", async (c) => {
    logger.info({ tag: c.user.tag }, "Bot conectado ao Discord");
    try {
      await registerCommands(c.user.id);
    } catch (err) {
      logger.error({ err }, "Falha ao registrar comandos");
    }
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      await handlePedirId(interaction);
    } catch (err) {
      logger.error({ err }, "Erro não tratado na interação");
    }
  });

  client.on("error", (err) => {
    logger.error({ err }, "Erro no cliente Discord");
  });

  client.login(TOKEN).catch((err) => {
    logger.error({ err }, "Falha ao fazer login no Discord");
    process.exit(1);
  });

  return client;
}
