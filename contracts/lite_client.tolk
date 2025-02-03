import "@stdlib/tvm-dicts"

const OP_NEW_KEY_BLOCK = 0x11a78ffe; 
const OP_CHECK_BLOCK   = 0x8eaa9d76;

global gID: int;
global gLastKnownValidatorSet: cell;

// populates storage variables from persistent storage
fun loadData() {
    var ds = getContractData().beginParse();

    gID = ds.loadUint(32);
    gLastKnownValidatorSet = ds.loadRef();

    ds.assertEndOfSlice();
}

// stores storage variables as a cell into persistent storage
fun saveData() {
    setContractData(
        beginCell()
        .storeUint(gID, 32)
        .storeRef(gLastKnownValidatorSet)
        .endCell()
    );
}

fun onInternalMessage(myBalance: int, msgValue: int, msgFull: cell, msgBody: slice) {
    if (msgBody.isEndOfSlice()) { // ignore all empty messages
        return;
    }

    var cs: slice = msgFull.beginParse();
    val flags = cs.loadMessageFlags();
    if (isMessageBounced(flags)) { // ignore all bounced messages
        return;
    }

    loadData();

    val op = msgBody.loadMessageOp();
    val queryID = msgBody.loadMessageQueryId();

    if (op == OP_NEW_KEY_BLOCK) {

        var newKeyBlock = msgBody.loadRef().beginParse();
        var newKeyBlockHash = newKeyBlock.loadBits(256);
        var newKeyBlockFileHash = newKeyBlock.loadBits(256);

        var magic_prefix = 0x706e0bc5;
        var data_to_sign = beginCell()
            .storeUint(magic_prefix, 32)
            .storeSlice(newKeyBlockHash)
            .storeSlice(newKeyBlockFileHash)
            .endCell()
            .beginParse();

        var signatureListHead = msgBody.loadRef().beginParse();
        var i = 0;
        var totalWeight = 0;

        var lastKnownValidatorSetStruct = gLastKnownValidatorSet.beginParse();
        var sumLargestWeights = lastKnownValidatorSetStruct.loadUint(256);
        var lastKnowValidatorSet = lastKnownValidatorSetStruct.loadDict();
        while(signatureListHead != null) {
            var nodeId = signatureListHead.loadBits(256);
            var signature = signatureListHead.loadBits(512);

            var (value, success) = lastKnowValidatorSet.sDictGet(256, nodeId);
            // TODO: should handle success value better?
            if(success) {
                i += 1;
                var publicKey = value.loadUint(256);
                // TODO: check weights
                var weight = value.loadUint(256);

                if(!isSliceSignatureValid(data_to_sign, signature, publicKey)) {
                    throw 0xFFFF; // TODO: should respond with  fail message as stated in task
                }
                totalWeight += weight;
            } else {
                debugPrintString("not found validator for signature:");
                throw 0xFFFF; // TODO: should respond with  fail message as stated in task

            }

            if(signatureListHead.isEndOfSliceRefs()) {
                signatureListHead = null;
            } else {
                signatureListHead = signatureListHead.loadRef().beginParse();
            }
        }
        
        if(totalWeight == 0 || totalWeight * 3 <= sumLargestWeights * 2) {
            throw 0xFFFF; // TODO: should respond with  fail message as stated in task
        }

        var validatorSetStruct = newKeyBlock.loadRef();
        gLastKnownValidatorSet = validatorSetStruct;

        saveData();
        return;
    }

    throw 0xffff; // if the message contains an op that is not known to this contract, we throw
}
