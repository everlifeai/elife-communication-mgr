'use strict'
const cote = require('cote')({statusLogsEnabled:false})
const pm2 = require('@elife/pm2')
const path = require('path')
const pkgmgr = require('@elife/pkg-mgr')
const u = require('@elife/utils')
const fs = require('fs')

/*      understand/
 * This is the main entry point where we start.
 *
 *      outcome/
 * Load any configuration information and start the microservice.
 */
function main() {
    let conf = loadConfig()
    setCoteJSTimeout()
    startMicroservice(conf)
    setLastReqChannel((err) => {
        if(err) u.showErr(err)
    })
    startChannelsInFolder(conf,(err)=>{
        if(err) u.showErr(err)
    })
}

function setCoteJSTimeout() {
    if(!process.env['COTE_REQUEST_TIMEOUT']) {
        process.env['COTE_REQUEST_TIMEOUT'] = 30 * 1000
    }
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


const ssbClient = new cote.Requester({
    name: 'CommMgr -> SSB',
    key: 'everlife-ssb-svc',
})

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
            let channelfolder = path.join(__dirname, cfg.CHANNEL_FOLDER)
            u.showMsg(`Installing ${req.pkg}...`)
            pkgmgr.load(req.pkg, channelfolder, (err, loc) => {
                if(err) cb(err)
                else {
                    u.showMsg(`Starting ${req.pkg}...`)
                    startProcess(loc, cb)
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
     * The user has sent a message so we check it and standardize it,
     * save the last request channel, and then try to handle it.
     *
     * see if any component can handle
     * it otherwise we reply that we didn't understand.
     */
    commMgrSvc.on('message', (req, cb) => {
        if(!req.chan) cb(`Request missing channel!`, req)
        else {
            if(!req.ctx) cb(`Request missing context!`, req)
            else {
                LAST_REQ = req
                saveLastReqChannel(req, (err) => {
                    if(err) u.showErr(err)
                    stdMsg(req, (err, req) => {
                        if(err) cb(err)
                        else handleReq(req, cb)
                    })
                })
            }
        }
    })

    /*      outcome/
     * If the request is for `/help` we show the help otherwise we check
     * if anyone can handle the reply. If someone informed us that they
     * can we finish the cycle - they will reply when they want.
     * Otherwise it is our unfortunate duty to inform the user that we
     * did not understand them.
     */
    function handleReq(req, cb) {
        if(!req.msg) cb()
        else if(req.msg == '/help') showHelp(req, cb)
        else handleReply(req, (err, handling) => {
            // TODO: Error messaging (especially object dumps) need to
            // be designed better
            if(err) cb(`Error! ${err}`)
            else {
                if(handling) cb()
                else sendReply(`I'm sorry - I did not understand: ${req.msg}`,null,req,cb)
            }
        })
    }

    /*      outcome/
     * Someone (not our user) has sent us a message so respond with any
     * info that the avatar is willing to share.
     */
    commMgrSvc.on('not-owner-message', (req, cb) => {
        let addl = {
            'type':'not-owner-message',
            'msg' : req.msg
        }
        if(!req.chan) cb(`Request missing channel! ${req}`)
        else {
            if(!req.ctx) cb(`Request missing context! ${req}`)
            else {
                handleInfoReq(req, (err, handling) => {
                    if(err) cb(`Error! ${err}`)
                    else {
                        if(handling) cb()
                        else{
                            addl['ans'] = false
                            sendReply(`I'm sorry - I did not understand: ${req.msg}`, addl, req, cb)
                        } 
                    }
                })
            }
        }
    })


    /*      outcome/
     * We have a reply for the user so we call the correct channel with
     * the reply. If the special value, USELASTCHAN is set, we use the
     * last channel that the user used to communicate with us.
     */
    commMgrSvc.on('reply', (req, cb) => {
        if(req.USELASTCHAN && LAST_REQ) {
            req.chan = LAST_REQ.chan
            req.ctx = LAST_REQ.ctx
        }
        if(!req.chan) cb(`Request missing channel!`, req)
        else {
            if(!req.ctx) cb(`Request missing context!`, req)
            else {
                if(isEmpty(req.msg) && isEmpty(req.addl)) cb()
                else {
                    stdReply(req, (err, req) => {
                        sendReply(req.msg, req.addl, req, cb)
                    })
                }
            }
        }
    })

    function isEmpty(x) {
        return x === null || x === undefined || x.length == 0
    }

    /*      outcome/
     * Reply on the last channel the user used to communicate with us
     */
    commMgrSvc.on('reply-on-last-channel', (req, cb) => {
        if(LAST_REQ) sendReply(req.msg, req.addl, LAST_REQ, cb)
        else cb('No last channel found to reply on!') //TODO: Store last channel information in DB?
    })

}

let msgHandlerRegistry = []
let helps = []
function registerMsgHandler(req, cb) {
    if(!req.mskey || !req.mstype) cb(`mskey(${req.mskey}) & mstype(${req.mstype}) needed to register msg handler`)
    else {
        if(!addHelp(req.mshelp)) cb(`${req.mskey} Help command and text (mshelp) needed to register msg handler`)
        else {
            if (!isRegistered(req.mskey)) {
                let client = new cote.Requester({
                    name: `CommMgr -> ${req.mskey}`,
                    key: req.mskey,
                })
                msgHandlerRegistry.push({client: client, mstype: req.mstype, mskey: req.mskey})
                cb(null)
            }
        }
    }
}

function isRegistered(mskey) {
    for (let i=0; i<msgHandlerRegistry.length; i++) {
        if (msgHandlerRegistry[i].mskey === mskey) {
            return true;
        }
    }
    return false;
}

function addHelp(mshelp) {
    if(!mshelp || !mshelp.length) return
    for(let i = 0;i < mshelp.length;i++) {
        let h = mshelp[i]
        if(!h.cmd || h.cmd[0] != '/' || !h.txt) return
        helps.push(h)
    }
    return true
}

function showHelp(req, cb) {
    let txt = "/help: show this help\n";
    for(let i = 0;i < helps.length;i++) {
        let h = helps[i]
        txt += `${h.cmd}: ${h.txt}\n`
    }
    sendReply(txt, null, req, (err) => { cb(err, true) })
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
            if(err) cb(err)
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

/*      outcome/
 * If it is not the owner, we only respond from the KB
 */
function handleInfoReq(req, cb) {
    askAIForKB(req, cb)
}

const client = new cote.Requester({
    name: 'CommMgr -> AI Brain',
    key: 'everlife-ai-svc',
})

function askAIForHelp(req, cb) {
    handleAImsReq(req, 'get-response', cb)
}

function askAIForKB(req, cb) {
    handleAImsReq(req, 'get-kb-response', cb)
}

/*      outcome/
 * Make a request to the AI microservice - if we get a response then we
 * handle it otherwise say we are not able to
 */
function handleAImsReq(req, type_, cb) {
    client.send({ type: type_, msg: req.msg }, (err, msg) => {
        if(err) cb(err)
        else {
            if(!msg) cb()
            else {
                req.msg = msg
                req.addl = undefined
                stdReply(req, (err, req) => {
                    sendReply(req.msg, req.addl, req, (err) => {
                        if(err) cb(err)
                        else cb(null, true)
                    })
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
 * We keep a set of channel microservices that we can use to communicate
 * back with our channels.
 */
let channels = {}
function getChannel(chan) {
    if(!chan) return
    if(!channels[chan]) {
        channels[chan] = new cote.Requester({
            name: 'CommMgr -> ${chan}',
            key: chan,
        })
    }

    return channels[chan]
}

/*      outcome/
 * Send a reply back on the requestor's channel.
 */
function sendReply(msg, addl, req, cb) {
    let chan = getChannel(req.chan)
    if(chan) {
        chan.send({
            type: 'reply',
            ctx: req.ctx,
            msg: msg,
            addl: addl,
        }, cb)
    } else {
        u.showErr('No valid reply channel', req)
    }
}

function startProcess(cwd, cb) {
    let name = path.basename(cwd)
    let lg = path.join(u.logsLoc(), `${name}.log`)
    let opts = {
        name: name,
        script: "index.js",
        cwd: cwd,
        log: lg,
        stripANSI: true,
    }
    pm2.start(opts, cb)
}

/**
 * /outcome
 * starting the installed channel service.
 */
function startChannelsInFolder(cfg,cb){
    let channelfolder = path.join(__dirname, cfg.CHANNEL_FOLDER)
    fs.readdir(channelfolder, function (err,files) {
        if(err) cb(err)
        else{
            for(const file of files){
                const loc = path.join(channelfolder, file)
                if(fs.lstatSync(loc).isDirectory()) {
                    u.showMsg(`Starting ${file}...`)
                    startProcess(loc, cb)
                }
            }
        }
    })
}



const levelDBClient = new cote.Requester({
    name: 'Communicaion mgr DB client',
    key: 'everlife-db-svc',
})

const LAST_REQ_CHANNEL = 'LAST_REQ_CHANNEL'
/**
 *  /outcome
 * Saving the last request channel in LevelDB
 */
function saveLastReqChannel(reqChannel, cb){
    let val = JSON.stringify({chan:reqChannel.chan,ctx:reqChannel.ctx})
    levelDBClient.send({ type: 'put', key: LAST_REQ_CHANNEL, val: val }, cb)
}

/**
 *  /outcome
 * Fetching last request channel from LevelDB and then setting LAST_REQ
 */
function setLastReqChannel(cb){
    levelDBClient.send({ type: 'get', key: LAST_REQ_CHANNEL }, (err,val) => {
        if(err) cb(err)
        else{
            try {
                LAST_REQ = JSON.parse(val)
                cb()
            } catch(e) {
                cb(e)
            }
        }
    })
}

/*      problem/
 * Messages that contain byte data are to be stored as blobs with
 * references in the actual message text.
 *
 *      way/
 * Check if the message contains addl.bytes and save it as a message
 * reference with this format:
 *      ref:type:"mime type":blobreference
 *
 * All other messages are just passed through
 */
function stdMsg(req, cb) {
    if(!req.msg && req.addl && req.addl.bytes) {
        save_as_blob_msg_1(req, cb)
    } else {
        cb(null, req)
    }

    function save_as_blob_msg_1(req, cb) {
        let bytes = req.addl.bytes
        if(!bytes.length) cb(null, req)
        else {
            ssbClient.send({type:'blob-save-array',bytes:bytes}, (err,hash) => {
                if(err) cb(err)
                else {
                    req.msg = `ref:${req.addl.type}:"${req.addl.mime}":${hash}`
                    cb(null, req)
                }
            })
        }
    }
}

/*      outcome/
 * When given message we check if it is of the form -
 *      ref:type:"mime type":blobreference
 * by extracting the various parts. If it is, we fetch the blob and
 * construct the additional message information from it.
 */
function stdReply(req, cb) {
    xtract_addl_1(req, (err, addl) => {
        if(addl) {
            req.msg = null
            req.addl = addl
        }
        cb(err, req)
    })

    function xtract_addl_1(req, cb) {
        let msg = req.msg
        let r = {}
        let s = "ref:"
        if(!msg.startsWith(s)) return cb()
        let i = msg.indexOf(':', s.length)
        r.type = msg.substring(s.length, i)
        i++
        if(msg[i] != '"') return cb()
        i++
        let i2 = msg.indexOf('"', i)
        r.mime = msg.substring(i, i2)
        i2++
        if(msg[i2] != ':') return cb()
        i2++
        let hash = msg.substring(i2)
        if(!hash) return cb()
        ssbClient.send({type:'blob-load',hash:hash}, (err,blobs) => {
            if(err) cb(err)
            else {
                let arrs = []
                for(let i = 0;i < blobs.length;i++) {
                    arrs.push(blobs[i].data)
                }
                r.bytes = [].concat.apply([], arrs)
                cb(null, r)
            }
        })
    }
}



main()
