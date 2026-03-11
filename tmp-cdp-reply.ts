import { QuotaService } from './src/services/quotaService'

async function main() {
    const quota = new QuotaService();
    const info = await quota.fetchQuota();
    console.log(JSON.stringify(info, null, 2));
}

main().catch(console.error);
