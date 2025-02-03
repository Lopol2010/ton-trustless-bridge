import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core';

export type LiteClientConfig = {
    id: number;
    initialValidatorSet: Cell;
};

export function liteClientConfigToCell(config: LiteClientConfig): Cell {
    return beginCell().storeUint(config.id, 32).storeRef(config.initialValidatorSet).endCell();
}

export const Opcodes = {
    OP_NEW_KEY_BLOCK: 0x11a78ffe,
    OP_CHECK_BLOCK: 0x8eaa9d76
};

export class LiteClient implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new LiteClient(address);
    }

    static createFromConfig(config: LiteClientConfig, code: Cell, workchain = 0) {
        const data = liteClientConfigToCell(config);
        const init = { code, data };
        return new LiteClient(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendNewKeyBlock(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint;
            queryID?: number;
            newKeyBlock: Cell
            signatures: Cell
        }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Opcodes.OP_NEW_KEY_BLOCK, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeRef(opts.newKeyBlock)
                .storeRef(opts.signatures)
                .endCell(),
        });
    }
}
