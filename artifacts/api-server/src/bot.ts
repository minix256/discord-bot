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
  type ButtonInteraction,
  type APIGuild,
  type APIChannel,
  type APIInteractionGuildMember,
  type GuildMember,
} from "discord.js";
import { db, discordUserIdsTable } from "@workspace/db";
import { eq, count } from "drizzle-orm";
import { logger } from "./lib/logger";

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const RED = 0xe74c3c;

if (!TOKEN) throw new Error("DISCORD_BOT_TOKEN environment variable is required.");

// ─── Ticket types ─────────────────────────────────────────────────────────────
const TICKET_TYPES: Record<string, { label: string; emoji: string }> = {
  ticket_compras:   { label: "Compras",   emoji: "🛒" },
  ticket_geral:     { label: "Geral",     emoji: "💬" },
  ticket_duvidas:   { label: "Dúvidas",   emoji: "❓" },
  ticket_denuncias: { label: "Denúncias", emoji: "🚨" },
};

function randomTicketId(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// Helper: get display name from interaction member (works without cache)
function getMemberDisplayName(interaction: Interaction): string {
  const member = interaction.member as APIInteractionGuildMember | GuildMember | null;
  if (!member) return interaction.user.username;
  if ("nickname" in member && member.nickname) return member.nickname;
  if ("nick" in member && (member as APIInteractionGuildMember).nick) {
    return (member as APIInteractionGuildMember).nick!;
  }
  return interaction.user.displayName ?? interaction.user.username;
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
    new ButtonBuilder().setCustomId("ticket_compras").setLabel("Compras").setEmoji("🛒").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ticket_geral").setLabel("Geral").setEmoji("💬").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ticket_duvidas").setLabel("Dúvidas").setEmoji("❓").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ticket_denuncias").setLabel("Denúncias").setEmoji("🚨").setStyle(ButtonStyle.Danger),
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}

// ─── Button: abrir ticket (via REST — sem cache de guilda) ────────────────────
async function handleTicketButton(interaction: ButtonInteraction) {
  const type = TICKET_TYPES[interaction.customId];
  if (!type) return;

  await interaction.deferReply({ flags: 64 });

  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const userTag = interaction.user.tag;
  const botId = interaction.client.user!.id;

  if (!guildId) {
    await interaction.editReply("❌ Este botão só pode ser usado dentro de um servidor.");
    return;
  }

  // Pega categoryId diretamente do canal da interação (sem buscar guilda)
  let categoryId: string | undefined;
  try {
    const ch = await interaction.client.rest.get(Routes.channel(interaction.channelId)) as APIChannel;
    categoryId = "parent_id" in ch && ch.parent_id ? ch.parent_id : undefined;
  } catch {
    // sem categoria: cria na raiz
  }

  const ticketId = randomTicketId();
  const channelName = `ticket-${ticketId}`;

  try {
    // Cria canal via REST — sem precisar da guilda em cache
    const everyoneDeny = String(PermissionFlagsBits.ViewChannel);
    const userAllow = String(
      PermissionFlagsBits.ViewChannel |
      PermissionFlagsBits.SendMessages |
      PermissionFlagsBits.ReadMessageHistory,
    );
    const botAllow = String(
      PermissionFlagsBits.ViewChannel |
      PermissionFlagsBits.SendMessages |
      PermissionFlagsBits.ManageChannels |
      PermissionFlagsBits.ReadMessageHistory,
    );

    const newChannel = await interaction.client.rest.post(Routes.guildChannels(guildId), {
      body: {
        name: channelName,
        type: ChannelType.GuildText,
        parent_id: categoryId ?? null,
        permission_overwrites: [
          { id: guildId, type: 0, deny: everyoneDeny },       // @everyone
          { id: userId,  type: 1, allow: userAllow },          // usuário
          { id: botId,   type: 1, allow: botAllow },           // bot
        ],
      },
    }) as APIChannel;

    const welcomeEmbed = new EmbedBuilder()
      .setColor(RED)
      .setTitle(`${type.emoji} Ticket — ${type.label}`)
      .setDescription(
        `Olá, <@${userId}>! 👋\n\n` +
        `Seu ticket do tipo **${type.label}** foi criado com sucesso.\n` +
        `Aguarde, a equipe irá te atender em breve.\n\n` +
        `**ID do Ticket:** \`${ticketId}\``,
      )
      .setFooter({ text: `Ticket aberto por ${userTag}` })
      .setTimestamp();

    await interaction.client.rest.post(Routes.channelMessages(newChannel.id), {
      body: {
        content: `<@${userId}>`,
        embeds: [welcomeEmbed.toJSON()],
      },
    });

    logger.info({ userId, ticketId, type: type.label, guildId }, "Ticket criado");
    await interaction.editReply(`✅ Seu ticket foi criado! Acesse: <#${newChannel.id}>`);
  } catch (err) {
    logger.error({ err, guildId }, "Erro ao criar canal de ticket");
    const errMsg = err instanceof Error ? err.message : String(err);
    await interaction.editReply(
      `❌ Não consegui criar o canal do ticket. Verifique se o bot tem a permissão **Gerenciar Canais**.\nErro: ${errMsg}`,
    );
  }
}

// ─── /pedir id ────────────────────────────────────────────────────────────────
async function handlePedirId(interaction: Interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "pedir") return;
  if (interaction.options.getSubcommand() !== "id") return;

  await interaction.deferReply({ flags: 0 });

  const userId = interaction.user.id;
  const guildId = interaction.guildId;

  if (!guildId) {
    const embed = new EmbedBuilder()
      .setColor(RED)
      .setTitle("❌ Erro")
      .setDescription("Este comando só pode ser usado dentro de um servidor.");
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // Descobre se é o dono via REST — sem precisar do cache
  let isOwner = false;
  try {
    const guildData = await interaction.client.rest.get(Routes.guild(guildId)) as APIGuild;
    isOwner = guildData.owner_id === userId;
  } catch {
    // Se falhar, assume que não é dono
  }

  const displayName = getMemberDisplayName(interaction);

  async function trySetNickname(nickname: string): Promise<{ success: boolean; reason: string }> {
    if (isOwner) {
      return {
        success: false,
        reason:
          "Você é o **dono do servidor**. O Discord não permite que bots alterem o apelido do dono. Por favor, mude manualmente para `" + nickname + "`.",
      };
    }
    try {
      await interaction.client.rest.patch(Routes.guildMember(guildId!, userId), {
        body: { nick: nickname },
        reason: "ID atribuído via /pedir id",
      });
      return { success: true, reason: "" };
    } catch (err: unknown) {
      const code = (err as { code?: number }).code;
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, userId, code }, "Falha ao alterar apelido");
      let reason = "Não consegui alterar o apelido automaticamente.";
      if (code === 50013) {
        reason += " **Sem permissão** — o cargo do bot precisa estar acima do seu na hierarquia do servidor.";
      } else {
        reason += ` **Erro:** ${msg}`;
      }
      reason += `\nApelido sugerido: \`${nickname}\``;
      return { success: false, reason };
    }
  }

  logger.info({ userId, guildId, isOwner }, "Verificando dono");

  try {
    const existing = await db
      .select()
      .from(discordUserIdsTable)
      .where(eq(discordUserIdsTable.discordUserId, userId))
      .limit(1);

    if (existing.length > 0) {
      const record = existing[0]!;
      const newNickname = `${record.displayName} | ${record.seqId}`;
      const nickResult = await trySetNickname(newNickname);

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

    const [countResult] = await db.select({ value: count() }).from(discordUserIdsTable);
    const nextId = (countResult?.value ?? 0) + 1;
    const newNickname = `${displayName} | ${nextId}`;

    await db.insert(discordUserIdsTable).values({
      discordUserId: userId,
      seqId: nextId,
      displayName,
    });

    const nickResult = await trySetNickname(newNickname);
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
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

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
