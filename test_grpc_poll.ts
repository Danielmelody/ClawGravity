import { discoverLSConnection, GrpcCascadeClient } from './src/services/grpcCascadeClient';

async function run() {
    const conn = await discoverLSConnection();
    if (!conn) { console.log('No LS conn'); return; }
    const client = new GrpcCascadeClient();
    client.setConnection(conn);

    // Find the newest cascade
    const resp = await client.rawRPC('GetAllCascadeTrajectories', {});
    let newestId = null;
    let maxTime = 0;

    for (const [id, t] of Object.entries(resp.trajectorySummaries || {})) {
        const timeStr = (t as any).lastUserInputTime;
        if (timeStr) {
            const ms = new Date(timeStr).getTime();
            if (ms > maxTime) {
                maxTime = ms;
                newestId = id;
            }
        }
    }

    if (newestId) {
        console.log('Newest Cascade:', newestId);
        const traj = await client.rawRPC('GetCascadeTrajectory', { cascadeId: newestId });
        const stepIndex = (resp.trajectorySummaries as any)[newestId].lastUserInputStepIndex;
        console.log('StepIndex:', stepIndex);

        const steps = traj?.trajectory?.steps || [];
        if (steps[stepIndex]) {
            const items = steps[stepIndex].userInput?.items || [];
            for (const item of items) {
                console.log('User typed:', item.text);
            }
        }
    }
}
run();
