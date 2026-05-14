import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const discordUserIdsTable = pgTable("discord_user_ids", {
  id: serial("id").primaryKey(),
  discordUserId: text("discord_user_id").notNull().unique(),
  seqId: integer("seq_id").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertDiscordUserIdSchema = createInsertSchema(discordUserIdsTable).omit({ id: true, createdAt: true });
export type InsertDiscordUserId = z.infer<typeof insertDiscordUserIdSchema>;
export type DiscordUserId = typeof discordUserIdsTable.$inferSelect;
