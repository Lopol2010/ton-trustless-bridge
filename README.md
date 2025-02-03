## What's done?
**Good news**: implemented new_key_block message with signature validation and mechanism to update currently known validator set  
**Bad news**: nothing else is done. No proof verification, all cells are in my own format (i.e. not block.tlb format)  

## Todo list if I got luck to be in round 2
1. Make contract to work with block header and configparam34 in original format received from lite-server
2. Parse original data formats in contract side
3. Verification for block header, configparam34
4. Add check_block message and transaction checker contract


## How to use

### Test

`npx blueprint test`

### Deploy or run another script
Test validation algorithm at javascript side only  
`npx blueprint run a.ts --testnet --tonconnect`
Download blocks and signatures to local files for testing  
`npm run download`