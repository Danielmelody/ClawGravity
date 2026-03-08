import { GrpcCascadeClient } from '../../src/services/grpcCascadeClient';

describe('GrpcCascadeClient stream event parsing', () => {
    function parse(raw: any) {
        const client = new GrpcCascadeClient();
        return (client as any).parseStreamEvent(raw);
    }

    it('extracts assistant response text from stream payloads', () => {
        expect(parse({
            result: {
                assistantResponse: {
                    text: 'Hello from assistant',
                },
            },
        })).toEqual(expect.objectContaining({
            type: 'text',
            text: 'Hello from assistant',
        }));
    });

    it('extracts planner response text from nested step payloads', () => {
        expect(parse({
            result: {
                step: {
                    plannerResponse: {
                        response: 'Plan ready',
                    },
                },
            },
        })).toEqual(expect.objectContaining({
            type: 'text',
            text: 'Plan ready',
        }));
    });

    it('recognizes nested tool calls and cascade status updates', () => {
        expect(parse({
            result: {
                step: {
                    toolCall: {
                        name: 'bash',
                    },
                },
            },
        })).toEqual(expect.objectContaining({ type: 'tool_call' }));

        expect(parse({
            result: {
                cascadeRunStatus: 'CASCADE_RUN_STATUS_IDLE',
            },
        })).toEqual(expect.objectContaining({
            type: 'status',
            text: 'CASCADE_RUN_STATUS_IDLE',
        }));
    });
});

describe('GrpcCascadeClient createCascade', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('returns null when the initial message send fails for a new cascade', async () => {
        const client = new GrpcCascadeClient();
        jest.spyOn(client as any, 'rpc').mockResolvedValue({ cascadeId: 'cascade-123' });
        jest.spyOn(client, 'sendMessage').mockResolvedValue({
            ok: false,
            error: 'missing model',
        });

        await expect(client.createCascade('hello', 1154)).resolves.toBeNull();
        expect(client.sendMessage).toHaveBeenCalledWith('cascade-123', 'hello', 1154);
    });
});
