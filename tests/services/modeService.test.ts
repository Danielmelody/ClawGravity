import { ModeService, AVAILABLE_MODES, DEFAULT_MODE } from '../../src/services/modeService';

describe('ModeService', () => {
    let modeService: ModeService;

    beforeEach(() => {
        modeService = new ModeService();
    });

    describe('getCurrentMode - get current mode', () => {
        it('returns the default mode ("fast") in the initial state', () => {
            expect(modeService.getCurrentMode()).toBe(DEFAULT_MODE);
        });
    });

    describe('setMode - switch mode', () => {
        it('switches the mode when a valid mode name is specified', () => {
            const result = modeService.setMode('plan');
            expect(result.success).toBe(true);
            expect(result.mode).toBe('plan');
            expect(modeService.getCurrentMode()).toBe('plan');
        });

        it('retains the last set mode after multiple switches', () => {
            modeService.setMode('plan');
            modeService.setMode('fast');
            expect(modeService.getCurrentMode()).toBe('fast');
        });

        it('returns an error and does not change the mode for an invalid mode name', () => {
            const result = modeService.setMode('invalid_mode');
            expect(result.success).toBe(false);
            expect(result.error).toBeDefined();
            expect(modeService.getCurrentMode()).toBe(DEFAULT_MODE);
        });

        it('sets the mode case-insensitively', () => {
            const result = modeService.setMode('FAST');
            expect(result.success).toBe(true);
            expect(result.mode).toBe('fast');
        });

        it('returns an error when an empty string is specified', () => {
            const result = modeService.setMode('');
            expect(result.success).toBe(false);
            expect(result.error).toBeDefined();
        });

        it('marks mode as pending when synced=false (default)', () => {
            modeService.setMode('plan');
            expect(modeService.isPendingSync()).toBe(true);
        });

        it('marks mode as not pending when synced=true', () => {
            modeService.setMode('plan', true);
            expect(modeService.isPendingSync()).toBe(false);
        });
    });

    describe('pendingSync', () => {
        it('isPendingSync returns false initially', () => {
            expect(modeService.isPendingSync()).toBe(false);
        });

        it('isPendingSync returns true after setMode with synced=false', () => {
            modeService.setMode('plan', false);
            expect(modeService.isPendingSync()).toBe(true);
        });

        it('markSynced clears the pending flag', () => {
            modeService.setMode('plan', false);
            expect(modeService.isPendingSync()).toBe(true);
            modeService.markSynced();
            expect(modeService.isPendingSync()).toBe(false);
        });

        it('setMode with synced=true clears previous pending', () => {
            modeService.setMode('plan', false);
            expect(modeService.isPendingSync()).toBe(true);
            modeService.setMode('fast', true);
            expect(modeService.isPendingSync()).toBe(false);
        });

        it('failed setMode does not change pending state', () => {
            modeService.setMode('plan', false);
            expect(modeService.isPendingSync()).toBe(true);
            modeService.setMode('invalid');
            // pendingSync should remain true since setMode failed
            expect(modeService.isPendingSync()).toBe(true);
        });
    });

    describe('getAvailableModes - get available mode list', () => {
        it('returns the list of available modes', () => {
            const modes = modeService.getAvailableModes();
            expect(modes).toEqual(AVAILABLE_MODES);
            expect(modes.length).toBe(2);
        });
    });
});
