'use strict'
const cote = require('cote')
const pm2 = require('pm2')
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
     * TODO: Keep Channel Registry
     */
    commMgrSvc.on('add', (req, cb) => {
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

