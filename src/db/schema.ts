import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  pgEnum,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Enums
export const widgetKeyStatusEnum = pgEnum('widget_key_status', [
  'ACTIVE',
  'REVOKED',
]);

export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant']);

// Tables
/**
 * 위젯 키 테이블
 * - 위젯 인증에 사용되는 키 정보를 저장
 */
export const widgetKeys = pgTable(
  'widget_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    secretKey: varchar('secret_key', { length: 255 }).notNull().unique(),
    status: widgetKeyStatusEnum('status').notNull().default('ACTIVE'),
    allowedDomains: jsonb('allowed_domains')
      .notNull()
      .$type<string[]>()
      .default([]),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    secretKeyIdx: index('widget_keys_secret_key_idx').on(table.secretKey),
    statusIdx: index('widget_keys_status_idx').on(table.status),
  }),
);

/**
 * 세션 테이블
 * - 위젯에서 발급받은 세션 토큰 정보를 저장
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    widgetKeyId: uuid('widget_key_id')
      .notNull()
      .references(() => widgetKeys.id, { onDelete: 'cascade' }),
    sessionToken: text('session_token').notNull().unique(),
    pageUrl: varchar('page_url', { length: 2048 }).notNull(),
    origin: varchar('origin', { length: 512 }),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    sessionTokenIdx: index('sessions_session_token_idx').on(table.sessionToken),
    widgetKeyIdIdx: index('sessions_widget_key_id_idx').on(table.widgetKeyId),
    expiresAtIdx: index('sessions_expires_at_idx').on(table.expiresAt),
  }),
);

/**
 * 메시지 테이블
 * - 채팅 메시지를 저장
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    role: messageRoleEnum('role').notNull(),
    content: text('content').notNull(),
    metadata: jsonb('metadata').$type<Record<string, any>>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    sessionIdIdx: index('messages_session_id_idx').on(table.sessionId),
    createdAtIdx: index('messages_created_at_idx').on(table.createdAt),
    sessionCreatedIdx: index('messages_session_created_idx').on(
      table.sessionId,
      table.createdAt,
    ),
  }),
);

// Relations
export const widgetKeysRelations = relations(widgetKeys, ({ many }) => ({
  sessions: many(sessions),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  widgetKey: one(widgetKeys, {
    fields: [sessions.widgetKeyId],
    references: [widgetKeys.id],
  }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  session: one(sessions, {
    fields: [messages.sessionId],
    references: [sessions.id],
  }),
}));

// Types
export type WidgetKey = typeof widgetKeys.$inferSelect;
export type NewWidgetKey = typeof widgetKeys.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
