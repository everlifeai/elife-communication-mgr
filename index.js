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
     * A user has installed a skill, and it should respond to
     * appropriate requests.
     *
     *      way/
     * The skill registers itself which allows the communication manager
     * to send communications to it.
     */
    let skillRegistry = []
    commMgrSvc.on('register-skill', (req, cb) => {
        skillRegistry.push(req)
        cb(null)
    })


    /*      outcome/
     * The user has sent a message so send a reply
     */
    commMgrSvc.on('message', (req, cb) => {
        sendReply(req.chan, {
            type: 'reply',
            ctx: req.ctx,
            msg: 'Manager says: ' + req.msg,
        }, cb)
    })
}


/*      understand/
 * The queue microservice manages task queues
 */
let workq = new cote.Requester({
    name: 'ComMgr -> Work Queue',
    key: 'everlife-workq-svc',
})
/*      outcome/
 * Use the queue microservice to properly stack messages for each
 * channel.
 */
function sendReply(chan, rep, cb) {
    workq.send({
        type: 'q',
        q: chan,
        data: rep,
    }, cb)
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
