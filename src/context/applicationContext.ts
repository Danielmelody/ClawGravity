import { Context } from 'effect';
import Database from 'better-sqlite3';

import { ModeService } from '../services/modeService';
import { ModelService } from '../services/modelService';
import { WorkspaceService } from '../services/workspaceService';
import { ChannelManager } from '../services/channelManager';
import { ChatSessionService } from '../services/chatSessionService';
import { ScheduleService } from '../services/scheduleService';
import { PromptDispatcher } from '../services/promptDispatcher';
import { TitleGeneratorService } from '../services/titleGeneratorService';
import { CdpBridge } from '../services/cdpBridgeManager';

import { TemplateRepository } from '../database/templateRepository';
import { WorkspaceBindingRepository } from '../database/workspaceBindingRepository';
import { ChatSessionRepository } from '../database/chatSessionRepository';
import { ScheduleRepository } from '../database/scheduleRepository';
import { UserPreferenceRepository } from '../database/userPreferenceRepository';

export interface ApplicationContext {
    db: Database.Database;

    // Services
    modeService: ModeService;
    modelService: ModelService;
    workspaceService: WorkspaceService;
    channelManager: ChannelManager;
    chatSessionService: ChatSessionService;
    scheduleService: ScheduleService;
    promptDispatcher: PromptDispatcher;
    titleGenerator: TitleGeneratorService;

    // Repositories
    templateRepo: TemplateRepository;
    workspaceBindingRepo: WorkspaceBindingRepository;
    chatSessionRepo: ChatSessionRepository;
    scheduleRepo: ScheduleRepository;
    userPrefRepo: UserPreferenceRepository;

    // CDP integration
    bridge: CdpBridge;
}

export const ApplicationContextTag = Context.GenericTag<ApplicationContext>(
    'claw-gravity/ApplicationContext',
);

let globalContext: ApplicationContext | null = null;

export function setApplicationContext(context: ApplicationContext): void {
    globalContext = context;
}

export function getApplicationContext(): ApplicationContext {
    if (!globalContext) {
        throw new Error('Application context is not initialized');
    }
    return globalContext;
}

export function clearApplicationContext(): void {
    globalContext = null;
}
