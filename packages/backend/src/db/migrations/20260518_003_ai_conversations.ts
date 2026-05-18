import type { Knex } from 'knex';

/**
 * Schema for the optional in-app AI assistant.
 *
 * Three tables:
 *   - ai_conversations: per-user threads (title, timestamps)
 *   - ai_messages:      role + content + optional tool-call JSON per turn
 *   - ai_pending_actions: pre-authorised write-tool calls awaiting user
 *                         confirmation (suggest_only mode), TTL ~5min
 *
 * The feature is opt-in: nothing here runs until the user sets
 * settings.llm_autonomy != 'off' AND provides an LLM API key. The tables
 * exist either way so toggling the feature on doesn't require a migration.
 */

export async function up(knex: Knex): Promise<void> {
	const haveConv = await knex.schema.hasTable('ai_conversations');
	if (!haveConv) {
		await knex.schema.createTable('ai_conversations', (t) => {
			t.string('id').primary(); // UUID v4
			t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
			t.string('title').nullable();
			t.string('created_at').notNullable();
			t.string('updated_at').notNullable();
			t.index('user_id', 'ai_conv_user_idx');
			t.index('updated_at', 'ai_conv_updated_idx');
		});
	}

	const haveMsg = await knex.schema.hasTable('ai_messages');
	if (!haveMsg) {
		await knex.schema.createTable('ai_messages', (t) => {
			t.increments('id').primary();
			t.string('conversation_id')
				.notNullable()
				.references('id')
				.inTable('ai_conversations')
				.onDelete('CASCADE');
			t.string('role').notNullable(); // 'user' | 'assistant' | 'tool'
			t.text('content').nullable();
			t.text('tool_calls').nullable(); // JSON
			t.text('tool_results').nullable(); // JSON
			t.string('created_at').notNullable();
			t.index('conversation_id', 'ai_msg_conv_idx');
		});
	}

	const havePending = await knex.schema.hasTable('ai_pending_actions');
	if (!havePending) {
		await knex.schema.createTable('ai_pending_actions', (t) => {
			t.string('token').primary(); // UUID v4
			t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
			t.string('tool_name').notNullable();
			t.text('payload').notNullable(); // JSON of the proposed tool args
			t.text('summary').nullable(); // human-readable description for the UI
			t.string('expires_at').notNullable();
			t.string('created_at').notNullable();
			t.index('user_id', 'ai_pending_user_idx');
			t.index('expires_at', 'ai_pending_exp_idx');
		});
	}
}

export async function down(knex: Knex): Promise<void> {
	await knex.schema.dropTableIfExists('ai_pending_actions');
	await knex.schema.dropTableIfExists('ai_messages');
	await knex.schema.dropTableIfExists('ai_conversations');
}
