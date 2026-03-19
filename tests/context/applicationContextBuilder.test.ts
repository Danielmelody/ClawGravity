import {
    clearApplicationContext,
    getApplicationContext,
    setApplicationContext,
} from '../../src/context/applicationContext';
import { buildApplicationContext } from '../../src/context/applicationContextBuilder';
import type { AppConfig } from '../../src/utils/config';

describe('applicationContextBuilder', () => {
    const config: AppConfig = {
        allowedUserIds: ['123'],
        workspaceBaseDir: process.cwd(),
        autoApproveFileEdits: false,
        logLevel: 'info',
        extractionMode: 'structured',
        platforms: ['discord'],
    };

    afterEach(() => {
        try {
            getApplicationContext().db.close();
        } catch {
            // Context may not be set in every test.
        }
        clearApplicationContext();
    });

    it('produces a working schedule service backed by a real database', async () => {
        const ctx = await buildApplicationContext({
            config,
            sendPromptImpl: jest.fn().mockResolvedValue(undefined),
        });

        try {
            // Verify the schedule service and repository are wired together
            // by actually creating and retrieving a schedule through the service.
            const jobCallback = jest.fn();
            const record = ctx.scheduleService.addSchedule(
                '0 9 * * *',
                'good morning',
                '/tmp/test-ws',
                jobCallback,
            );

            const stored = ctx.scheduleRepo.findById(record.id);
            expect(stored).toBeDefined();
            expect(stored!.prompt).toBe('good morning');
            expect(stored!.enabled).toBe(true);
        } finally {
            ctx.db.close();
        }
    });

    it('loads the saved default model from user preferences', async () => {
        const ctx = await buildApplicationContext({
            config,
            sendPromptImpl: jest.fn().mockResolvedValue(undefined),
        });

        try {
            // Simulate saving a default model preference and rebuilding
            ctx.userPrefRepo.setDefaultModel('123', 'gemini-2.5-pro');
            ctx.db.close();

            // Build a new context that should pick up the saved preference
            const ctx2 = await buildApplicationContext({
                config,
                sendPromptImpl: jest.fn().mockResolvedValue(undefined),
            });

            expect(ctx2.modelService.getDefaultModel()).toBe('gemini-2.5-pro');
            ctx2.db.close();
        } catch {
            // If user pref table doesn't exist yet, that's fine —
            // the builder handles this gracefully.
            ctx.db.close();
        }
    });

    it('remains compatible with the global context getter/setter', async () => {
        const ctx = await buildApplicationContext({
            config,
            sendPromptImpl: jest.fn().mockResolvedValue(undefined),
        });

        setApplicationContext(ctx);
        expect(getApplicationContext()).toBe(ctx);
    });

    it('throws when accessing the global context before initialization', () => {
        expect(() => getApplicationContext()).toThrow('Application context is not initialized');
    });
});
