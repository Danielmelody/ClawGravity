/**
 * Step 9: Model/mode switching UI sync tests
 *
 * Verification items:
 * - Does setUiMode() update the cached mode without CDP calls?
 * - Does setUiModel() resolve models from cachedModelConfigs?
 * - Does it reject unknown modes/models gracefully?
 * - getPrimaryContextId prefers the default context for the target frame
 */

import WebSocket from 'ws';
import { CdpService } from '../../src/services/cdpService';

// Mock WebSocket
jest.mock('ws');
const MockWebSocket = WebSocket as jest.MockedClass<typeof WebSocket>;

// Mock http module (used by discoverTarget)
jest.mock('http', () => ({
    get: jest.fn(),
}));

describe('CdpService - UI sync (Step 9)', () => {
    let cdpService: CdpService;
    let mockWsInstance: jest.Mocked<WebSocket>;

    beforeEach(() => {
        jest.clearAllMocks();

        // Mock WebSocket instance setup
        mockWsInstance = {
            readyState: WebSocket.OPEN,
            send: jest.fn(),
            on: jest.fn(),
            close: jest.fn(),
        } as unknown as jest.Mocked<WebSocket>;

        MockWebSocket.mockImplementation(() => mockWsInstance);

        cdpService = new CdpService({ cdpCallTimeout: 1000 });
    });

    afterEach(async () => {
        jest.restoreAllMocks();
    });

    // ========== setUiMode tests ==========

    describe('setUiMode - cached mode switching', () => {

        it('succeeds even when not connected (mode is cached locally)', async () => {
            // setUiMode no longer requires a connection — it just caches the mode
            const result = await cdpService.setUiMode('plan');
            expect(result.ok).toBe(true);
            expect(result.mode).toBe('plan');
        });

        it('accepts "fast" mode', async () => {
            const result = await cdpService.setUiMode('fast');
            expect(result.ok).toBe(true);
            expect(result.mode).toBe('fast');
        });

        it('accepts "plan" mode', async () => {
            const result = await cdpService.setUiMode('plan');
            expect(result.ok).toBe(true);
            expect(result.mode).toBe('plan');
        });

        it('normalizes mode name to lowercase', async () => {
            const result = await cdpService.setUiMode('Plan');
            expect(result.ok).toBe(true);
            expect(result.mode).toBe('plan');
        });

        it('returns ok: false for unknown mode names', async () => {
            const result = await cdpService.setUiMode('unknown_mode');
            expect(result.ok).toBe(false);
            expect(result.error).toContain('unknown_mode');
        });

        it('does not make any CDP calls', async () => {
            const callSpy = jest.spyOn(cdpService, 'call');
            await cdpService.setUiMode('plan');
            expect(callSpy).not.toHaveBeenCalled();
        });
    });

    // ========== setUiModel tests ==========

    describe('setUiModel - UI model dropdown operation', () => {

        it('returns ok: false when model is not found', async () => {
            (cdpService as any).cachedModelConfigs = [
                { label: 'Claude 3 Opus', model: 'claude-3-opus' }
            ];

            const result = await cdpService.setUiModel('gpt-4o');

            expect(result.ok).toBe(false);
            expect(result.error).toContain('gpt-4o');
        });

        it('returns the model name on successful operation', async () => {
            (cdpService as any).cachedModelConfigs = [
                { label: 'Claude 3 Opus', model: 'claude-3-opus' }
            ];

            const result = await cdpService.setUiModel('Claude 3 Opus');

            expect(result.ok).toBe(true);
            expect(result.model).toBe('Claude 3 Opus');
            expect((cdpService as any).cachedModelLabel).toBe('Claude 3 Opus');
        });

        it('prefers the default context for the current target frame when no cascade panel exists', () => {
            (cdpService as any).targetFrameId = 'frame-123';
            (cdpService as any).contexts = [
                {
                    id: 3,
                    name: '',
                    url: 'about:blank',
                    auxData: { frameId: 'frame-999', type: 'default', isDefault: true },
                },
                {
                    id: 2,
                    name: 'Electron Isolated Context',
                    url: 'file:///workbench.html',
                    auxData: { frameId: 'frame-123', type: 'isolated' },
                },
                {
                    id: 1,
                    name: '',
                    url: 'file:///workbench.html',
                    auxData: { frameId: 'frame-123', type: 'default', isDefault: true },
                },
            ];

            expect(cdpService.getPrimaryContextId()).toBe(1);
        });
    });
});
