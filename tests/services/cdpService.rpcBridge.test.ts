import { CdpService } from '../../src/services/cdpService';

describe('CdpService LS RPC bridge', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('wires GrpcCascadeClient to the full CDP Runtime.evaluate result, not just result.value', async () => {
        const service = new CdpService({ maxReconnectAttempts: 0 });

        (service as any).currentWorkspacePath = 'C:\\Users\\Daniel\\Projects\\antigravity-tunnel';
        (service as any).lsClientManager = {
            getClient: jest.fn().mockImplementation(async (_workspacePath: string, evaluateValue: (expression: string) => Promise<any>) => {
                const { GrpcCascadeClient } = await import('../../src/services/grpcCascadeClient');
                const client = new GrpcCascadeClient();
                client.setConnection({
                    port: 443,
                    csrfToken: 'csrf-token',
                    useTls: true,
                });

                // Simulate the discovery path still expecting plain values.
                await expect(evaluateValue('2 + 2')).resolves.toBe(4);

                return client;
            }),
            lastLSUnavailableReason: null,
        };

        jest.spyOn(service, 'call').mockImplementation(async (method: string, params: any) => {
            expect(method).toBe('Runtime.evaluate');

            if (params.expression === '2 + 2') {
                return { result: { value: 4 } } as any;
            }

            return {
                result: {
                    value: {
                        ok: true,
                        echoedExpression: params.expression,
                    },
                },
            } as any;
        });

        const client = await service.getLSClient();
        expect(client).not.toBeNull();

        const result = await client!.rawRPC('GetUserStatus', {});
        expect(result).toEqual({
            ok: true,
            echoedExpression: expect.stringContaining('LanguageServerService/GetUserStatus'),
        });
    });
});
