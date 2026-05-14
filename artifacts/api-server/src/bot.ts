import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  type Interaction,
  type GuildMember,
} from "discord.js";
import { db, discordUserIdsTable } from "@workspace/db";
import { eq, count } from "drizzle-orm";
import { logger } from "./lib/logger";

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

const RED = 0xe74c3c;

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

  // Visível para todos (sem ephemeral)
  await interaction.deferReply({ ephemeral: false });

  const userId = interaction.user.id;
  const member = interaction.member as GuildMember | null;

  if (!member) {
    const embed = new EmbedBuilder()
      .setColor(RED)
      .setTitle("❌ Erro")
      .setDescription("Este comando só pode ser usado dentro de um servidor.");
    await interaction.editReply({ embeds: [embed] });
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
      const embed = new EmbedBuilder()
        .setColor(RED)
        .setTitle("🪪 ID já registrado")
        .setDescription(`Você já possui um ID cadastrado!`)
        .addFields(
          { name: "Seu ID", value: `**${record.seqId}**`, inline: true },
          { name: "Apelido", value: `\`${record.displayName} | ${record.seqId}\``, inline: true },
        )
        .setFooter({ text: `Solicitado por ${interaction.user.tag}` })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
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

    // Tenta mudar o apelido
    const isOwner = interaction.guild?.ownerId === userId;
    let nickChanged = false;
    let nickWarning = "";

    if (isOwner) {
      nickWarning = "⚠️ Você é o dono do servidor — o Discord não permite que bots alterem o apelido do dono. Por favor, mude manualmente para `" + newNickname + "`.";
    } else {
      try {
        await (member as GuildMember).setNickname(newNickname, "ID atribuído via /pedir id");
        nickChanged = true;
      } catch (nickErr) {
        logger.warn({ err: nickErr, userId }, "Não foi possível alterar o apelido");
        const errMsg = nickErr instanceof Error ? nickErr.message : String(nickErr);
        nickWarning = `⚠️ Não consegui alterar o apelido automaticamente: ${errMsg}\nMude manualmente para \`${newNickname}\`.`;
      }
    }

    logger.info({ userId, seqId: nextId, nickname: newNickname, nickChanged }, "ID atribuído");

    const embed = new EmbedBuilder()
      .setColor(RED)
      .setTitle("🪪 ID Registrado com Sucesso!")
      .setDescription(nickChanged
        ? `Seu apelido foi atualizado para \`${newNickname}\`.`
        : nickWarning)
      .addFields(
        { name: "Membro", value: `<@${userId}>`, inline: true },
        { name: "ID", value: `**${nextId}**`, inline: true },
        { name: "Apelido", value: `\`${newNickname}\``, inline: true },
      )
      .setFooter({ text: `Solicitado por ${interaction.user.tag}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    logger.error({ err, userId }, "Erro ao processar /pedir id");
    const embed = new EmbedBuilder()
      .setColor(RED)
      .setTitle("❌ Erro interno")
      .setDescription("Ocorreu um erro ao processar seu pedido. Tente novamente.");
    await interaction.editReply({ embeds: [embed] });
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
