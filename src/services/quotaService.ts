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
export type RawRPCCallback = (method: string, payload: any) => Promise<any>;

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

    private parseUserStatus(data: any): ModelQuota[] {
        const cascadeData = data?.userStatus?.cascadeModelConfigData;
        const rawConfigs: any[] = cascadeData?.clientModelConfigs || [];
        return rawConfigs.map((c: any) => {
            const label = c.label || c.displayName || c.modelName || c.model || '';
            const model = c.model || c.modelId || '';
            const qi = c.quotaInfo || c.quota || c.usageInfo;
            const quotaInfo = qi ? {
                remainingFraction: qi.remainingFraction ?? qi.remaining ?? 1,
                resetTime: qi.resetTime || qi.resetAt || '',
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
