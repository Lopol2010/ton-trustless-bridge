## What's done?
**Good news**: implemented new_key_block message with signature validation and mechanism to update currently known validator set  
**Bad news**: nothing else is done. No proof verification. And all cells are in my own format (i.e. not block.tlb format)  

## Todo list if I got luck to be in round 2
1. On-chain parse block header and configparam34 (and others) 
2. On-chain verification for block header, configparam34, etc..
3. Add check_block message and transaction checker contract
4. 146% test coverage
5. Add necessary scripts

## How to use

### Test

`npx blueprint test`

### Deploy or run another script
Test validation algorithm at javascript side only  
`npx blueprint run a.ts --testnet --tonconnect`
Download blocks and signatures to local files for testing  
`npm run download`