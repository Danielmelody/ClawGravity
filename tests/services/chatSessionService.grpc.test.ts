import { ChatSessionService } from '../../src/services/chatSessionService';

describe('ChatSessionService gRPC session management', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('updates the cached cascade id when starting a new chat', async () => {
        const service = new ChatSessionService();
        const mockCdp = {
            getGrpcClient: jest.fn().mockResolvedValue({
                createCascade: jest.fn().mockResolvedValue('cascade-new'),
            }),
            setCachedCascadeId: jest.fn(),
        } as any;

        await expect(service.startNewChat(mockCdp)).resolves.toEqual({ ok: true });
        expect(mockCdp.setCachedCascadeId).toHaveBeenCalledWith('cascade-new');
    });
});
