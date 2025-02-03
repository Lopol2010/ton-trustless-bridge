import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, BitBuilder, BitString, Builder, Cell, Dictionary, DictionaryKey, DictionaryValue, toNano, TupleBuilder } from '@ton/core';
import { LiteClient } from '../wrappers/LiteClient';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { readFileSync } from 'fs';
import { UserFriendlyValidator } from '@oraichain/tonbridge-contracts-sdk/build/TonbridgeValidator.types';
import { sha256 } from '@ton/crypto';
import { pubkeyHexToEd25519DER } from '@oraichain/tonbridge-utils';
import { createPublicKey, verify } from 'crypto';
import assert from 'assert';

function reviver(key, value) {
    if (typeof value === 'object' && value !== null) {
        if (value.dataType === 'Map') {
            return new Map(value.value);
        }
        if (value["_"] === 'SigPubKey') {
            value.pubkey = new Uint8Array(Object.values(value.pubkey))
            return value
        }
        if (value["_"] === 'ValidatorDescr') {
            value.weight = BigInt("0x" + value.weight)
            return value
        }
    }
    return value;
}
async function validatorSetAsBoc(validators: any[], oldBlockParsedData) {
    let formattedValidatorList = [];
    for (const entry of validators) {
        // magic number prefix for a node id of a validator
        const nodeIdPrefix = Buffer.from([0xc6, 0xb4, 0x13, 0x48]);
        const pubkey = entry[1].public_key.pubkey;
        const nodeId = await sha256(Buffer.concat([nodeIdPrefix, pubkey]));
        // console.log(entry[1].weight)
        formattedValidatorList.push({
            node_id: nodeId,
            weight: entry[1].weight,
            pubkey,
        });
    }

    const dict = Dictionary.empty(Dictionary.Keys.BitString(256), Dictionary.Values.BitString((256 + 256)))

    for (const element of formattedValidatorList) {

        const valueb = (new BitBuilder);
        valueb.writeBuffer(Buffer.from(element.pubkey))
        valueb.writeUint(element.weight, 256)
        const bitstr = valueb.build();

        const keyb = (new BitBuilder);
        keyb.writeBuffer(element.node_id)
        const keybitstr = keyb.build();

        dict.set(keybitstr, bitstr);
    }

    const max_main_validators = oldBlockParsedData.extra.custom.config.config.map.get("10").max_main_validators;
    const sumLargestTotalWeights = formattedValidatorList
        .sort((a, b) => (a < b) ? -1 : ((a > b) ? 1 : 0))
        .slice(0, max_main_validators)
        .map((val) => val.weight)
        .reduce((prev, cur) => prev + cur);

    return beginCell().storeUint(sumLargestTotalWeights, 256).storeDict(dict).endCell()
}

function signaturesAsBoc(signatures) {

    const signature = signatures.pop();
    const nodeIdBytes = Buffer.from(signature.node_id_short, 'base64');
    const signatureBytes = Buffer.from(signature.signature, 'base64');

    let builder = beginCell()
    builder.storeBuffer(nodeIdBytes, 32);
    builder.storeBuffer(signatureBytes, 64);

    if (signatures.length == 0) {
        return builder;
    }

    return builder.storeRef(signaturesAsBoc(signatures));
}
describe('LiteClient', () => {
    let code: Cell;

    let blocks; // there is 1 more block(its used as initial) than items in signatures or hashes arrays
    let currentSignatures;
    let hashes;

    beforeAll(async () => {
        code = await compile('LiteClient');

        blocks = JSON.parse(readFileSync('blocks.json').toString(), reviver);
        currentSignatures = JSON.parse(readFileSync('signatures.json').toString());
        hashes = JSON.parse(readFileSync('headerHashes.json').toString());
    });

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let liteClient: SandboxContract<LiteClient>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();

        /*
            TODO: (script side) need to send to contract only validators with existing signature
            TODO: (possible optimization?) maybe rewrite signatures array from cells list into tuples list 

            TODO:
            1. store validator set during initialization (in my format)
            2. in new_key_block, should send validatorset and signatures (in my format) for the new block
            3. create signature verification logic
            4. store new validator set
            5. add blockheader and its proof verification
            6. request configparam34 from toncenter and try to parse as a block in js, 
                then try to repeat that in Tolk, so that validator set can be retrieved from that, insdead of my own data structure like now
            7. i guess in final step, need to send raw header and param34 and parse them in contract (though contest ends in 2 days, so probably impossible)

        */

        // let blocks = JSON.parse(readFileSync('blocks.json').toString(), reviver);
        let currentKeyBlock = blocks[0];
        // blocks.shift()
        // let newKeyBlock = blocks[0];

        let validators = currentKeyBlock.parsedBlock.extra.custom.config.config.map.get("22")
        let validatorsBoc = await validatorSetAsBoc(validators.cur_validators.list.map.entries(), blocks[0].parsedBlock) // TODO: should be old block (block[1])

        liteClient = blockchain.openContract(
            LiteClient.createFromConfig(
                {
                    id: 0,
                    initialValidatorSet: validatorsBoc
                },
                code
            )
        );

        deployer = await blockchain.treasury('deployer');

        const deployResult = await liteClient.sendDeploy(deployer.getSender(), toNano('0.05'));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: liteClient.address,
            deploy: true,
            success: true,
        });
    });

    it('should deploy', async () => {
        // the check is done inside beforeEach
        // blockchain and liteClient are ready to use
    });
    it('should be valid saved data', async () => {

        const txSender = await blockchain.treasury('txSender');


        for (let i = 0; i < currentSignatures.length; i++) {

            let olderBlock = blocks[i];

            let validators = olderBlock.parsedBlock.extra.custom.config.config.map.get("22")

            const { blockHash, fileHash } = hashes[i];

            const message = Buffer.concat([
                // magic prefix of message signing
                Buffer.from([0x70, 0x6e, 0x0b, 0xc5]),
                Buffer.from(blockHash),
                Buffer.from(fileHash),
            ]);

            let friendlyValidators = [];
            for (const entry of validators.cur_validators.list.map.entries()) {
                // magic number prefix for a node id of a validator
                const nodeIdPrefix = Buffer.from([0xc6, 0xb4, 0x13, 0x48]);
                const pubkey = entry[1].public_key.pubkey;

                const nodeId = await sha256(Buffer.concat([nodeIdPrefix, pubkey]));
                friendlyValidators.push({
                    node_id: nodeId.toString("base64"),
                    weight: entry[1].weight,
                    pubkey,
                });
            }
            let countVerified = 0;
            for (const item of currentSignatures[i].signatures) {
                const validator = friendlyValidators.find((val) => {
                    return val.node_id === item.node_id_short;
                });
                if (!validator) continue;

                const key = pubkeyHexToEd25519DER(validator.pubkey);
                const verifyKey = createPublicKey({
                    format: "der",
                    type: "spki",
                    key,
                });
                const result = verify(
                    null,
                    message,
                    verifyKey,
                    Buffer.from(item.signature, "base64")
                );
                assert(result === true);
                countVerified++;
            }
            assert(countVerified > 9)
            // TODO: add weight verification (like in a.js)
        }
    });

    // it('should success new_key_block', async () => {

    //     const txSender = await blockchain.treasury('txSender');

    //     // let currentKeyBlock = blocks[1];
    //     let newKeyBlock = blocks[0];

    //     let validators = newKeyBlock.parsedBlock.extra.custom.config.config.map.get("22")
    //     let validatorsBoc = await validatorSetAsBoc(validators.cur_validators.list.map.entries())

    //     let signaturesCell = signaturesAsBoc(structuredClone(currentSignatures[0]))


    //     const { blockHash, fileHash } = hashes[0];

    //     const newKeyBlockBoc = beginCell()
    //         .storeBuffer(Buffer.from(blockHash))
    //         .storeBuffer(Buffer.from(fileHash))
    //         .storeRef(validatorsBoc)
    //         .endCell()

    //     const txSenderesult = await liteClient.sendNewKeyBlock(txSender.getSender(), {
    //         value: toNano('1.05'),
    //         signatures: signaturesCell,
    //         newKeyBlock: newKeyBlockBoc
    //     });

    //     expect(txSenderesult.transactions).toHaveTransaction({
    //         from: txSender.address,
    //         to: liteClient.address,
    //         success: true,
    //     });

    // });

    it('should success new_key_block for all(saved) blocks', async () => {



        const txSender = await blockchain.treasury('txSender');
        let validatorSets = [];
        for (let i = 0; i < currentSignatures.length; i++) {

            let oldBlock = blocks[i];
            let newKeyBlock = blocks[i+1];

            let validators = newKeyBlock.parsedBlock.extra.custom.config.config.map.get("22")
            let validatorsBoc = await validatorSetAsBoc(validators.cur_validators.list.map.entries(), oldBlock.parsedBlock)

            let formattedValidatorList = [];
            for (const entry of validators.cur_validators.list.map.entries()) {
                // magic number prefix for a node id of a validator
                const nodeIdPrefix = Buffer.from([0xc6, 0xb4, 0x13, 0x48]);
                const pubkey = entry[1].public_key.pubkey;
                const nodeId = await sha256(Buffer.concat([nodeIdPrefix, pubkey]));

                formattedValidatorList.push({
                    node_id: nodeId,
                    weight: entry[1].weight,
                    pubkey: Buffer.from(entry[1].public_key.pubkey),
                });
            }

            let signaturesCell = signaturesAsBoc(structuredClone(currentSignatures[i].signatures))
            let { blockHash, fileHash } = hashes[i];
            let newKeyBlockBoc = beginCell()
                .storeBuffer(Buffer.from(blockHash))
                .storeBuffer(Buffer.from(fileHash))
                .storeRef(validatorsBoc)
                .endCell()

            let txSenderesult = await liteClient.sendNewKeyBlock(txSender.getSender(), {
                value: toNano('1.05'),
                queryID: i,
                signatures: signaturesCell,
                newKeyBlock: newKeyBlockBoc
            });

            expect(txSenderesult.transactions).toHaveTransaction({
                from: txSender.address,
                to: liteClient.address,
                success: true,
            });
        }

        function countDuplicates(arr1, arr2) {
            const set1 = new Set(arr1);
            const set2 = new Set(arr2);

            let duplicatesCount = 0;

            set1.forEach(item => {
                if (set2.has(item)) {
                    duplicatesCount++;
                }
            });

            return duplicatesCount;
        }
    });
});
