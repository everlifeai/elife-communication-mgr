# The Everlife Communication Manager

Every Everlife avatar needs to communicate with it's owner. It will use
a variety of channels - telegram, messenger, web and so on. The
communication managaer is responsible for downloading and making
available these various communication channels.

As with all core components, it exposes a cote.js microservice
partitioned with the key `everlife-communication-svc`.

## Configuration
The configuration has defaults that can be overridden by environment
variables.


## Quick Start
```js
const cote = require('cote')

const client = new cote.Requester({
    name: 'Test CommMgr Client',
    key: 'everlife-communication-svc',
})

...
client.send({ type: 'add', pkg: 'everlifeai/elife-telegram' })
...

```

