/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * The main entry point for an imgapi-cli instance.
 */

var util = require('util'),
    format = util.format;
var assert = require('assert-plus');
var nopt = require('nopt');
var sprintf = require('extsprintf').sprintf;
var IMGAPI = require('sdc-clients/lib/imgapi');
var bunyan = require('bunyan');

var common = require('./common');
var errors = require('./errors');



//---- internal support stuff



//---- CLI object

function CLI(options) {
    assert.object(options, 'options');
    assert.string(options.name, 'options.name');
    assert.optionalString(options.description, 'options.description');
    assert.string(options.url, 'options.url');

    var self = this;
    this.name = options.name;
    this.description = options.description;
    this.url = options.url;

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
    this.handleArgv(argv, function (err, opts) {
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

        self.client = new IMGAPI({
            url: self.url,
            username: opts.username,
            password: opts.password
        });

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
CLI.prototype.handleArgv = function handleArgv(argv, callback) {
    var longOpts = {
        'help': Boolean,
        'version': Boolean,
        'debug': [Boolean, Array],
        'user': String
    };
    var shortOpts = {
        'h': ['--help'],
        'd': ['--debug'],
        'u': ['--user']
    };
    var opts = nopt(longOpts, shortOpts, argv, 2);

    // Die on unknown opts.
    var extraOpts = {};
    Object.keys(opts).forEach(function (o) { extraOpts[o] = true; });
    delete extraOpts.argv;
    Object.keys(longOpts).forEach(function (o) { delete extraOpts[o]; });
    extraOpts = Object.keys(extraOpts);
    if (extraOpts.length) {
        return callback(new errors.UnknownOptionError(
            '-' + extraOpts.join(', -')));
    }

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

}

CLI.prototype.printHelp = function printHelp(callback) {
    var self = this;
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
        '    -d, --debug         Debug logging. Multiple times for more.',
        '    -u, --user <user:password>',
        '                        Basic auth username and (optionally) password.',
        '                        If no password is given, you will be prompted.',
        '',
        'Commands:'
    ]);
    var template = '    %-18s  %s';
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
