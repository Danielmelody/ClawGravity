import { createAutoAcceptButtonAction } from '../../src/handlers/autoAcceptButtonAction';

jest.mock('../../src/utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/ui/autoAcceptUi', () => ({
    buildAutoAcceptPayload: jest.fn().mockReturnValue({ richContent: { title: 'AutoAccept' }, components: [] }),
    AUTOACCEPT_BTN_ON: 'autoaccept_btn_on',
    AUTOACCEPT_BTN_OFF: 'autoaccept_btn_off',
    AUTOACCEPT_BTN_REFRESH: 'autoaccept_btn_refresh',
}));

function createMockInteraction(customId: string) {
    return {
        id: 'int-1',
        platform: 'telegram' as const,
        customId,
        user: { id: 'user-1', platform: 'telegram' as const, username: 'test', isBot: false },
        channel: { id: 'ch-1', platform: 'telegram' as const, send: jest.fn() },
        messageId: 'msg-1',
        deferUpdate: jest.fn().mockResolvedValue(undefined),
        reply: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
        editReply: jest.fn().mockResolvedValue(undefined),
        followUp: jest.fn().mockResolvedValue({ id: '2', platform: 'telegram', channelId: 'ch-1', edit: jest.fn(), delete: jest.fn() }),
    };
}

describe('createAutoAcceptButtonAction', () => {
    const autoAcceptService = {
        isEnabled: jest.fn().mockReturnValue(false),
        handle: jest.fn().mockReturnValue({
            success: true,
            enabled: true,
            changed: true,
            message: 'Auto-accept mode turned ON.',
        }),
    } as any;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('matches autoaccept_btn_on', () => {
        const action = createAutoAcceptButtonAction({ autoAcceptService });
        expect(action.match('autoaccept_btn_on')).toEqual({ action: 'on' });
    });

    it('matches autoaccept_btn_off', () => {
        const action = createAutoAcceptButtonAction({ autoAcceptService });
        expect(action.match('autoaccept_btn_off')).toEqual({ action: 'off' });
    });

    it('matches autoaccept_btn_refresh', () => {
        const action = createAutoAcceptButtonAction({ autoAcceptService });
        expect(action.match('autoaccept_btn_refresh')).toEqual({ action: 'refresh' });
    });

    it('does not match unrelated customIds', () => {
        const action = createAutoAcceptButtonAction({ autoAcceptService });
        expect(action.match('model_btn_test')).toBeNull();
    });

    it('enables auto-accept and refreshes UI when state changed', async () => {
        autoAcceptService.handle.mockReturnValue({
            success: true, enabled: true, changed: true,
            message: 'Auto-accept mode turned ON.',
        });
        const action = createAutoAcceptButtonAction({ autoAcceptService });
        const interaction = createMockInteraction('autoaccept_btn_on');

        await action.execute(interaction as any, { action: 'on' });

        expect(autoAcceptService.handle).toHaveBeenCalledWith('on');
        expect(interaction.deferUpdate).toHaveBeenCalled();
        expect(interaction.update).toHaveBeenCalled();
        expect(interaction.followUp).toHaveBeenCalled();
    });

    it('skips UI update when toggling to same state', async () => {
        autoAcceptService.handle.mockReturnValue({
            success: true, enabled: false, changed: false,
            message: 'Auto-accept mode is already OFF.',
        });
        const action = createAutoAcceptButtonAction({ autoAcceptService });
        const interaction = createMockInteraction('autoaccept_btn_off');

        await action.execute(interaction as any, { action: 'off' });

        expect(autoAcceptService.handle).toHaveBeenCalledWith('off');
        expect(interaction.update).not.toHaveBeenCalled();
        expect(interaction.followUp).toHaveBeenCalledWith(
            expect.objectContaining({
                text: expect.stringContaining('already OFF'),
            }),
        );
    });

    it('refreshes UI without toggling on refresh action', async () => {
        const action = createAutoAcceptButtonAction({ autoAcceptService });
        const interaction = createMockInteraction('autoaccept_btn_refresh');

        await action.execute(interaction as any, { action: 'refresh' });

        expect(autoAcceptService.handle).not.toHaveBeenCalled();
        expect(interaction.update).toHaveBeenCalled();
    });
});
