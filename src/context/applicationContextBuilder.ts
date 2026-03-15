import Database from 'better-sqlite3';
import { Context, Effect, Layer } from 'effect';

import type { PromptDispatcherDeps } from '../services/promptDispatcher';
import { PromptDispatcher } from '../services/promptDispatcher';
import { ModeService } from '../services/modeService';
import { ModelService } from '../services/modelService';
import { WorkspaceService } from '../services/workspaceService';
import { ChannelManager } from '../services/channelManager';
import { ChatSessionService } from '../services/chatSessionService';
import { ScheduleService } from '../services/scheduleService';
import { TitleGeneratorService } from '../services/titleGeneratorService';
import { initCdpBridge } from '../services/cdpBridgeManager';

import { TemplateRepository } from '../database/templateRepository';
import { WorkspaceBindingRepository } from '../database/workspaceBindingRepository';
import { ChatSessionRepository } from '../database/chatSessionRepository';
import { ScheduleRepository } from '../database/scheduleRepository';
import { UserPreferenceRepository } from '../database/userPreferenceRepository';

import type { AppConfig } from '../utils/config';
import {
    ApplicationContext,
    ApplicationContextTag,
} from './applicationContext';

export interface ApplicationContextBuilderOptions {
    readonly config: AppConfig;
    readonly sendPromptImpl: PromptDispatcherDeps['sendPromptImpl'];
}

const AppConfigTag = Context.GenericTag<AppConfig>('claw-gravity/AppConfig');
const SendPromptImplTag = Context.GenericTag<PromptDispatcherDeps['sendPromptImpl']>(
    'claw-gravity/SendPromptImpl',
);

function loadDefaultModel(
    db: Database.Database,
    modelService: ModelService,
    userPrefRepo: UserPreferenceRepository,
): void {
    try {
        const firstUser = db.prepare(
            'SELECT user_id FROM user_preferences LIMIT 1',
        ).get() as { user_id: string } | undefined;
        if (!firstUser) return;

        const savedDefault = userPrefRepo.getDefaultModel(firstUser.user_id);
        modelService.loadDefaultModel(savedDefault);
    } catch {
        // DB may not have user_preferences yet.
    }
}

function makeApplicationLayer(
    options: ApplicationContextBuilderOptions,
): Layer.Layer<ApplicationContext> {
    return Layer.provide(
        Layer.effect(
            ApplicationContextTag,
            Effect.gen(function* () {
                const config = yield* AppConfigTag;
                const sendPromptImpl = yield* SendPromptImplTag;

                const db = new Database(
                    process.env.NODE_ENV === 'test' ? ':memory:' : 'antigravity.db',
                );
                const modeService = new ModeService();
                const userPrefRepo = new UserPreferenceRepository(db);
                const modelService = new ModelService();

                loadDefaultModel(db, modelService, userPrefRepo);

                const workspaceService = new WorkspaceService(config.workspaceBaseDir);
                const channelManager = new ChannelManager();
                const chatSessionService = new ChatSessionService();
                const titleGenerator = new TitleGeneratorService();
                const templateRepo = new TemplateRepository(db);
                const workspaceBindingRepo = new WorkspaceBindingRepository(db);
                const chatSessionRepo = new ChatSessionRepository(db);
                const scheduleRepo = new ScheduleRepository(db);
                const scheduleService = new ScheduleService(scheduleRepo);
                const bridge = initCdpBridge(config.autoApproveFileEdits);
                const promptDispatcher = new PromptDispatcher({
                    bridge,
                    modeService,
                    modelService,
                    sendPromptImpl,
                });

                return {
                    db,
                    modeService,
                    modelService,
                    workspaceService,
                    channelManager,
                    chatSessionService,
                    scheduleService,
                    promptDispatcher,
                    titleGenerator,
                    templateRepo,
                    workspaceBindingRepo,
                    chatSessionRepo,
                    scheduleRepo,
                    userPrefRepo,
                    bridge,
                } satisfies ApplicationContext;
            }),
        ),
        Layer.mergeAll(
            Layer.succeed(AppConfigTag, options.config),
            Layer.succeed(SendPromptImplTag, options.sendPromptImpl),
        ),
    );
}

export async function buildApplicationContext(
    options: ApplicationContextBuilderOptions,
): Promise<ApplicationContext> {
    return Effect.runPromise(
        Effect.gen(function* () {
            return yield* ApplicationContextTag;
        }).pipe(
            Effect.provide(makeApplicationLayer(options)),
        ),
    );
}
