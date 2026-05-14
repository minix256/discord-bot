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
import { db, discordUserIdsTable, guildConfigTable } from "@workspace/db";
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

function getMemberDisplayName(interaction: Interaction): string {
  // Usa o nome global do Discord (display name) ou username.
  // Nunca usa o apelido do servidor — ele é o que vamos sobrescrever.
  return interaction.user.globalName ?? interaction.user.username;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────
async function getGuildConfig(guildId: string) {
  const rows = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, guildId)).limit(1);
  return rows[0] ?? null;
}

async function sendLog(
  client: Client,
  guildId: string,
  embed: EmbedBuilder,
) {
  const config = await getGuildConfig(guildId);
  if (!config?.logChannelId) return;
  try {
    await client.rest.post(Routes.channelMessages(config.logChannelId), {
      body: { embeds: [embed.toJSON()] },
    });
  } catch (err) {
    logger.warn({ err, guildId, logChannelId: config.logChannelId }, "Falha ao enviar log");
  }
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
  new SlashCommandBuilder()
    .setName("configurar")
    .setDescription("Configurações do bot neste servidor")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName("logs")
        .setDescription("Define o canal onde os logs de ticket serão enviados")
        .addChannelOption((opt) =>
          opt.setName("canal").setDescription("Canal de texto para os logs").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("staff")
        .setDescription("Define o cargo que poderá ver e ser notificado nos tickets")
        .addRoleOption((opt) =>
          opt.setName("cargo").setDescription("Cargo staff/equipe").setRequired(true),
        ),
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

// ─── /configurar ──────────────────────────────────────────────────────────────
async function handleConfigurar(interaction: Interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "configurar") return;

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "❌ Este comando só pode ser usado em um servidor.", flags: 64 });
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === "logs") {
    const canal = interaction.options.getChannel("canal", true);
    await db
      .insert(guildConfigTable)
      .values({ guildId, logChannelId: canal.id })
      .onConflictDoUpdate({ target: guildConfigTable.guildId, set: { logChannelId: canal.id } });

    const embed = new EmbedBuilder()
      .setColor(RED)
      .setTitle("✅ Canal de logs configurado")
      .setDescription(`Os logs de ticket serão enviados para <#${canal.id}>.`)
      .setTimestamp();
    await interaction.reply({ embeds: [embed], flags: 64 });
  }

  if (sub === "staff") {
    const cargo = interaction.options.getRole("cargo", true);
    await db
      .insert(guildConfigTable)
      .values({ guildId, staffRoleId: cargo.id })
      .onConflictDoUpdate({ target: guildConfigTable.guildId, set: { staffRoleId: cargo.id } });

    const embed = new EmbedBuilder()
      .setColor(RED)
      .setTitle("✅ Cargo staff configurado")
      .setDescription(`O cargo <@&${cargo.id}> poderá ver os tickets e será notificado quando solicitado.`)
      .setTimestamp();
    await interaction.reply({ embeds: [embed], flags: 64 });
  }
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

// ─── Button: abrir ticket ─────────────────────────────────────────────────────
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

  const config = await getGuildConfig(guildId);
  const staffRoleId = config?.staffRoleId ?? null;

  let categoryId: string | undefined;
  try {
    const ch = await interaction.client.rest.get(Routes.channel(interaction.channelId)) as APIChannel;
    categoryId = "parent_id" in ch && ch.parent_id ? ch.parent_id : undefined;
  } catch { /* sem categoria */ }

  const ticketId = randomTicketId();
  const channelName = `ticket-${ticketId}`;

  try {
    const everyoneDeny = String(PermissionFlagsBits.ViewChannel);
    const userAllow = String(
      PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory,
    );
    const botAllow = String(
      PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages |
      PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ReadMessageHistory,
    );

    const permissionOverwrites: object[] = [
      { id: guildId, type: 0, deny: everyoneDeny },
      { id: userId,  type: 1, allow: userAllow },
      { id: botId,   type: 1, allow: botAllow },
    ];

    // Adiciona staff role se configurado
    if (staffRoleId) {
      permissionOverwrites.push({ id: staffRoleId, type: 0, allow: userAllow });
    }

    const newChannel = await interaction.client.rest.post(Routes.guildChannels(guildId), {
      body: { name: channelName, type: ChannelType.GuildText, parent_id: categoryId ?? null, permission_overwrites: permissionOverwrites },
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

    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("notify_staff").setLabel("Notificar Staff").setEmoji("🔔").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("close_ticket").setLabel("Fechar Ticket").setEmoji("🔒").setStyle(ButtonStyle.Danger),
    );

    await interaction.client.rest.post(Routes.channelMessages(newChannel.id), {
      body: {
        content: `<@${userId}>`,
        embeds: [welcomeEmbed.toJSON()],
        components: [actionRow.toJSON()],
      },
    });

    logger.info({ userId, ticketId, type: type.label, guildId }, "Ticket criado");
    await interaction.editReply(`✅ Seu ticket foi criado! Acesse: <#${newChannel.id}>`);

    // Log de abertura
    await sendLog(interaction.client, guildId, new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle("🎫 Ticket Aberto")
      .addFields(
        { name: "Usuário", value: `<@${userId}> (${userTag})`, inline: true },
        { name: "Tipo", value: `${type.emoji} ${type.label}`, inline: true },
        { name: "Canal", value: `<#${newChannel.id}>`, inline: true },
        { name: "ID do Ticket", value: `\`${ticketId}\``, inline: true },
      )
      .setTimestamp(),
    );
  } catch (err) {
    logger.error({ err, guildId }, "Erro ao criar canal de ticket");
    const errMsg = err instanceof Error ? err.message : String(err);
    await interaction.editReply(
      `❌ Não consegui criar o canal do ticket. Verifique se o bot tem a permissão **Gerenciar Canais**.\nErro: ${errMsg}`,
    );
  }
}

// ─── Button: notificar staff ──────────────────────────────────────────────────
async function handleNotifyStaff(interaction: ButtonInteraction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "❌ Só funciona dentro de um servidor.", flags: 64 });
    return;
  }

  const config = await getGuildConfig(guildId);

  if (!config?.staffRoleId) {
    await interaction.reply({
      content: "❌ Nenhum cargo staff configurado. Um admin deve usar `/configurar staff @cargo` primeiro.",
      flags: 64,
    });
    return;
  }

  await interaction.reply({
    content: `🔔 <@&${config.staffRoleId}> — <@${interaction.user.id}> está aguardando atendimento neste ticket!`,
  });
}

// ─── Button: fechar ticket ────────────────────────────────────────────────────
async function handleCloseTicket(interaction: ButtonInteraction) {
  const channelId = interaction.channelId;
  const guildId = interaction.guildId;
  const userTag = interaction.user.tag;
  const userId = interaction.user.id;

  if (!guildId) {
    await interaction.reply({ content: "❌ Só funciona dentro de um servidor.", flags: 64 });
    return;
  }

  const closeEmbed = new EmbedBuilder()
    .setColor(RED)
    .setTitle("🔒 Ticket Encerrado")
    .setDescription(`Este ticket foi encerrado por **${userTag}**.\nO canal será deletado em instantes...`)
    .setTimestamp();

  await interaction.reply({ embeds: [closeEmbed] });
  logger.info({ channelId, guildId, closedBy: userTag }, "Ticket encerrado");

  // Log de fechamento
  const channelName = interaction.channel
    ? ("name" in interaction.channel ? interaction.channel.name : channelId)
    : channelId;

  await sendLog(interaction.client, guildId, new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle("🔒 Ticket Fechado")
    .addFields(
      { name: "Fechado por", value: `<@${userId}> (${userTag})`, inline: true },
      { name: "Canal", value: `\`${channelName}\``, inline: true },
    )
    .setTimestamp(),
  );

  await new Promise((res) => setTimeout(res, 3000));

  try {
    await interaction.client.rest.delete(Routes.channel(channelId));
  } catch (err) {
    logger.error({ err, channelId }, "Erro ao deletar canal de ticket");
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
      .setColor(RED).setTitle("❌ Erro")
      .setDescription("Este comando só pode ser usado dentro de um servidor.");
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  let isOwner = false;
  try {
    const guildData = await interaction.client.rest.get(Routes.guild(guildId)) as APIGuild;
    isOwner = guildData.owner_id === userId;
  } catch { /* assume não é dono */ }

  const displayName = getMemberDisplayName(interaction);

  async function trySetNickname(nickname: string): Promise<{ success: boolean; reason: string }> {
    if (isOwner) {
      return {
        success: false,
        reason: "Você é o **dono do servidor**. O Discord não permite que bots alterem o apelido do dono. Por favor, mude manualmente para `" + nickname + "`.",
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
        reason += " **Sem permissão** — o cargo do bot precisa estar acima do seu na hierarquia.";
      } else {
        reason += ` **Erro:** ${msg}`;
      }
      reason += `\nApelido sugerido: \`${nickname}\``;
      return { success: false, reason };
    }
  }

  logger.info({ userId, guildId, isOwner }, "Verificando dono");

  try {
    const existing = await db.select().from(discordUserIdsTable).where(eq(discordUserIdsTable.discordUserId, userId)).limit(1);

    if (existing.length > 0) {
      const record = existing[0]!;
      const newNickname = `${record.displayName} | ${record.seqId}`;
      const nickResult = await trySetNickname(newNickname);
      const embed = new EmbedBuilder()
        .setColor(RED).setTitle("🪪 ID já registrado")
        .addFields(
          { name: "Membro", value: `<@${userId}>`, inline: true },
          { name: "ID", value: `**${record.seqId}**`, inline: true },
          { name: "Apelido", value: `\`${newNickname}\``, inline: true },
        )
        .setDescription(nickResult.success ? "Você já tinha um ID — seu apelido foi atualizado agora!" : `Você já tem um ID cadastrado.\n\n${nickResult.reason}`)
        .setFooter({ text: `Solicitado por ${interaction.user.tag}` }).setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const [countResult] = await db.select({ value: count() }).from(discordUserIdsTable);
    const nextId = (countResult?.value ?? 0) + 1;
    const newNickname = `${displayName} | ${nextId}`;

    await db.insert(discordUserIdsTable).values({ discordUserId: userId, seqId: nextId, displayName });
    const nickResult = await trySetNickname(newNickname);

    logger.info({ userId, seqId: nextId, nickname: newNickname, nickChanged: nickResult.success }, "ID atribuído");

    const embed = new EmbedBuilder()
      .setColor(RED).setTitle("🪪 ID Registrado com Sucesso!")
      .setDescription(nickResult.success ? `Seu apelido foi atualizado para \`${newNickname}\`.` : nickResult.reason)
      .addFields(
        { name: "Membro", value: `<@${userId}>`, inline: true },
        { name: "ID", value: `**${nextId}**`, inline: true },
        { name: "Apelido", value: `\`${newNickname}\``, inline: true },
      )
      .setFooter({ text: `Solicitado por ${interaction.user.tag}` }).setTimestamp();
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    logger.error({ err, userId }, "Erro ao processar /pedir id");
    const embed = new EmbedBuilder().setColor(RED).setTitle("❌ Erro interno").setDescription("Ocorreu um erro ao processar seu pedido. Tente novamente.");
    await interaction.editReply({ embeds: [embed] });
  }
}

// ─── Bot setup ────────────────────────────────────────────────────────────────
export function startBot() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once("clientReady", async (c) => {
    logger.info({ tag: c.user.tag }, "Bot conectado ao Discord");
    try { await registerCommands(c.user.id); }
    catch (err) { logger.error({ err }, "Falha ao registrar comandos"); }
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isButton()) {
        const btn = interaction as ButtonInteraction;
        if (btn.customId === "close_ticket")  { await handleCloseTicket(btn); return; }
        if (btn.customId === "notify_staff")  { await handleNotifyStaff(btn); return; }
        await handleTicketButton(btn);
        return;
      }
      await handlePedirId(interaction);
      await handlePainelTicket(interaction);
      await handleConfigurar(interaction);
    } catch (err) {
      logger.error({ err }, "Erro não tratado na interação");
    }
  });

  client.on("error", (err) => { logger.error({ err }, "Erro no cliente Discord"); });

  client.login(TOKEN).catch((err) => {
    logger.error({ err }, "Falha ao fazer login no Discord");
    process.exit(1);
  });

  return client;
}
