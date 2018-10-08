'use strict'
const cote = require('cote')
const pm2 = require('pm2')
const path = require('path')
const pkgmgr = require('elife-pkg-mgr')
const u = require('elife-utils')
const fs = require('fs')

/*      understand/
 * This is the main entry point where we start.
 *
 *      outcome/
 * Load any configuration information and start the microservice.
 */
function main() {
    let conf = loadConfig()
    startMicroservice(conf)
    startChannelsInFolder(conf,(err)=>{
        if(err) console.log(err)
    })
    setLastReqChannel()
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

let LAST_REQ
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
     * Anything that can handle messages registers itself which allows
     * the communication manager to send it user communication to which
     * it can respond if it knows how.
     */
    commMgrSvc.on('register-msg-handler', registerMsgHandler)


    /*      outcome/
     * The user has sent a message so we see if any component can handle
     * it otherwise we reply that we didn't understand.
     */
    commMgrSvc.on('message', (req, cb) => {
        if(!req.chan) cb(`Request missing channel! ${req}`)
        else {
            if(!req.ctx) cb(`Request missing context! ${req}`)
            else {
                LAST_REQ = req
                saveLastReqChannel(req)
                if(!req.msg) cb()
                else handleReply(req, (err, handling) => {
                    // TODO: Error messaging (especially object dumps) need to
                    // be designed better
                    if(err) cb(`Error! ${err}`)
                    else {
                        if(handling) cb()
                        else sendReply(`I'm sorry - I did not understand: ${req.msg}`, req, cb)
                    }
                })
            }
        }
    })

    /*      outcome/
     * We have a reply for the user so we call the correct channel with
     * the reply
     */
    commMgrSvc.on('reply', (req, cb) => {
        if(!req.chan) cb(`Request missing channel! ${req}`)
        else {
            if(!req.ctx) cb(`Request missing context! ${req}`)
            else {
                if(!req.msg) cb()
                else sendReply(req.msg, req, cb)
            }
        }
    })

    /*      outcome/
     * Reply on the last channel the user used to communicate with us
     */
    commMgrSvc.on('reply-on-last-channel', (req, cb) => {
        if(LAST_REQ) sendReply(req.msg, LAST_REQ, cb)
        else cb('No last channel found to reply on!') //TODO: Store last channel information in DB?
    })

}

let msgHandlerRegistry = []
function registerMsgHandler(req, cb) {
    if(!req.mskey || !req.mstype) cb(`mskey & mstype needed to register msg handler`)
    else {
        let client = new cote.Requester({
            name: `CommMgr -> ${req.mskey}`,
            key: req.mskey,
        })
        msgHandlerRegistry.push({client: client, mstype: req.mstype})
        cb(null)
    }
}

/*      understand/
 * The user can install multiple skills and many of these extend the
 * bot's abilitiy to respond to new commands, conversations, and so on.
 *
 *      outcome/
 * If the user has been interacting with a particular skill, it gets the
 * first chance of responding (continuing the conversation). If not, we
 * go through all registered skills and see if any of them respond.
 * Finally we try the AI to see if it can give us a response.
 *
 * TODO: Note that this implies that we can only handle/respond to one
 * user.
 */
let CURRENT_HANDLER
function handleReply(req, cb) {
    if(CURRENT_HANDLER) {
        isHandling(CURRENT_HANDLER, req, (err, handling) => {
            if(err) u.showErr(err)
            else {
                if(handling) cb(null, true)
                else check_handler_ndx_1(0)
            }
        })
    } else check_handler_ndx_1(0)

    function check_handler_ndx_1(ndx) {
        if(ndx >= msgHandlerRegistry.length) askAIForHelp(req, cb)
        else {
            isHandling(msgHandlerRegistry[ndx], req, (err,handling) => {
                if(err) u.showErr(err)
                else {
                    if(handling) {
                        CURRENT_HANDLER = msgHandlerRegistry[ndx]
                        cb(null, true)
                    } else check_handler_ndx_1(ndx+1)
                }
            })
        }
    }
}

const client = new cote.Requester({
    name: 'CommMgr -> AI Brain',
    key: 'everlife-ai-svc',
})

function askAIForHelp(req, cb) {
    client.send({ type: 'get-response', msg: req.msg }, (err, msg) => {
        if(err) cb(err)
        else {
            if(!msg) cb()
            else {
                sendReply(msg, req, (err) => {
                    if(err) cb(err)
                    else cb(null, true)
                })
            }
        }
    })
}

function isHandling(skill, req, cb) {
    req.type = skill.mstype
    skill.client.send(req, cb)
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
function sendReply(msg, req, cb) {
    workq.send({
        type: 'q',
        q: req.chan,
        data: {
            type: 'reply',
            ctx: req.ctx,
            msg: msg,
        },
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

/**
 * /outcome
 * starting the installed channel service.
 */
function startChannelsInFolder(cfg,cb){

    fs.readdir(cfg.CHANNEL_FOLDER,function(err,files){
        if(err) cb(err)
        else{
            for(const file of files){
                const loc = path.join(cfg.CHANNEL_FOLDER,file)
                if(fs.lstatSync(loc).isDirectory()){
                    if(err) u.showErr(err)
                    else {
                        console.log(`Starting ${file}...`)
                        pm2.connect((err) => {
                            if(err) cb(err)
                            else startProcess(loc, cb)
                        })
                    }
                }
            }
        }
    })
}

const levelDBClient = new cote.Requester({
    name: 'Communicaion mgr DB client',
    key: 'everlife-db-svc',
})

function saveLastReqChannel(reqChannel){

    levelDBClient.send({ type: 'put', key: 'last-req-channel', val: reqChannel }, (err) => {
        if(err) u.showErr(err)
    })
}

function setLastReqChannel(){
    levelDBClient.send({ type: 'get', key: 'last-req-channel' }, (err,val) => {
        if(err) u.showErr(err)
        else LAST_REQ = val
    })
}

main()
