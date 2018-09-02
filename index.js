'use strict'
const cote = require('cote')
const pm2 = require('pm2')
const path = require('path')
const pkgmgr = require('elife-pkg-mgr')
const u = require('elife-utils')


/*      understand/
 * This is the main entry point where we start.
 *
 *      outcome/
 * Load any configuration information and start the microservice.
 */
function main() {
    let conf = loadConfig()
    startMicroservice(conf)
}

/*      outcome/
 * Load the configuration (from environment variables) or defaults
 */
function loadConfig() {
    let cfg = {};
    if(process.env.CHANNEL_FOLDER) {
        cfg.CHANNEL_FOLDER = process.env.CHANNEL_FOLDER;
    } else {
        cfg.CHANNEL_FOLDER = "./channels";
    }
    return cfg;
}


function startMicroservice(cfg) {

    /*      understand/
     * The communication microservice (partitioned by key
     * `everlife-communication-svc` to prevent conflicting with other
     * services.
     */
    const commMgrSvc = new cote.Responder({
        name: 'Everlife Communication Manager Service',
        key: 'everlife-communication-svc',
    })


    /*      outcome/
     * Responds to a request for adding a new communication channel
     */
    commMgrSvc.on('add-channel', (req, cb) => {
        if(!req.pkg) cb('No communication package found')
        else {
            u.showMsg(`Installing ${req.pkg}...`)
            pkgmgr.load(req.pkg, cfg.CHANNEL_FOLDER, (err, loc) => {
                if(err) cb(err)
                else {
                    u.showMsg(`Starting ${req.pkg}...`)
                    pm2.connect((err) => {
                        if(err) cb(err)
                        else startProcess(loc, cb)
                    })
                }
            })
        }
    })

    /*      problem/
     * The avatar suppors a variety of communication channels and so the
     * various plugins need to be aware of which channel they should
     * respond to.
     *
     *      way/
     * The channels register themselves to the communication manager
     * with different keys (it is the channel's responsibility to
     * generate a unique key). The communication manager then sends
     * messages to the microservices partitioned by these keys
     */
    let channelRegistry = {}
    commMgrSvc.on('register-channel', (req, cb) => {
        if(!req.chan) cb('No channel key provided!')
        else {
            if(channelRegistry[req.chan]) cb(`Channel ${req.chan} already registered!`)
            else {
                channelRegistry[req.chan] = new cote.Requester({
                    name: 'ComMgr -> ' + req.chan,
                    key: req.chan,
                })
                cb()
            }
        }
    })

    /*      outcome/
     * The user has sent a message
     */
    commMgrSvc.on('message', (req, cb) => {
        let chan = channelRegistry[req.chan]
        if(!chan) cb(`Channel ${req.chan} not registered!`)
        else {
            chan.send({
                type: 'reply',
                ctx: req.ctx,
                msg: 'Manager says: ' + req.msg,
            }, cb)
        }
    })
}

function startProcess(cwd, cb) {
    let name = path.basename(cwd)
    let lg = path.join(__dirname, 'logs', `${name}.log`)
    let opts = {
        name: name,
        script: "index.js",
        cwd: cwd,
        log: lg,
    }
    pm2.start(opts, cb)
}

main()

