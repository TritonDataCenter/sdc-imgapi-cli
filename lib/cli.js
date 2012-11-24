/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * The main entry point for an imgapi-cli instance.
 */

var util = require('util'),
    format = util.format;
var path = require('path');
var fs = require('fs');
var assert = require('assert-plus');
var nopt = require('nopt');
var sprintf = require('extsprintf').sprintf;
var IMGAPI = require('sdc-clients/lib/imgapi');
var bunyan = require('bunyan');
var SSHAgentClient = require('ssh-agent');

var common = require('./common');
var errors = require('./errors');



//---- internal support stuff

var DEFAULT_IDENTITY_FILES = [
    path.resolve(process.env.HOME, '.ssh/id_rsa')
];


//---- CLI object

/**
 * Create an IMGAPI CLI instance.
 *
 * @param options {Object}:
 *      - @param name {String} Required. The CLI name, e.g. "joyent-imgadm".
 *      - @param url {String} Required. The IMGAPI URL.
 *      - @param description {String} Optional.
 *      - @param auth {String} Optional. One of "none" (default), "basic",
 *          "signature". This will impact what CLI options are available
 *          and auth used (if any) on requests to the IMGAPI.
 *      - @param envopts {Array} Optional. An ordered mapping of envvar name
 *          to associated CLI options. E.g.
 *                  [['FOO_CLI_IDENTITY': 'identity'], ...]
 *          will result in `--identity=$FOO_CLI_IDENTITY` effectively being
 *          added to argv if `--identity` wasn't already specified. A
 *          suggestion is to have `[USER: 'user']` in this array to have
 *          the default `--user` be the current username.
 */
function CLI(options) {
    assert.object(options, 'options');
    assert.string(options.name, 'options.name');
    assert.optionalString(options.description, 'options.description');
    assert.string(options.url, 'options.url');
    assert.optionalString(options.auth, 'options.auth');
    assert.optionalArrayOfObject(options.envopts, 'options.envopts');

    var self = this;
    this.auth = options.auth || 'none';
    assert.ok(['none', 'basic', 'signature'].indexOf(this.auth) !== -1);
    this.name = options.name;
    this.description = options.description;
    this.url = options.url;
    this.envopts = options.envopts;

    // Load subcmds.
    this.subcmds = {};
    this.aliases = {};
    Object.keys(this.constructor.prototype)
        .filter(function (funcname) { return /^do_/.test(funcname); })
        .sort()
        .forEach(function (funcname) {
            var name = funcname.slice(3);
            var func = self.constructor.prototype[funcname];
            self.subcmds[name] = func;
            self.aliases[name] = name;
            (func.aliases || []).forEach(function (alias) {
                self.aliases[alias] = name;
            });
        });

    this.helpcmds = {};
    Object.keys(this.constructor.prototype)
        .filter(function (funcname) { return /^help_/.test(funcname); })
        .sort()
        .forEach(function (funcname) {
            var name = funcname.slice(5);
            var func = self.constructor.prototype[funcname];
            self.helpcmds[name] = func;
        });
}


/**
 * CLI mainline.
 *
 * @param argv {Array}
 * @param callback {Function} `function (err)`
 */
CLI.prototype.main = function main(argv, callback) {
    var self = this;
    this.handleArgv(argv, this.envopts, function (err, opts) {
        if (err) {
            return callback(err);
        }

        var args = opts.argv.remain;
        if (opts.version) {
            console.log(self.name + ' ' + common.getVersion());
            return callback();
        }
        if (opts.help || args.length === 0) {
            return self.printHelp(callback);
        }

        /*
         * Logging is to stderr. By default we log at the 'warn' level -- but
         * that is almost nothing. Logging is in Bunyan format (hence very
         * limited default logging), so need to pipe via `bunyan` for readable
         * output (at least until bunyan.js supports doing it inline).
         *
         * Admittedly this is a bit of a pain:
         *
         *      imgapi-cli ping -ddd 2>&1 | bunyan
         *
         * Use -d|--debug to increase the logging:
         * - 1: info
         * - 2: debug
         * - 3: trace and enable 'src' (source file location information)
         */
        var level = 'warn';
        var src = false;
        if (opts.debug) {
            if (opts.debug.length === 1) {
                level = 'info'
            } else if (opts.debug.length === 2) {
                level = 'debug';
            } else {
                level = 'trace';
                src = true;
            }
        }
        self.log = bunyan.createLogger({
            name: self.name,
            streams: [{
                stream: process.stderr,
                level: level
            }],
            src: src,
            serializers: bunyan.stdSerializers
        });
        self.log.debug({opts: opts, argv: argv}, 'parsed argv');

        var imgapiOpts = {url: self.url};
        if (self.auth === 'basic') {
            imgapiOpts.username = opts.username;
            imgapiOpts.password = opts.password;
            self.log.info({username: imgapiOpts.username}, 'basic auth');
        } else if (self.auth === 'signature') {
            // TODO: support identity as a name retrieved from ssh-agent
            imgapiOpts.username = opts.username;
            imgapiOpts.privKey = fs.readFileSync(opts.identity);
            self.log.info({username: imgapiOpts.username || '(none)',
                identity: opts.identity}, 'signature auth');
        }
        self.client = new IMGAPI(imgapiOpts);

        var subcmd = args.shift();
        return self.dispatch(subcmd, args, callback);
    });
}


/**
 * Process options.
 *
 * @param argv {Array}
 * @param callback {Function} `function (err, opts)`.
 */
CLI.prototype.handleArgv = function handleArgv(argv, envopts, callback) {
    var self = this;

    var longOpts = {
        'help': Boolean,
        'version': Boolean,
        'debug': [Boolean, Array]
    };
    var shortOpts = {
        'h': ['--help'],
        'd': ['--debug']
    };
    if (this.auth === 'basic') {
        longOpts.user = String;
        shortOpts.u = ['--user'];
    } else if (this.auth === 'signature') {
        longOpts.user = String;
        shortOpts.u = ['--user'];
        longOpts.identity = String;
        shortOpts.i = ['--identity'];
    }
    var opts = nopt(longOpts, shortOpts, argv, 2);

    // Die on unknown opts.
    var extraOpts = {};
    Object.keys(opts).forEach(function (o) { extraOpts[o] = true; });
    delete extraOpts.argv;
    Object.keys(longOpts).forEach(function (o) { delete extraOpts[o]; });
    extraOpts = Object.keys(extraOpts);
    if (extraOpts.length) {
        return callback(new errors.UnknownOptionError(extraOpts.join(', ')));
    }

    // envopts
    envopts.forEach(function (envopt) {
        var envname = envopt[0];
        var optname = envopt[1];
        if (process.env[envname] && !opts[optname]) {
            //console.log('set `opts.%s = "%s" from %s envvar',
            //    optname, process.env[envname], envname);
            opts[optname] = process.env[envname];
        }
    });

    if (this.auth === 'signature') {
        if (opts.user) {
            opts.username = opts.user;
            delete opts.user;
        }
        if (!opts.identity) {
            for (var i=0; i < DEFAULT_IDENTITY_FILES.length; i++) {
                var p = DEFAULT_IDENTITY_FILES[i];
                if (fs.existsSync(p)) {
                    opts.identity = p;
                    break;
                }
            }
        }
        callback(null, opts);
    } else if (this.auth === 'basic') {
        if (opts.user) {
            if (opts.user.indexOf(':') === -1) {
                opts.username = opts.user;
                delete opts.user;
                var prompt = format('Enter IMGAPI password for user "%s": ',
                    opts.username);
                common.getPassword(prompt, function (err, password) {
                    if (err) {
                        return callback(err);
                    }
                    opts.password = password;
                    callback(null, opts);
                });
            } else {
                var colon = opts.user.indexOf(':');
                opts.username = opts.user.slice(0, colon);
                opts.password = opts.user.slice(colon + 1);
                delete opts.user;
                callback(null, opts);
            }
        } else {
            callback(null, opts);
        }
    } else {
        callback(null, opts);
    }
}

CLI.prototype.printHelp = function printHelp(callback) {
    var self = this;
    var template = '    %-18s  %s';

    var lines = [];
    if (this.description) {
        lines.push(this.description);
    }

    lines = lines.concat([
        'Usage:',
        '    %s [OPTIONS] COMMAND [ARGS...]',
        '    %s help COMMAND',
        '',
        'Options:',
        '    -h, --help          Show this help message and exit.',
        '    --version           Show version and exit.',
        '    -d, --debug         Debug logging. Multiple times for more.'
    ]);
    if (this.auth === 'basic') {
        lines = lines.concat([
            '    -u, --user <user:password>',
            '                        Basic auth username and (optionally) password.',
            '                        If no password is given, you will be prompted.',
        ]);
    } else if (this.auth === 'signature') {
        lines = lines.concat([
            '    -u, --user <user>   Username',
            '    -i <identity-file>  Path to identity file (private RSA key).',
        ]);
    }

    if (self.envopts.length) {
        lines.push('');
        lines.push('Environment:');
        self.envopts.forEach(function (envopt) {
            var envname = envopt[0];
            var optname = envopt[1];
            lines.push(sprintf(template, envname, 'Fallback for --'+optname));
        });
    }

    lines = lines.concat([
        '',
        'Commands:'
    ]);
    Object.keys(this.subcmds).forEach(function (name) {
        var func = self.subcmds[name];
        var names = name;
        if (func.aliases) {
            names += sprintf(' (%s)', func.aliases.join(', '));
        }
        var line = sprintf(template, names, func.description || '');
        lines.push(line);
    });
    console.log(lines.join('\n').replace(/%s/g, this.name));
    callback();
}

/**
 * Dispatch to the appropriate "do_SUBCMD" function.
 */
CLI.prototype.dispatch = function dispatch(subcmd, args, callback) {
    var self = this;
    var name = this.aliases[subcmd];
    if (!name) {
        return callback(new errors.UnknownCommandError(subcmd));
    }
    var func = this.subcmds[name];
    var opts = {}; // TODO: option processing
    return func.call(this, subcmd, {}, args, callback);
}

CLI.prototype.do_help = function do_help(subcmd, opts, args, callback) {
    if (args.length === 0) {
        return this.printHelp(callback);
    }
    var alias = args[0];
    var name = this.aliases[alias];
    if (!name) {
        return callback(new errors.UnknownCommandError(alias));
    }

    // If there is a `.help_NAME`, use that.
    var helpfunc = this.helpcmds[name];
    if (helpfunc) {
        return helpfunc.call(this, alias, callback);
    }

    var func = this.subcmds[name];
    if (func.help) {
        console.log(func.help);
    } else if (func.description) {
        console.log(func.description);
    } else {
        self.error(sprintf('no help for "%s"', alias));
        return 1
    }
}
CLI.prototype.do_help.aliases = ['?'];
CLI.prototype.do_help.description = 'Give detailed help on a specific sub-command.';

CLI.prototype.help_help = function help_help(subcmd, callback) {
    this.printHelp(callback);
};


CLI.prototype.do_ping = function do_ping(subcmd, opts, args, callback) {
    var self = this;
    this.client.ping(function (err, pong, res) {
        self.log.trace({err: err, res: res}, 'ping');
        if (err) {
            callback(new errors.APIError(err))
        }
        console.log("pong");
    });
};
CLI.prototype.do_ping.description = 'Ping the IMGAPI to see if it is up.';



//---- exports

module.exports = CLI;
