import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const guildConfigTable = pgTable("guild_config", {
  guildId: text("guild_id").primaryKey(),
  logChannelId: text("log_channel_id"),
  staffRoleId: text("staff_role_id"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertGuildConfigSchema = createInsertSchema(guildConfigTable).omit({ updatedAt: true });
export type InsertGuildConfig = z.infer<typeof insertGuildConfigSchema>;
export type GuildConfig = typeof guildConfigTable.$inferSelect;
