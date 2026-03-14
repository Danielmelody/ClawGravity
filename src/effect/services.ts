/**
 * Effect Service Tags & Layers for ClawGravity.
 *
 * Each service is declared as a Context.Tag so it can be provided
 * via Layer composition, replacing the manual ApplicationContext.
 */

import { Context } from 'effect';
import type Database from 'better-sqlite3';

import type { ModeService } from '../services/modeService';
import type { ModelService } from '../services/modelService';
import type { WorkspaceService } from '../services/workspaceService';
import type { ChannelManager } from '../services/channelManager';
import type { ChatSessionService } from '../services/chatSessionService';
import type { ScheduleService } from '../services/scheduleService';
import type { PromptDispatcher } from '../services/promptDispatcher';
import type { TitleGeneratorService } from '../services/titleGeneratorService';
import type { CdpBridge } from '../services/cdpBridgeManager';

import type { TemplateRepository } from '../database/templateRepository';
import type { WorkspaceBindingRepository } from '../database/workspaceBindingRepository';
import type { ChatSessionRepository } from '../database/chatSessionRepository';
import type { ScheduleRepository } from '../database/scheduleRepository';
import type { UserPreferenceRepository } from '../database/userPreferenceRepository';

// ─── Database ───────────────────────────────────────────────────────────

/** SQLite database instance. */
export class Db extends Context.Tag('Db')<Db, Database.Database>() {}

// ─── Services ───────────────────────────────────────────────────────────

export class ModeServiceTag extends Context.Tag('ModeService')<ModeServiceTag, ModeService>() {}
export class ModelServiceTag extends Context.Tag('ModelService')<ModelServiceTag, ModelService>() {}
export class WorkspaceServiceTag extends Context.Tag('WorkspaceService')<WorkspaceServiceTag, WorkspaceService>() {}
export class ChannelManagerTag extends Context.Tag('ChannelManager')<ChannelManagerTag, ChannelManager>() {}
export class ChatSessionServiceTag extends Context.Tag('ChatSessionService')<ChatSessionServiceTag, ChatSessionService>() {}
export class ScheduleServiceTag extends Context.Tag('ScheduleService')<ScheduleServiceTag, ScheduleService>() {}
export class PromptDispatcherTag extends Context.Tag('PromptDispatcher')<PromptDispatcherTag, PromptDispatcher>() {}
export class TitleGeneratorTag extends Context.Tag('TitleGenerator')<TitleGeneratorTag, TitleGeneratorService>() {}

// ─── CDP Integration ────────────────────────────────────────────────────

export class CdpBridgeTag extends Context.Tag('CdpBridge')<CdpBridgeTag, CdpBridge>() {}

// ─── Repositories ───────────────────────────────────────────────────────

export class TemplateRepoTag extends Context.Tag('TemplateRepo')<TemplateRepoTag, TemplateRepository>() {}
export class WorkspaceBindingRepoTag extends Context.Tag('WorkspaceBindingRepo')<WorkspaceBindingRepoTag, WorkspaceBindingRepository>() {}
export class ChatSessionRepoTag extends Context.Tag('ChatSessionRepo')<ChatSessionRepoTag, ChatSessionRepository>() {}
export class ScheduleRepoTag extends Context.Tag('ScheduleRepo')<ScheduleRepoTag, ScheduleRepository>() {}
export class UserPrefRepoTag extends Context.Tag('UserPrefRepo')<UserPrefRepoTag, UserPreferenceRepository>() {}
