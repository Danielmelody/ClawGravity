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
                    strategy: 'window.__antigravity.renderTrajectory',
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

    it('bootstraps renderer helpers through Debugger when the context lacks global helper bindings', async () => {
        const cdp = createMockCdpService();
        cdp.getPrimaryContextId.mockReturnValue(1);
        cdp.getContexts.mockReturnValue([
            { id: 1, name: '', url: 'vscode-file://workbench', auxData: { isDefault: true } },
        ]);
        cdp.callWithRetry
            .mockResolvedValueOnce({
                result: {
                    value: {
                        ok: false,
                        error: 'The Antigravity panel helpers are not available in this execution context',
                    },
                },
            })
            .mockResolvedValueOnce({
                result: {
                    value: {
                        ok: true,
                        content: '<blockquote>Bootstrapped timeline</blockquote>',
                        format: 'html',
                        strategy: 'workbench-panel-detached-render',
                    },
                },
            });

        let helpersAvailable = false;
        cdp.call.mockImplementation(async (method: string, params: any) => {
            switch (method) {
                case 'Debugger.enable':
                    return {};
                case 'Runtime.evaluate':
                    if (params?.expression?.includes('window.__agRendererHelpers')) {
                        return { result: { value: helpersAvailable } };
                    }
                    if (params?.expression?.includes('return found?.type || null')) {
                        return { result: { objectId: 'renderer-function-1' } };
                    }
                    if (params?.expression?.includes('return found ? found.type(found.props) : null')) {
                        setImmediate(() => {
                            cdp.emit('Debugger.paused', {
                                callFrames: [{ callFrameId: 'frame-1' }],
                            });
                        });
                        return { result: { value: null } };
                    }
                    return { result: { value: true } };
                case 'Debugger.setBreakpointOnFunctionCall':
                    return { breakpointId: 'bp-1' };
                case 'Debugger.evaluateOnCallFrame':
                    helpersAvailable = true;
                    return { result: { value: true } };
                case 'Debugger.resume':
                case 'Debugger.removeBreakpoint':
                case 'Debugger.disable':
                    return {};
                default:
                    throw new Error(`Unexpected CDP method: ${method}`);
            }
        });

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
        expect(cdp.call).toHaveBeenCalledWith('Debugger.enable', {});
        expect(cdp.call).toHaveBeenCalledWith('Debugger.setBreakpointOnFunctionCall', {
            objectId: 'renderer-function-1',
        });
        expect(cdp.call).toHaveBeenCalledWith('Debugger.evaluateOnCallFrame', expect.objectContaining({
            callFrameId: 'frame-1',
        }));
        expect(cdp.callWithRetry).toHaveBeenCalledTimes(2);
    });
});
