import { logger } from '../utils/logger';

export interface QuotaInfo {
    remainingFraction: number;
    resetTime: string;
}

export interface ModelQuota {
    label: string;
    model: string;
    quotaInfo?: QuotaInfo;
}

export interface UserStatusData {
    clientModelConfigs?: ModelQuota[];
}

/**
 * A callback that performs a gRPC-over-CDP RPC call.
 * Signature matches `GrpcCascadeClient.rawRPC`.
 */
export type RawRPCCallback = (method: string, payload: Record<string, unknown>) => Promise<unknown>;

export class QuotaService {
    private getRawRPC: (() => Promise<RawRPCCallback | null>) | null = null;

    /**
     * Set a lazy resolver for the RPC transport.
     * Called with a function that (at call time) returns a rawRPC callback
     * from the currently active gRPC client, or null if unavailable.
     */
    setRPCResolver(resolver: () => Promise<RawRPCCallback | null>): void {
        this.getRawRPC = resolver;
    }

    private parseUserStatus(data: unknown): ModelQuota[] {
        const dataRecord = data as Record<string, unknown> | null | undefined;
        const userStatus = dataRecord?.userStatus as Record<string, unknown> | undefined;
        const cascadeData = userStatus?.cascadeModelConfigData as Record<string, unknown> | undefined;
        const rawConfigs = (cascadeData?.clientModelConfigs || []) as unknown[];
        return rawConfigs.map((c: unknown) => {
            const cRecord = c as Record<string, unknown> | null | undefined;
            const label = String(cRecord?.label || cRecord?.displayName || cRecord?.modelName || cRecord?.model || '');
            const model = String(cRecord?.model || cRecord?.modelId || '');
            const qi = (cRecord?.quotaInfo || cRecord?.quota || cRecord?.usageInfo) as Record<string, unknown> | undefined;
            const quotaInfo = qi ? {
                remainingFraction: Number(qi.remainingFraction ?? qi.remaining ?? 1),
                resetTime: String(qi.resetTime || qi.resetAt || ''),
            } : undefined;
            return { label, model, quotaInfo };
        });
    }

    public async fetchQuota(): Promise<ModelQuota[]> {
        if (!this.getRawRPC) {
            logger.warn('[QuotaService] No RPC resolver configured');
            return [];
        }

        const rawRPC = await this.getRawRPC();
        if (!rawRPC) {
            logger.warn('[QuotaService] No RPC transport available — cannot fetch quota');
            return [];
        }

        try {
            const data = await rawRPC('GetUserStatus', {
                metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
            });
            return this.parseUserStatus(data);
        } catch (e) {
            logger.error('[QuotaService] Failed to fetch quota:', e);
            return [];
        }
    }
}
