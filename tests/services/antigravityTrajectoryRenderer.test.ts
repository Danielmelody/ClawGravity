import { EventEmitter } from 'events';
import { AntigravityTrajectoryRenderer } from '../../src/services/antigravityTrajectoryRenderer';

function createMockCdpService() {
    return Object.assign(new EventEmitter(), {
        getContexts: jest.fn(),
        getPrimaryContextId: jest.fn(),
        callWithRetry: jest.fn(),
        call: jest.fn(),
    });
}

describe('AntigravityTrajectoryRenderer', () => {
    it('prefers the cascade-panel execution context when it succeeds', async () => {
        const cdp = createMockCdpService();
        cdp.getPrimaryContextId.mockReturnValue(1);
        cdp.getContexts.mockReturnValue([
            { id: 1, name: '', url: 'vscode-file://workbench', auxData: { isDefault: true } },
            { id: 7, name: 'cascade-panel', url: 'vscode-webview://cascade-panel', auxData: { isDefault: false } },
        ]);
        cdp.callWithRetry.mockResolvedValue({
            result: {
                value: {
                    ok: true,
                    content: '<blockquote>Rendered trajectory</blockquote>',
                    format: 'html',
                    strategy: 'bundle-detached-render',
                },
            },
        });

        const renderer = new AntigravityTrajectoryRenderer(cdp as any);
        const result = await renderer.renderTrajectory({
            steps: [{ type: 'CORTEX_STEP_TYPE_USER_INPUT' }],
            runStatus: 'CASCADE_RUN_STATUS_RUNNING',
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            content: '<blockquote>Rendered trajectory</blockquote>',
            format: 'html',
            contextId: 7,
        }));
        expect(cdp.callWithRetry).toHaveBeenCalledTimes(1);
        expect(cdp.callWithRetry).toHaveBeenCalledWith(
            'Runtime.evaluate',
            expect.objectContaining({ contextId: 7 }),
            12_000,
        );
    });

    it('falls back to the next context when the first probe returns no renderer', async () => {
        const cdp = createMockCdpService();
        cdp.getPrimaryContextId.mockReturnValue(1);
        cdp.getContexts.mockReturnValue([
            { id: 1, name: '', url: 'vscode-file://workbench', auxData: { isDefault: true } },
            { id: 2, name: 'Electron Isolated Context', url: 'vscode-file://workbench', auxData: { isDefault: false } },
        ]);
        cdp.callWithRetry
            .mockResolvedValueOnce({
                result: {
                    value: {
                        ok: false,
                        error: 'No renderer candidates were discovered',
                    },
                },
            })
            .mockResolvedValueOnce({
                result: {
                    value: {
                        ok: true,
                        content: '<blockquote>Fallback timeline</blockquote>',
                        format: 'html',
                    },
                },
            });

        const renderer = new AntigravityTrajectoryRenderer(cdp as any);
        const result = await renderer.renderTrajectory({
            steps: [{ type: 'CORTEX_STEP_TYPE_RESPONSE' }],
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            content: '<blockquote>Fallback timeline</blockquote>',
            contextId: 2,
        }));
        expect(cdp.callWithRetry).toHaveBeenCalledTimes(2);
    });

    it('bootstraps bundle via compileScript/runScript when globals are missing', async () => {
        const cdp = createMockCdpService();
        cdp.getPrimaryContextId.mockReturnValue(1);
        cdp.getContexts.mockReturnValue([
            { id: 1, name: '', url: 'vscode-file://workbench', auxData: { isDefault: true } },
        ]);

        // First probe: bundle globals not available
        cdp.callWithRetry
            .mockResolvedValueOnce({
                result: {
                    value: {
                        ok: false,
                        error: 'Bundle globals are not available in this execution context',
                    },
                },
            })
            // Second probe after bootstrap: success
            .mockResolvedValueOnce({
                result: {
                    value: {
                        ok: true,
                        content: '<blockquote>Bootstrapped timeline</blockquote>',
                        format: 'html',
                        strategy: 'bundle-detached-render',
                    },
                },
            });

        let globalsAvailable = false;
        cdp.call.mockImplementation(async (method: string, _params: any) => {
            switch (method) {
                case 'Runtime.compileScript':
                    return { scriptId: 'bundle-script-1' };
                case 'Runtime.runScript':
                    globalsAvailable = true;
                    return { result: { value: undefined } };
                case 'Runtime.evaluate':
                    // checkBundleGlobals
                    return { result: { value: globalsAvailable } };
                default:
                    throw new Error(`Unexpected CDP method: ${method}`);
            }
        });

        // Mock fs.readFileSync to return fake bundle source
        jest.spyOn(require('fs'), 'readFileSync').mockReturnValue('// fake chat.js bundle');

        const renderer = new AntigravityTrajectoryRenderer(cdp as any);
        const result = await renderer.renderTrajectory({
            steps: [{ type: 'CORTEX_STEP_TYPE_RESPONSE' }],
            trajectory: { steps: [{ type: 'CORTEX_STEP_TYPE_RESPONSE' }] },
            runStatus: 'CASCADE_RUN_STATUS_RUNNING',
            format: 'html',
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            content: '<blockquote>Bootstrapped timeline</blockquote>',
            contextId: 1,
        }));
        expect(cdp.call).toHaveBeenCalledWith('Runtime.compileScript', expect.objectContaining({
            persistScript: true,
            executionContextId: 1,
        }));
        expect(cdp.call).toHaveBeenCalledWith('Runtime.runScript', expect.objectContaining({
            scriptId: 'bundle-script-1',
            executionContextId: 1,
        }));
        expect(cdp.callWithRetry).toHaveBeenCalledTimes(2);

        jest.restoreAllMocks();
    });

    it('builds the detached render expression using input.trajectory', async () => {
        const cdp = createMockCdpService();
        cdp.getPrimaryContextId.mockReturnValue(1);
        cdp.getContexts.mockReturnValue([
            { id: 1, name: 'cascade-panel', url: 'vscode-webview://cascade-panel', auxData: { isDefault: true } },
        ]);
        cdp.callWithRetry.mockResolvedValue({
            result: {
                value: {
                    ok: true,
                    content: '<blockquote>Rendered trajectory</blockquote>',
                    format: 'html',
                },
            },
        });

        const renderer = new AntigravityTrajectoryRenderer(cdp as any);
        await renderer.renderTrajectory({
            steps: [{ type: 'CORTEX_STEP_TYPE_RESPONSE' }],
            trajectory: {
                cascadeId: 'cascade-background',
                trajectoryId: 'trajectory-background',
                steps: [{ type: 'CORTEX_STEP_TYPE_RESPONSE' }],
            },
            format: 'html',
        });

        const evaluateParams = cdp.callWithRetry.mock.calls[0][1];
        expect(evaluateParams.expression).toContain('input.trajectory');
        expect(evaluateParams.expression).not.toContain('rendererNode');
        expect(evaluateParams.expression).not.toContain('__agRendererHelpers');
        expect(evaluateParams.expression).not.toContain('aBe');
    });

    it('caches the compiled scriptId and reuses it for subsequent renders', async () => {
        const cdp = createMockCdpService();
        cdp.getPrimaryContextId.mockReturnValue(1);
        cdp.getContexts.mockReturnValue([
            { id: 1, name: '', url: 'vscode-file://workbench', auxData: { isDefault: true } },
        ]);

        // Both renders will need bootstrap on first, then succeed
        cdp.callWithRetry
            // First render: probe fails, bootstrap, probe succeeds
            .mockResolvedValueOnce({
                result: { value: { ok: false, error: 'Bundle globals are not available in this execution context' } },
            })
            .mockResolvedValueOnce({
                result: { value: { ok: true, content: '<div>First</div>', format: 'html', strategy: 'bundle-detached-render' } },
            })
            // Second render: fast-path probe fails (context lost), needs re-bootstrap
            .mockResolvedValueOnce({
                result: { value: { ok: false, error: 'uCe is not defined' } },
            })
            .mockResolvedValueOnce({
                result: { value: { ok: true, content: '<div>Second</div>', format: 'html', strategy: 'bundle-detached-render' } },
            });

        let callCount = 0;
        cdp.call.mockImplementation(async (method: string) => {
            switch (method) {
                case 'Runtime.compileScript':
                    callCount++;
                    return { scriptId: 'bundle-script-1' };
                case 'Runtime.runScript':
                    return { result: { value: undefined } };
                case 'Runtime.evaluate':
                    return { result: { value: true } };
                default:
                    throw new Error(`Unexpected CDP method: ${method}`);
            }
        });

        jest.spyOn(require('fs'), 'readFileSync').mockReturnValue('// fake bundle');

        const renderer = new AntigravityTrajectoryRenderer(cdp as any);

        // First render triggers compile + run
        await renderer.renderTrajectory({ steps: [{}], format: 'html' });
        expect(callCount).toBe(1); // compileScript called once

        // Second render reuses cached scriptId — only runScript, no compileScript
        await renderer.renderTrajectory({ steps: [{}], format: 'html' });
        expect(callCount).toBe(1); // compileScript NOT called again

        jest.restoreAllMocks();
    });
});
