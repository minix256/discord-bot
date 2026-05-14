import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
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
    logger.info("Registrando comandos globalmente");
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
  }

  logger.info("Comandos registrados com sucesso");
}

async function trySetNickname(
  member: GuildMember,
  nickname: string,
  isOwner: boolean,
): Promise<{ success: boolean; reason: string }> {
  if (isOwner) {
    return {
      success: false,
      reason:
        "Você é o **dono do servidor**. O Discord não permite que bots alterem o apelido do dono — isso é uma restrição da própria plataforma. Por favor, mude manualmente para `" +
        nickname +
        "`.",
    };
  }

  try {
    await member.setNickname(nickname, "ID atribuído via /pedir id");
    return { success: true, reason: "" };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: number }).code;
    logger.error({ err, userId: member.id, code }, "Falha ao alterar apelido");

    let reason = `Não consegui alterar o apelido automaticamente.`;

    if (code === 50013) {
      reason +=
        " **Motivo: sem permissão.** Certifique-se de que o cargo do bot está **acima** do seu cargo na hierarquia do servidor (Configurações → Cargos → arraste o cargo do bot para cima).";
    } else if (code === 50035) {
      reason += " **Motivo: apelido inválido** (muito longo ou caractere inválido).";
    } else {
      reason += ` **Motivo: ${msg}**`;
    }

    reason += `\nApelido sugerido: \`${nickname}\``;
    return { success: false, reason };
  }
}

async function handlePedirId(interaction: Interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "pedir") return;
  if (interaction.options.getSubcommand() !== "id") return;

  // Visível para todos
  await interaction.deferReply({ flags: 0 });

  const userId = interaction.user.id;
  const guild = interaction.guild;
  const member = interaction.member as GuildMember | null;

  if (!member || !guild) {
    const embed = new EmbedBuilder()
      .setColor(RED)
      .setTitle("❌ Erro")
      .setDescription("Este comando só pode ser usado dentro de um servidor.");
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const isOwner = guild.ownerId === userId;
  logger.info({ userId, guildOwnerId: guild.ownerId, isOwner }, "Verificando dono");

  try {
    const existing = await db
      .select()
      .from(discordUserIdsTable)
      .where(eq(discordUserIdsTable.discordUserId, userId))
      .limit(1);

    if (existing.length > 0) {
      const record = existing[0]!;
      const newNickname = `${record.displayName} | ${record.seqId}`;

      // Tenta mudar apelido mesmo que já tenha ID (caso não tenha conseguido antes)
      const nickResult = await trySetNickname(member, newNickname, isOwner);

      const embed = new EmbedBuilder()
        .setColor(RED)
        .setTitle("🪪 ID já registrado")
        .addFields(
          { name: "Membro", value: `<@${userId}>`, inline: true },
          { name: "ID", value: `**${record.seqId}**`, inline: true },
          { name: "Apelido", value: `\`${newNickname}\``, inline: true },
        )
        .setDescription(
          nickResult.success
            ? "Você já tinha um ID — seu apelido foi atualizado agora!"
            : `Você já tem um ID cadastrado.\n\n${nickResult.reason}`,
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

    const nickResult = await trySetNickname(member, newNickname, isOwner);

    logger.info(
      { userId, seqId: nextId, nickname: newNickname, nickChanged: nickResult.success },
      "ID atribuído",
    );

    const embed = new EmbedBuilder()
      .setColor(RED)
      .setTitle("🪪 ID Registrado com Sucesso!")
      .setDescription(
        nickResult.success
          ? `Seu apelido foi atualizado para \`${newNickname}\`.`
          : nickResult.reason,
      )
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

  client.once("clientReady", async (c) => {
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
