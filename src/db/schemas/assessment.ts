import {
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AssessmentDocument } from '../../documents/assessment/schemas/document.schema.js';
import { userTable } from './user.js';

export const assessmentsTable = pgTable(
  'assessments',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .references(() => userTable.id, { onDelete: 'cascade' })
      .notNull(),
    // No FK, same as rag_documents: clients may pre-generate conversation ids.
    conversationId: uuid('conversation_id'),
    // Single source of truth; HTML, PDF and DOCX are derived from it on demand.
    document: jsonb().$type<AssessmentDocument>().notNull(),
    // Bumped on every change, for optimistic concurrency.
    version: integer().notNull().default(1),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdateFn(() => new Date())
      .defaultNow()
      .notNull(),
  },
  (tb) => [index('assessments_user_created_at_index').on(tb.userId, tb.createdAt)],
);

export type Assessment = typeof assessmentsTable.$inferSelect;
export type NewAssessment = typeof assessmentsTable.$inferInsert;
