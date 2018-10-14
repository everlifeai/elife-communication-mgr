'use strict'
const cote = require('cote')({statusLogsEnabled:false})
const client = new cote.Requester({
    name: 'Telegram CommMgr Client',
    key: 'everlife-communication-svc',
})

/*      outcome/
 * Add the basic telegram channel so we can begin chatting
 */
function main() {
    client.send({ type: 'add-channel', pkg: 'everlifeai/elife-telegram' })
}

main()
