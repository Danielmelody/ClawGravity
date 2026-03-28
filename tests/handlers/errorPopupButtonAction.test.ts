import { createErrorPopupButtonAction } from '../../src/handlers/errorPopupButtonAction';
import type { PlatformButtonInteraction, PlatformChannel, PlatformUser, PlatformSentMessage } from '../../src/platform/types';
import type { CdpBridge } from '../../src/services/cdpBridgeManager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(overrides: Partial<PlatformChannel> = {}): PlatformChannel {
    return {
        id: 'ch-1',
        platform: 'telegram',
        name: 'test-channel',
        send: jest.fn(),
        ...overrides,
    };
}

function makeUser(overrides: Partial<PlatformUser> = {}): PlatformUser {
    return {
        id: 'user-1',
        platform: 'telegram',
        username: 'testuser',
        isBot: false,
        ...overrides,
    };
}

function makeInteraction(overrides: Partial<PlatformButtonInteraction> = {}): PlatformButtonInteraction {
    return {
        id: 'int-1',
        platform: 'telegram',
        customId: '',
        user: makeUser(),
        channel: makeChannel(),
        messageId: 'msg-1',
        deferUpdate: jest.fn().mockResolvedValue(undefined),
        reply: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
        editReply: jest.fn().mockResolvedValue(undefined),
        followUp: jest.fn().mockResolvedValue({
            id: 'sent-1', platform: 'telegram', channelId: 'ch-1',
            edit: jest.fn(), delete: jest.fn(),
        } as PlatformSentMessage),
        ...overrides,
    };
}

function makeBridge(overrides: Partial<CdpBridge> = {}): CdpBridge {
    return {
        pool: {
            getErrorPopupDetector: jest.fn(),
            getApprovalDetector: jest.fn(),
            getPlanningDetector: jest.fn(),
            getRuntime: jest.fn(),
        } as any,
        quota: {} as any,
        autoAccept: {} as any,
        lastActiveWorkspace: null,
        lastActiveChannel: null,
        approvalChannelByWorkspace: new Map(),
        approvalChannelBySession: new Map(),
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createErrorPopupButtonAction', () => {
    describe('match', () => {
        it('matches error_popup_continue_action customId', () => {
            const bridge = makeBridge();
            const action = createErrorPopupButtonAction({ bridge });
            const result = action.match('error_popup_continue_action:proj:ch-1');
            expect(result).toEqual({
                action: 'continue',
                projectName: 'proj',
                channelId: 'ch-1',
            });
        });

        it('returns null for unrelated customId', () => {
            const bridge = makeBridge();
            const action = createErrorPopupButtonAction({ bridge });
            expect(action.match('approve_action:proj')).toBeNull();
            expect(action.match('random')).toBeNull();
        });
    });

    describe('execute - continue', () => {
        it('clicks continue and updates message', async () => {
            const mockRuntime = { sendPrompt: jest.fn().mockResolvedValue({ ok: true }) };
            const mockDetector = { };
            const bridge = makeBridge();
            (bridge.pool.getErrorPopupDetector as jest.Mock).mockReturnValue(mockDetector);
            (bridge.pool.getRuntime as jest.Mock).mockReturnValue(mockRuntime);

            const action = createErrorPopupButtonAction({ bridge });
            const interaction = makeInteraction({ customId: 'error_popup_continue_action:proj' });

            await action.execute(interaction, {
                action: 'continue',
                projectName: 'proj',
                channelId: '',
            });

            expect(interaction.deferUpdate).toHaveBeenCalled();
            expect(mockRuntime.sendPrompt).toHaveBeenCalledWith({ text: 'continue' });
            expect(interaction.update).toHaveBeenCalledWith({
                text: '▶️ Continuing...',
                components: [],
            });
        });

        it('replies with error if workspace not found', async () => {
            const mockDetector = { };
            const bridge = makeBridge();
            (bridge.pool.getErrorPopupDetector as jest.Mock).mockReturnValue(mockDetector);
            (bridge.pool.getRuntime as jest.Mock).mockReturnValue(undefined);

            const action = createErrorPopupButtonAction({ bridge });
            const interaction = makeInteraction({ customId: 'error_popup_continue_action:proj' });

            await action.execute(interaction, {
                action: 'continue',
                projectName: 'proj',
                channelId: '',
            });

            expect(interaction.reply).toHaveBeenCalledWith({
                text: 'Workspace not connected.',
            });
        });

        it('replies with error if prompt fails', async () => {
            const mockRuntime = { sendPrompt: jest.fn().mockResolvedValue({ ok: false, error: 'some error' }) };
            const mockDetector = { };
            const bridge = makeBridge();
            (bridge.pool.getErrorPopupDetector as jest.Mock).mockReturnValue(mockDetector);
            (bridge.pool.getRuntime as jest.Mock).mockReturnValue(mockRuntime);

            const action = createErrorPopupButtonAction({ bridge });
            const interaction = makeInteraction({ customId: 'error_popup_continue_action:proj' });

            await action.execute(interaction, {
                action: 'continue',
                projectName: 'proj',
                channelId: '',
            });

            expect(interaction.reply).toHaveBeenCalledWith({
                text: 'Failed to continue: some error',
            });
        });
        
        it('handles exceptions during prompt gracefully', async () => {
            const mockRuntime = { sendPrompt: jest.fn().mockRejectedValue(new Error('crash')) };
            const mockDetector = { };
            const bridge = makeBridge();
            (bridge.pool.getErrorPopupDetector as jest.Mock).mockReturnValue(mockDetector);
            (bridge.pool.getRuntime as jest.Mock).mockReturnValue(mockRuntime);

            const action = createErrorPopupButtonAction({ bridge });
            const interaction = makeInteraction({ customId: 'error_popup_continue_action:proj' });

            await action.execute(interaction, {
                action: 'continue',
                projectName: 'proj',
                channelId: '',
            });

            expect(interaction.reply).toHaveBeenCalledWith({
                text: 'Continue failed.',
            });
        });
    });

    describe('execute - shared', () => {
        it('replies with error when detector not found', async () => {
            const bridge = makeBridge();
            (bridge.pool.getErrorPopupDetector as jest.Mock).mockReturnValue(undefined);

            const action = createErrorPopupButtonAction({ bridge });
            const interaction = makeInteraction();

            await action.execute(interaction, {
                action: 'continue',
                projectName: 'nonexistent',
                channelId: '',
            });

            expect(interaction.reply).toHaveBeenCalledWith({
                text: 'ErrorPopupAction detector not found.',
            });
        });

        it('rejects interaction from wrong channel', async () => {
            const bridge = makeBridge();
            const action = createErrorPopupButtonAction({ bridge });
            const interaction = makeInteraction({
                channel: makeChannel({ id: 'ch-other' }),
            });

            await action.execute(interaction, {
                action: 'continue',
                projectName: 'proj',
                channelId: 'ch-1',
            });

            expect(interaction.reply).toHaveBeenCalledWith({
                text: 'This ErrorPopupAction action is linked to a different session channel.',
            });
        });

        it('falls back to lastActiveWorkspace when projectName is empty', async () => {
            const mockDetector = { };
            const mockRuntime = { sendPrompt: jest.fn().mockResolvedValue({ ok: true }) };
            const bridge = makeBridge({ lastActiveWorkspace: 'fallbackWs' });
            (bridge.pool.getErrorPopupDetector as jest.Mock).mockReturnValue(mockDetector);
            (bridge.pool.getRuntime as jest.Mock).mockReturnValue(mockRuntime);

            const action = createErrorPopupButtonAction({ bridge });
            const interaction = makeInteraction({ customId: 'error_popup_continue_action:fallbackWs' });

            await action.execute(interaction, {
                action: 'continue',
                projectName: '',
                channelId: '',
            });

            expect(bridge.pool.getErrorPopupDetector).toHaveBeenCalledWith('fallbackWs');
        });
    });
});
