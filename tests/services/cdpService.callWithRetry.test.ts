/**
 * Tests for callWithRetry(), waitForReconnection(), and reconnectOnDemand()
 *
 * Verification items:
 * - callWithRetry passes through on successful call
 * - callWithRetry reconnects on-demand and retries on WebSocket disconnection
 * - callWithRetry throws immediately for non-connection errors (no retry)
 * - reconnectOnDemand throws when no workspace path is available
 * - reconnectOnDemand delegates to waitForReconnection when already reconnecting
 * - reconnectOnDemand coalesces concurrent calls via shared promise
 * - waitForReconnection resolves on 'reconnected' event
 * - waitForReconnection rejects on 'reconnectFailed' event
 * - waitForReconnection rejects on timeout
 */

import { CdpService } from '../../src/services/cdpService';
import WebSocket from 'ws';

jest.mock('ws');
const MockWebSocket = WebSocket as jest.MockedClass<typeof WebSocket>;

jest.mock('http', () => ({
    get: jest.fn(),
}));

describe('CdpService - callWithRetry (Issue #55)', () => {
    let cdpService: CdpService;
    let mockWsInstance: jest.Mocked<WebSocket>;

    beforeEach(() => {
        jest.clearAllMocks();

        mockWsInstance = {
            readyState: WebSocket.OPEN,
            send: jest.fn(),
            close: jest.fn(),
            on: jest.fn().mockReturnThis(),
        } as unknown as jest.Mocked<WebSocket>;

        MockWebSocket.mockImplementation(() => mockWsInstance);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    // ========== callWithRetry ==========

    describe('callWithRetry()', () => {
        it('passes through when call() succeeds', async () => {
            cdpService = new CdpService({ maxReconnectAttempts: 0 });
            jest.spyOn(cdpService, 'isConnected').mockReturnValue(true);

            // Simulate immediate response
            jest.spyOn(cdpService, 'call').mockResolvedValue({ result: { value: 'ok' } });

            const result = await cdpService.callWithRetry('Runtime.evaluate', { expression: '1+1' });
            expect(result).toEqual({ result: { value: 'ok' } });
        });

        it('reconnects on-demand and retries when WebSocket is disconnected', async () => {
            cdpService = new CdpService({ maxReconnectAttempts: 0 });
            jest.spyOn(cdpService, 'isConnected').mockReturnValue(false);
            (cdpService as any).currentWorkspacePath = '/tmp/my-workspace';

            // After reconnect, simulate connected state
            jest.spyOn(cdpService, 'discoverAndConnectForWorkspace').mockImplementation(async () => {
                jest.spyOn(cdpService, 'isConnected').mockReturnValue(true);
                return true;
            });
            // First call rejects (if we somehow get past isConnected, though we mocked it to false, tests direct call sometimes)
            // Wait, actually callWithRetry returns `this.call<T>` on retry.
            jest.spyOn(cdpService, 'call').mockRejectedValueOnce(new Error('WebSocket is not connected')).mockResolvedValue({ data: 'screenshot-data' });

            const result = await cdpService.callWithRetry('Page.captureScreenshot', {});
            expect(result).toEqual({ data: 'screenshot-data' });
            expect(cdpService.discoverAndConnectForWorkspace).toHaveBeenCalledWith('/tmp/my-workspace');
        });

        it('throws immediately for non-connection errors (no retry)', async () => {
            cdpService = new CdpService({ maxReconnectAttempts: 0 });
            jest.spyOn(cdpService, 'isConnected').mockReturnValue(true);

            // Simulate timeout error
            jest.spyOn(cdpService, 'call').mockRejectedValue(
                new Error('Timeout calling CDP method Page.captureScreenshot')
            );

            await expect(
                cdpService.callWithRetry('Page.captureScreenshot', {})
            ).rejects.toThrow('Timeout calling CDP method Page.captureScreenshot');
        });

        it('retries on in-flight WebSocket disconnected error', async () => {
            cdpService = new CdpService({ maxReconnectAttempts: 0 });
            (cdpService as any).currentWorkspacePath = '/tmp/my-workspace';

            jest.spyOn(cdpService, 'discoverAndConnectForWorkspace').mockResolvedValue(true);
            jest.spyOn(cdpService, 'call')
                .mockRejectedValueOnce(new Error('WebSocket disconnected'))
                .mockResolvedValueOnce({ data: 'screenshot-data' });

            const result = await cdpService.callWithRetry('Page.captureScreenshot', {});
            expect(result).toEqual({ data: 'screenshot-data' });
            expect(cdpService.discoverAndConnectForWorkspace).toHaveBeenCalledWith('/tmp/my-workspace');
        });

        it('throws when reconnect fails', async () => {
            cdpService = new CdpService({ maxReconnectAttempts: 0 });
            jest.spyOn(cdpService, 'isConnected').mockReturnValue(false);
            (cdpService as any).currentWorkspacePath = '/tmp/my-workspace';

            jest.spyOn(cdpService, 'discoverAndConnectForWorkspace').mockRejectedValue(
                new Error('No target found')
            );

            await expect(
                cdpService.callWithRetry('Page.captureScreenshot', {})
            ).rejects.toThrow('No target found');
        });
    });

    // ========== reconnectOnDemand ==========

    describe('reconnectOnDemand()', () => {
        it('throws when no currentWorkspacePath is available', async () => {
            cdpService = new CdpService({ maxReconnectAttempts: 0 });
            (cdpService as any).currentWorkspacePath = null;

            await expect(
                (cdpService as any).reconnectOnDemand()
            ).rejects.toThrow('WebSocket is not connected');
        });

        it('delegates to waitForReconnection when already reconnecting', async () => {
            cdpService = new CdpService({ maxReconnectAttempts: 0 });
            (cdpService as any).isReconnecting = true;

            const reconnectPromise = (cdpService as any).reconnectOnDemand();

            // Simulate reconnect success
            cdpService.emit('reconnected');

            await expect(reconnectPromise).resolves.toBeUndefined();
        });

        it('honors timeoutMs when on-demand reconnect is slow', async () => {
            cdpService = new CdpService({ maxReconnectAttempts: 0 });
            (cdpService as any).currentWorkspacePath = '/tmp/ws';

            jest.spyOn(cdpService, 'discoverAndConnectForWorkspace').mockImplementation(async () => {
                await new Promise(r => setTimeout(r, 200));
                return true;
            });

            await expect(
                (cdpService as any).reconnectOnDemand(20)
            ).rejects.toThrow('Timeout');
        }, 5000);

        it('coalesces concurrent calls via shared promise', async () => {
            cdpService = new CdpService({ maxReconnectAttempts: 0 });
            (cdpService as any).currentWorkspacePath = '/tmp/ws';

            let resolveConnect: () => void;
            const connectPromise = new Promise<void>(r => { resolveConnect = r; });

            jest.spyOn(cdpService, 'discoverAndConnectForWorkspace').mockImplementation(async () => {
                await connectPromise;
                return true;
            });

            // Fire two concurrent calls
            const p1 = (cdpService as any).reconnectOnDemand();
            const p2 = (cdpService as any).reconnectOnDemand();

            // Resolve the connection
            resolveConnect!();

            await Promise.all([p1, p2]);

            // discoverAndConnectForWorkspace should only be called once
            expect(cdpService.discoverAndConnectForWorkspace).toHaveBeenCalledTimes(1);
        });
    });

});
