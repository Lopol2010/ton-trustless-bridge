import { Cell, toNano } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { LiteClient, LiteRoundRobinEngine, LiteSingleEngine, LiteEngine } from "ton-lite-client";
import { Address } from "@ton/core";
import { Functions, liteServer_BlockData, tonNode_BlockIdExt } from "ton-lite-client/dist/schema";
import TonRocks, { ParsedBlock, pubkeyHexToEd25519DER, ValidatorSignature } from "@oraichain/tonbridge-utils";
import { UserFriendlyValidator } from '@oraichain/tonbridge-contracts-sdk/build/TonbridgeValidator.types';
import { sha256 } from '@ton/crypto';
import assert from 'assert';
import TonWeb from 'tonweb';
import * as crypto from "crypto";
import { writeFile } from 'fs';

let engine, client;

export async function run(provider: NetworkProvider) {
    await init();

    let recentKeyBlocks = await getMostRecentKeyBlocks(2);

    for (let i = 0; i < recentKeyBlocks.length - 1; i++) {
        const { parsedBlock } = recentKeyBlocks[i];
        const { blockIdExt: newerBlockIdExt } = recentKeyBlocks[i + 1];
        // try {
        await verifyMasterchainBlock(client, parsedBlock, newerBlockIdExt);
        // } catch (err) {
        // console.log("error verification of block: ", blockIdExt.seqno)
        // }
    }

    engine.close();
}

export function intToIP(int: number) {
    var part1 = int & 255;
    var part2 = (int >> 8) & 255;
    var part3 = (int >> 16) & 255;
    var part4 = (int >> 24) & 255;
    return part4 + "." + part3 + "." + part2 + "." + part1;
}
export async function parseBlock(block: liteServer_BlockData): Promise<any> {
    const [rootCell] = await TonRocks.types.Cell.fromBoc(block.data);
    // Additional check for rootHash
    const rootHash = Buffer.from(rootCell.hashes[0]).toString("hex");
    if (rootHash !== block.id.rootHash.toString("hex")) {
        throw Error("got wrong block or here was a wrong root_hash format");
    }
    const parsedBlock = TonRocks.bc.BlockParser.parseBlock(rootCell);
    return parsedBlock;
}

async function getMostRecentKeyBlocks(numberOfBlocksToRetrieve: number = 1) {
    const masterchainInfo = await client.getMasterchainInfo();
    // key block. Got this by querying a block, then deserialize it, then find prev_key_block_seqno
    // it has to be a key block to include validator set & block extra to parse into the contract
    let blockInfo: any = masterchainInfo.last;
    let parsedKeyBlocks = [];
    while (numberOfBlocksToRetrieve > 0) {
        // get block
        const block = await engine.query(Functions.liteServer_getBlock, {
            kind: "liteServer.getBlock",
            id: {
                kind: "tonNode.blockIdExt",
                ...blockInfo,
            },
        });
        const parsedBlock = await parseBlock(block);
        const keyBlockInfo = await client.getFullBlock(
            parsedBlock.info.prev_key_block_seqno
        );
        let blockIdToStoreInArray = blockInfo;
        blockInfo = {
            kind: "tonNode.blockIdExt",
            ...keyBlockInfo.shards.find(
                (shard) => shard.seqno === parsedBlock.info.prev_key_block_seqno
            ),
        };

        if (!parsedBlock.info.key_block) {
            continue;
        }

        assert(parsedBlock.info.seq_no === blockIdToStoreInArray.seqno);
        parsedKeyBlocks.push({ parsedBlock, blockIdExt: blockIdToStoreInArray });
        numberOfBlocksToRetrieve--;

    }

    parsedKeyBlocks = parsedKeyBlocks.reverse()
    return parsedKeyBlocks;
}


async function verifyMasterchainBlock(
    liteClient: LiteClient,
    oldBlockParsedData: any,
    newBlockIdToVerify: tonNode_BlockIdExt
) {

    const validators = oldBlockParsedData.extra.custom.config.config.map.get("22");
    let friendlyValidators: UserFriendlyValidator[] = [];
    for (const entry of validators.cur_validators.list.map.entries()) {
        // magic number prefix for a node id of a validator
        const nodeIdPrefix = Buffer.from([0xc6, 0xb4, 0x13, 0x48]);
        const pubkey = entry[1].public_key.pubkey;
        const nodeId = await sha256(Buffer.concat([nodeIdPrefix, pubkey]));
        friendlyValidators.push({
            ...entry[1],
            node_id: nodeId.toString("base64"),
            weight: +entry[1].weight.toString(),
            pubkey,
        });
    }


    const blockHeader = await liteClient.getBlockHeader(newBlockIdToVerify);
    console.log(blockHeader);
    const blockHash = Cell.fromBoc(blockHeader.headerProof)[0].refs[0].hash(0);
    assert(blockHash.toString("hex") === blockHeader.id.rootHash.toString("hex"));

    const tonweb = new TonWeb(new TonWeb.HttpProvider(process.env.TONCENTER_ENDPOINT, { apiKey: process.env.TONCENTER_ENDPOINT_APIKEY }));
    const valSignatures = (await tonweb.provider.send(
        "getMasterchainBlockSignatures",
        {
            seqno: newBlockIdToVerify.seqno,
        }
    )) as any;

    const signatures = valSignatures.signatures as ValidatorSignature[];

    const max_main_validators = oldBlockParsedData.extra.custom.config.config.map.get("10").max_main_validators;
    const sumLargestTotalWeights = friendlyValidators
        .sort((a, b) => b.weight - a.weight)
        .slice(0, max_main_validators)
        .map((val) => val.weight)
        .reduce((prev, cur) => prev + cur);
    const message = Buffer.concat([
        // magic prefix of message signing
        Buffer.from([0x70, 0x6e, 0x0b, 0xc5]),
        blockHash,
        blockHeader.id.fileHash,
    ]);

    let totalWeight = 0;

    for (const item of signatures) {
        const validator = friendlyValidators.find((val) => {
            return val.node_id === item.node_id_short;
        });
        if (!validator) continue;
        const key = pubkeyHexToEd25519DER(validator.pubkey);
        const verifyKey = crypto.createPublicKey({
            format: "der",
            type: "spki",
            key,
        });
        const result = crypto.verify(
            null,
            message,
            verifyKey,
            Buffer.from(item.signature, "base64")
        );
        assert(result === true);
        totalWeight += validator.weight;
    }
    assert(totalWeight > 0);
    assert(totalWeight * 3 > sumLargestTotalWeights * 2);
    console.log("verified block", newBlockIdToVerify.seqno)
}

async function init() {

    const { liteservers } = await fetch(process.env.TON_BLOCKCHAIN_CONFIG_URL).then((data) => data.json());
    const engines: LiteEngine[] = [];
    engines.push(
        ...liteservers.map(
            (server: any) =>
                new LiteSingleEngine({
                    host: `tcp://${intToIP(server.ip)}:${server.port}`,
                    publicKey: Buffer.from(server.id.key, "base64"),
                })
        )
    );
    engine = new LiteRoundRobinEngine(engines);
    client = new LiteClient({ engine, cacheMap: 1000000 });
}