import { Effect } from 'effect';

import { ChatCommandHandler } from '../commands/chatCommandHandler';
import { CleanupCommandHandler } from '../commands/cleanupCommandHandler';
import { SlashCommandHandler } from '../commands/slashCommandHandler';
import { WorkspaceCommandHandler } from '../commands/workspaceCommandHandler';

import {
    ApplicationContext,
    ApplicationContextTag,
} from './applicationContext';

export interface ApplicationCommandHandlers {
    readonly workspace: WorkspaceCommandHandler;
    readonly chat: ChatCommandHandler;
    readonly cleanup: CleanupCommandHandler;
    readonly slash: SlashCommandHandler;
}

export async function buildApplicationCommandHandlers(
    context: ApplicationContext,
): Promise<ApplicationCommandHandlers> {
    return Effect.runPromise(
        Effect.gen(function* () {
            const ctx = yield* ApplicationContextTag;

            return {
                workspace: new WorkspaceCommandHandler({
                    workspaceBindingRepo: ctx.workspaceBindingRepo,
                    chatSessionRepo: ctx.chatSessionRepo,
                    workspaceService: ctx.workspaceService,
                    channelManager: ctx.channelManager,
                }),
                chat: new ChatCommandHandler(
                    ctx.chatSessionService,
                    ctx.chatSessionRepo,
                    ctx.workspaceBindingRepo,
                    ctx.channelManager,
                    ctx.workspaceService,
                    ctx.bridge.pool,
                ),
                cleanup: new CleanupCommandHandler(
                    ctx.chatSessionRepo,
                    ctx.workspaceBindingRepo,
                ),
                slash: new SlashCommandHandler(ctx.templateRepo),
            } satisfies ApplicationCommandHandlers;
        }).pipe(
            Effect.provideService(ApplicationContextTag, context),
        ),
    );
}
