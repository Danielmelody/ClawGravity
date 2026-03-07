import { discoverLSConnection, GrpcCascadeClient } from './src/services/grpcCascadeClient';
async function run() {
    const conn = await discoverLSConnection();
    if (!conn) { console.log('No LS conn'); return; }
    const client = new GrpcCascadeClient();
    client.setConnection(conn);
    
    const resp = await client.rawRPC('GetAllCascadeTrajectories', {});
    const ids = Object.keys(resp?.trajectorySummaries || {});
    if (ids.length > 0) {
        const id = ids[0];
        console.log('Fetching', id);
        const traj = await client.rawRPC('GetCascadeTrajectory', { cascadeId: id });
        console.log(JSON.stringify(traj?.trajectory?.steps || [], null, 2));
    }
}
run();
