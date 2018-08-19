'use strict'
const cote = require('cote')
const client = new cote.Requester({
    name: 'Test CommMgr Client',
    key: 'everlife-communication-svc',
})

/*      outcome/
 * Simple add communication channel test
 */
function main() {
    client.send({ type: 'add', pkg: 'everlifeai/elife-telegram' })
}

main()
