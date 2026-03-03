import Database from 'better-sqlite3';
import { UserPreferenceRepository } from '../../src/database/userPreferenceRepository';

describe('UserPreferenceRepository', () => {
    let db: Database.Database;
    let repo: UserPreferenceRepository;

    beforeEach(() => {
        db = new Database(':memory:');
        repo = new UserPreferenceRepository(db);
    });

    afterEach(() => {
        db.close();
    });

    describe('table initialization', () => {
        it('creates the user_preferences table on initialization', () => {
            const tables = db.prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='user_preferences'"
            ).all();
            expect(tables).toHaveLength(1);
        });
    });

    describe('getOutputFormat', () => {
        it('returns embed as default for unknown user', () => {
            const format = repo.getOutputFormat('unknown-user-id');
            expect(format).toBe('embed');
        });

        it('returns the stored format', () => {
            repo.setOutputFormat('user-1', 'plain');
            expect(repo.getOutputFormat('user-1')).toBe('plain');
        });

        it('returns embed after setting to embed', () => {
            repo.setOutputFormat('user-1', 'embed');
            expect(repo.getOutputFormat('user-1')).toBe('embed');
        });
    });

    describe('setOutputFormat', () => {
        it('inserts a new preference record', () => {
            repo.setOutputFormat('user-1', 'plain');
            const record = repo.findByUserId('user-1');
            expect(record).toBeDefined();
            expect(record?.outputFormat).toBe('plain');
        });

        it('updates an existing preference via upsert', () => {
            repo.setOutputFormat('user-1', 'plain');
            repo.setOutputFormat('user-1', 'embed');
            expect(repo.getOutputFormat('user-1')).toBe('embed');
        });

        it('handles multiple users independently', () => {
            repo.setOutputFormat('user-1', 'plain');
            repo.setOutputFormat('user-2', 'embed');
            expect(repo.getOutputFormat('user-1')).toBe('plain');
            expect(repo.getOutputFormat('user-2')).toBe('embed');
        });
    });

    describe('getDefaultModel', () => {
        it('returns null for unknown user', () => {
            expect(repo.getDefaultModel('unknown-user')).toBeNull();
        });

        it('returns null when user exists but no default is set', () => {
            repo.setOutputFormat('user-1', 'embed');
            expect(repo.getDefaultModel('user-1')).toBeNull();
        });

        it('returns the stored default model', () => {
            repo.setDefaultModel('user-1', 'claude-sonnet-4.6-thinking');
            expect(repo.getDefaultModel('user-1')).toBe('claude-sonnet-4.6-thinking');
        });
    });

    describe('setDefaultModel', () => {
        it('inserts a new record when user does not exist', () => {
            repo.setDefaultModel('new-user', 'gemini-3-flash');
            expect(repo.getDefaultModel('new-user')).toBe('gemini-3-flash');
        });

        it('updates existing record via upsert', () => {
            repo.setDefaultModel('user-1', 'model-a');
            repo.setDefaultModel('user-1', 'model-b');
            expect(repo.getDefaultModel('user-1')).toBe('model-b');
        });

        it('clears default when null is passed', () => {
            repo.setDefaultModel('user-1', 'model-a');
            repo.setDefaultModel('user-1', null);
            expect(repo.getDefaultModel('user-1')).toBeNull();
        });

        it('handles multiple users independently', () => {
            repo.setDefaultModel('user-1', 'model-a');
            repo.setDefaultModel('user-2', 'model-b');
            expect(repo.getDefaultModel('user-1')).toBe('model-a');
            expect(repo.getDefaultModel('user-2')).toBe('model-b');
        });

        it('does not affect output format when setting default model', () => {
            repo.setOutputFormat('user-1', 'plain');
            repo.setDefaultModel('user-1', 'some-model');
            expect(repo.getOutputFormat('user-1')).toBe('plain');
        });
    });

    describe('migration', () => {
        it('adds default_model column to existing table', () => {
            // The constructor already ran the migration.
            // Verify by checking the column exists via pragma.
            const columns = db.pragma('table_info(user_preferences)') as { name: string }[];
            const hasColumn = columns.some(c => c.name === 'default_model');
            expect(hasColumn).toBe(true);
        });

        it('re-creating repository on same db does not fail', () => {
            // Second construction should detect column already exists and skip ALTER
            const repo2 = new UserPreferenceRepository(db);
            repo2.setDefaultModel('user-x', 'test');
            expect(repo2.getDefaultModel('user-x')).toBe('test');
        });
    });

    describe('findByUserId', () => {
        it('returns undefined for non-existent user', () => {
            const record = repo.findByUserId('no-such-user');
            expect(record).toBeUndefined();
        });

        it('returns full record with mapped fields', () => {
            repo.setOutputFormat('user-1', 'plain');
            const record = repo.findByUserId('user-1');
            expect(record).toBeDefined();
            expect(record?.id).toBeDefined();
            expect(record?.userId).toBe('user-1');
            expect(record?.outputFormat).toBe('plain');
            expect(record?.createdAt).toBeDefined();
            expect(record?.updatedAt).toBeDefined();
        });

        it('includes defaultModel in the mapped record', () => {
            repo.setDefaultModel('user-1', 'my-model');
            const record = repo.findByUserId('user-1');
            expect(record?.defaultModel).toBe('my-model');
        });
    });
});
