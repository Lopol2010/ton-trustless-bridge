import { toNano } from '@ton/core';
import { LiteClient } from '../wrappers/LiteClient';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const liteClient = provider.open(
        LiteClient.createFromConfig(
            {
                id: Math.floor(Math.random() * 10000),
                counter: 0,
            },
            await compile('LiteClient')
        )
    );

    await liteClient.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(liteClient.address);

    console.log('ID', await liteClient.getID());
}
