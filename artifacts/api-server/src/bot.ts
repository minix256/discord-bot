import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  type Interaction,
  type GuildMember,
  type TextChannel,
  type ButtonInteraction,
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

// ─── Ticket categories ───────────────────────────────────────────────────────
const TICKET_TYPES: Record<string, { label: string; emoji: string }> = {
  ticket_compras:   { label: "Compras",   emoji: "🛒" },
  ticket_geral:     { label: "Geral",     emoji: "💬" },
  ticket_duvidas:   { label: "Dúvidas",   emoji: "❓" },
  ticket_denuncias: { label: "Denúncias", emoji: "🚨" },
};

function randomTicketId(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// ─── Commands ─────────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("pedir")
    .setDescription("Comandos de pedido")
    .addSubcommand((sub) =>
      sub.setName("id").setDescription("Pede um ID único e atualiza seu apelido"),
    ),
  new SlashCommandBuilder()
    .setName("painel")
    .setDescription("Painéis administrativos")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub.setName("ticket").setDescription("Posta o painel de abertura de tickets"),
    ),
].map((cmd) => cmd.toJSON());

async function registerCommands(clientId: string) {
  const rest = new REST({ version: "10" }).setToken(TOKEN!);
  if (GUILD_ID) {
    logger.info({ guildId: GUILD_ID }, "Registrando comandos no servidor (guild)");
    await rest.put(Routes.applicationGuildCommands(clientId, GUILD_ID), { body: commands });
  } else {
    logger.info("Registrando comandos globalmente");
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
  }
  logger.info("Comandos registrados com sucesso");
}

// ─── /painel ticket ──────────────────────────────────────────────────────────
async function handlePainelTicket(interaction: Interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "painel") return;
  if (interaction.options.getSubcommand() !== "ticket") return;

  const embed = new EmbedBuilder()
    .setColor(RED)
    .setTitle("🎫 Central de Tickets")
    .setDescription(
      "Bem-vindo à central de suporte!\n\n" +
      "Selecione abaixo o tipo de ticket que deseja abrir:\n\n" +
      "🛒 **Compras** — Dúvidas ou suporte sobre compras e pagamentos\n" +
      "💬 **Geral** — Assuntos gerais que não se encaixam nas outras categorias\n" +
      "❓ **Dúvidas** — Tire suas dúvidas sobre o servidor ou serviços\n" +
      "🚨 **Denúncias** — Reporte membros ou situações que violem as regras\n\n" +
      "Clique no botão correspondente para abrir seu ticket.",
    )
    .setFooter({ text: "Apenas você e a equipe poderão ver o canal criado." })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket_compras")
      .setLabel("Compras")
      .setEmoji("🛒")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("ticket_geral")
      .setLabel("Geral")
      .setEmoji("💬")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("ticket_duvidas")
      .setLabel("Dúvidas")
      .setEmoji("❓")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("ticket_denuncias")
      .setLabel("Denúncias")
      .setEmoji("🚨")
      .setStyle(ButtonStyle.Danger),
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}

// ─── Button: abrir ticket ─────────────────────────────────────────────────────
async function handleTicketButton(interaction: ButtonInteraction) {
  const type = TICKET_TYPES[interaction.customId];
  if (!type) return;

  await interaction.deferReply({ flags: 64 }); // ephemeral só para quem clicou

  const guild = interaction.guild;
  const member = interaction.member as GuildMember | null;

  if (!guild || !member) {
    await interaction.editReply("Este botão só funciona dentro de um servidor.");
    return;
  }

  const sourceChannel = interaction.channel as TextChannel | null;
  const categoryId = sourceChannel?.parentId ?? null;
  const ticketId = randomTicketId();
  const channelName = `ticket-${ticketId}`;

  try {
    const ticketChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: categoryId ?? undefined,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: member.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
        {
          id: guild.members.me!.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
      ],
    });

    // Embed de boas-vindas dentro do ticket
    const welcomeEmbed = new EmbedBuilder()
      .setColor(RED)
      .setTitle(`${type.emoji} Ticket — ${type.label}`)
      .setDescription(
        `Olá, <@${member.user.id}>! 👋\n\n` +
        `Seu ticket do tipo **${type.label}** foi criado com sucesso.\n` +
        `Aguarde, a equipe irá te atender em breve.\n\n` +
        `**ID do Ticket:** \`${ticketId}\``,
      )
      .setFooter({ text: `Ticket aberto por ${interaction.user.tag}` })
      .setTimestamp();

    await ticketChannel.send({ content: `<@${member.user.id}>`, embeds: [welcomeEmbed] });

    logger.info({ userId: member.user.id, ticketId, type: type.label }, "Ticket criado");

    await interaction.editReply(
      `✅ Seu ticket foi criado! Acesse: <#${ticketChannel.id}>`,
    );
  } catch (err) {
    logger.error({ err }, "Erro ao criar canal de ticket");
    const errMsg = err instanceof Error ? err.message : String(err);
    await interaction.editReply(
      `❌ Não consegui criar o canal do ticket. Verifique se o bot tem permissão de **Gerenciar Canais**.\nErro: ${errMsg}`,
    );
  }
}

// ─── /pedir id ────────────────────────────────────────────────────────────────
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
        " **Motivo: sem permissão.** Certifique-se de que o cargo do bot está **acima** do seu cargo na hierarquia do servidor.";
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

    logger.info({ userId, seqId: nextId, nickname: newNickname, nickChanged: nickResult.success }, "ID atribuído");

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

// ─── Bot setup ────────────────────────────────────────────────────────────────
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
      if (interaction.isButton()) {
        await handleTicketButton(interaction as ButtonInteraction);
        return;
      }
      await handlePedirId(interaction);
      await handlePainelTicket(interaction);
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
