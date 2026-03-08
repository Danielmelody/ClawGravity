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
